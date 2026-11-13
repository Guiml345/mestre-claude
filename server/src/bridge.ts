import { MesaError, errorCode, errorMessage } from "./errors.js";
import { Hub, type HubInfo, type HubOptions } from "./hub.js";
import type { PlayerMessage, RequestOptions, TableMethod, TableMethods } from "./protocol.js";
import { ProxyClient } from "./proxy.js";

export type BridgeInfo = HubInfo & {
  /** "hub": esta sessão é a ponte. "proxy": usa a ponte de outra sessão do Claude. */
  mode: "hub" | "proxy";
};

/** O que as ações precisam para falar com a mesa. */
export interface TableLink {
  call<M extends TableMethod>(
    method: M,
    params?: TableMethods[M]["params"],
    options?: RequestOptions,
  ): Promise<TableMethods[M]["result"]>;
  info(): Promise<BridgeInfo>;
  /** Mensagens que os jogadores digitaram na mesa; espera até `waitMs` se não houver nenhuma. */
  messages(waitMs: number, listener?: string): Promise<PlayerMessage[] | null>;
}

/**
 * Ligação com a mesa. Tenta ser a ponte (abrir a porta); se outra sessão do
 * Claude já for a ponte, conversa através dela. Se aquela sessão fechar,
 * assume o lugar sozinha.
 */
export class Bridge implements TableLink {
  private hub: Hub | null = null;
  private proxy: ProxyClient | null = null;
  private ensuring: Promise<void> | null = null;
  private recoverTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly log: (message: string) => void;

  constructor(private readonly options: HubOptions) {
    this.log = options.log ?? (() => {});
  }

  get mode(): "hub" | "proxy" | "offline" {
    return this.hub ? "hub" : this.proxy ? "proxy" : "offline";
  }

  /** Garante que há uma ponte no ar (a nossa ou a de outra sessão). */
  ensure(): Promise<void> {
    if (this.closed) return Promise.reject(new MesaError("HUB_GONE", "A ponte foi encerrada."));
    if (this.hub || this.proxy) return Promise.resolve();
    this.ensuring ??= this.connect().finally(() => {
      this.ensuring = null;
    });
    return this.ensuring;
  }

  async call<M extends TableMethod>(
    method: M,
    params?: TableMethods[M]["params"],
    options?: RequestOptions,
  ): Promise<TableMethods[M]["result"]> {
    return (await this.send(method, params, options)) as TableMethods[M]["result"];
  }

  async info(): Promise<BridgeInfo> {
    await this.ensure();
    if (this.hub) return { ...this.hub.info(), mode: "hub" };
    const info = (await this.send("$info")) as HubInfo;
    return { ...info, mode: "proxy" };
  }

  /** `null` quer dizer que outro escutador assumiu: quem chamou deve parar. */
  async messages(waitMs: number, listener?: string): Promise<PlayerMessage[] | null> {
    await this.ensure();
    if (this.hub) return this.hub.takeMessages(waitMs, listener);
    if (!this.proxy) return [];
    try {
      const result = await this.proxy.request("$mensagens", { waitMs, listener }, { timeoutMs: waitMs + 1_000, waitTableMs: 0 });
      return result === null ? null : Array.isArray(result) ? (result as PlayerMessage[]) : [];
    } catch (err) {
      // A outra sessão fechou enquanto esperávamos: quem chamou tenta de novo.
      if (errorCode(err) === "HUB_GONE") return [];
      throw err;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.recoverTimer) clearTimeout(this.recoverTimer);
    // Solta a referência antes de fechar, para o aviso de "ponte caiu" não disparar.
    const proxy = this.proxy;
    this.proxy = null;
    proxy?.close();
    const hub = this.hub;
    this.hub = null;
    await hub?.close();
  }

  private async send(method: string, params?: unknown, options?: RequestOptions): Promise<unknown> {
    await this.ensure();
    try {
      return await this.dispatch(method, params, options);
    } catch (err) {
      // A outra sessão caiu no meio do pedido: assume a ponte e tenta uma vez de novo.
      if (errorCode(err) !== "HUB_GONE" || this.closed) throw err;
      await this.ensure();
      return this.dispatch(method, params, options);
    }
  }

  /** Manda o pedido por onde der: pela nossa ponte ou pela da outra sessão. */
  private async dispatch(method: string, params?: unknown, options?: RequestOptions): Promise<unknown> {
    const target = this.hub ?? this.proxy;
    if (!target) throw new MesaError("HUB_GONE", "A ponte não está disponível.");
    return target.request(method, params, options);
  }

  private async connect(): Promise<void> {
    if (await this.tryListen()) return;
    try {
      const proxy = await ProxyClient.connect(this.options.port);
      proxy.onClose(() => {
        if (this.proxy !== proxy) return;
        this.proxy = null;
        this.log("a ponte da outra sessão caiu; tentando assumir");
        this.recover(0);
      });
      this.proxy = proxy;
      this.log(`usando a ponte de outra sessão do Claude na porta ${this.options.port}`);
    } catch (err) {
      // A outra sessão pode ter fechado justo agora: tenta a porta mais uma vez.
      if (await this.tryListen()) return;
      throw new MesaError(
        "PORT_BUSY",
        `A porta ${this.options.port} está em uso por outro programa (${errorMessage(err)}). Feche esse programa ou defina MESA_RPG_PORT com outra porta.`,
      );
    }
  }

  /** Verdadeiro se conseguiu abrir a porta; falso se ela já está ocupada. */
  private async tryListen(): Promise<boolean> {
    try {
      this.hub = await Hub.listen(this.options);
      this.log(`ponte no ar em http://localhost:${this.hub.port}`);
      return true;
    } catch (err) {
      if (errorCode(err) === "EADDRINUSE") return false;
      throw new MesaError("INTERNAL", `Não consegui abrir a porta ${this.options.port}: ${errorMessage(err)}`);
    }
  }

  private recover(attempt: number): void {
    if (this.closed) return;
    const delay = Math.min(150 * 2 ** attempt, 5_000);
    this.recoverTimer = setTimeout(() => {
      this.ensure().catch(() => this.recover(attempt + 1));
    }, delay);
  }
}
