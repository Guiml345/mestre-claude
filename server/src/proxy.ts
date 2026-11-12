import { WebSocket } from "ws";
import { APP_NAME } from "./config.js";
import { MesaError, errorMessage } from "./errors.js";
import type { RequestOptions, WireMessage } from "./protocol.js";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const HANDSHAKE_MS = 4_000;
/** Folga sobre os tempos da ponte principal, para o erro dela chegar antes do nosso. */
const EXTRA_MS = 2_000;

/**
 * Cliente da ponte de outra sessão do Claude.
 * Quando a porta já está ocupada por outra sessão, esta fala com a mesa através dela.
 */
export class ProxyClient {
  private readonly pending = new Map<string, Pending>();
  private readonly closeListeners = new Set<() => void>();
  private seq = 0;
  private open = true;

  private constructor(private readonly ws: WebSocket) {}

  static connect(port: number): Promise<ProxyClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { handshakeTimeout: HANDSHAKE_MS });
      const client = new ProxyClient(ws);
      let settled = false;

      const fail = (reason: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.terminate();
        reject(new MesaError("PORT_BUSY", reason));
      };
      const timer = setTimeout(() => fail("quem está na porta não respondeu como Mestre Claude"), HANDSHAKE_MS);

      ws.on("open", () => {
        const hello: WireMessage = { type: "hello", role: "controller", protocol: 1, pid: process.pid };
        ws.send(JSON.stringify(hello));
      });
      ws.on("message", (data) => {
        let message: WireMessage;
        try {
          message = JSON.parse(data.toString()) as WireMessage;
        } catch {
          return;
        }
        if (message.type === "welcome") {
          if (message.name !== APP_NAME) return fail("quem está na porta não é o Mestre Claude");
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(client);
        } else if (message.type === "response") {
          client.handleResponse(message);
        }
      });
      ws.on("error", (err) => fail(errorMessage(err)));
      ws.on("close", () => {
        fail("a conexão fechou antes de completar");
        client.handleClose();
      });
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  request(method: string, params?: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (!this.open) return Promise.reject(new MesaError("HUB_GONE", "A ponte da outra sessão caiu."));
    const id = `${process.pid}-p${++this.seq}`;
    const limit = (options.timeoutMs ?? 10_000) + (options.waitTableMs ?? 4_000) + EXTRA_MS;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MesaError("TIMEOUT", `A ponte não respondeu a "${method}" em ${limit / 1000}s.`));
      }, limit);
      this.pending.set(id, { resolve, reject, timer });
      const message: WireMessage = { type: "request", id, method, params, options };
      this.ws.send(JSON.stringify(message));
    });
  }

  close(): void {
    this.ws.terminate();
    this.handleClose();
  }

  private handleResponse(message: Extract<WireMessage, { type: "response" }>): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new MesaError(message.error?.code ?? "INTERNAL", message.error?.message ?? "Erro na ponte."));
  }

  private handleClose(): void {
    if (!this.open) return;
    this.open = false;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new MesaError("HUB_GONE", "A ponte da outra sessão caiu no meio do pedido."));
    }
    for (const listener of this.closeListeners) listener();
  }
}
