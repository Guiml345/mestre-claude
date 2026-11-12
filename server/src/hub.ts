import http from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { APP_NAME } from "./config.js";
import { MesaError, errorCode, errorMessage } from "./errors.js";
import type { PlayerMessage, RequestOptions, TableState, WireMessage } from "./protocol.js";

export interface HubOptions {
  port: number;
  staticDir: string;
  version: string;
  extraOrigins?: string[];
  log?: (message: string) => void;
}

export interface HubInfo {
  port: number;
  pid: number;
  version: string;
  tables: Array<{ origin: string; connectedAt: string; active: boolean; state: TableState | null }>;
  controllers: number;
  lastRejected: { origin: string; at: string } | null;
}

interface Client {
  ws: WebSocket;
  /** "browser" veio com cabeçalho Origin (um navegador); "local" é um processo desta máquina. */
  kind: "browser" | "local";
  origin: string;
  role: "table" | "controller" | null;
  connectedAt: number;
  state: TableState | null;
  alive: boolean;
}

interface Pending {
  client: Client;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_WAIT_TABLE_MS = 4_000;
const HEARTBEAT_MS = 15_000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** O Owlbear busca o manifesto e os arquivos a partir do site dele, então precisam de CORS. */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Private-Network": "true",
};

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".localhost");
}

/** Só atende pedidos feitos para localhost, o que barra ataques de DNS rebinding. */
function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    return isLoopbackHost(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

/**
 * Decide quem pode abrir o WebSocket.
 * Navegadores sempre mandam Origin: só aceitamos páginas servidas de localhost
 * (a própria extensão). Sem Origin é um processo local (outra sessão do Claude).
 */
export function classifyOrigin(origin: string | undefined, extraOrigins: string[] = []): "local" | "browser" | "rejected" {
  if (origin === undefined) return "local";
  if (extraOrigins.includes(origin)) return "browser";
  try {
    return isLoopbackHost(new URL(origin).hostname) ? "browser" : "rejected";
  } catch {
    return "rejected";
  }
}

/**
 * Centro da ponte: serve a extensão por HTTP e conversa por WebSocket com a
 * mesa (extensão no Owlbear) e com outras sessões do Claude ("controllers").
 */
export class Hub {
  readonly pid = process.pid;
  port = 0;

  private readonly server: http.Server;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  private readonly clients = new Set<Client>();
  private readonly pending = new Map<string, Pending>();
  private readonly tableWaiters = new Set<() => void>();
  /** Mensagens digitadas pelos jogadores no painel, esperando o mestre ler. */
  private readonly inbox: PlayerMessage[] = [];
  private readonly seenMessages = new Set<string>();
  private readonly inboxWaiters = new Set<() => void>();
  private readonly log: (message: string) => void;
  private heartbeat: NodeJS.Timeout | null = null;
  private lastRejected: HubInfo["lastRejected"] = null;
  private seq = 0;
  private closed = false;

  private constructor(private readonly options: HubOptions) {
    this.log = options.log ?? (() => {});
    this.server = http.createServer((req, res) => {
      this.handleHttp(req, res).catch((err) => {
        this.log(`erro HTTP: ${errorMessage(err)}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    this.server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  /** Sobe a ponte. Rejeita com `code === "EADDRINUSE"` se a porta já estiver ocupada. */
  static listen(options: HubOptions): Promise<Hub> {
    return new Promise((resolve, reject) => {
      const hub = new Hub(options);
      hub.server.once("error", reject);
      hub.server.listen(options.port, "127.0.0.1", () => {
        hub.server.off("error", reject);
        hub.server.on("error", (err) => hub.log(`erro no servidor: ${errorMessage(err)}`));
        hub.port = (hub.server.address() as AddressInfo).port;
        hub.heartbeat = setInterval(() => hub.checkClients(), HEARTBEAT_MS);
        hub.heartbeat.unref();
        resolve(hub);
      });
    });
  }

  info(): HubInfo {
    const active = this.activeTable();
    const tables = [...this.clients].filter((client) => client.role === "table");
    return {
      port: this.port,
      pid: this.pid,
      version: this.options.version,
      tables: tables.map((client) => ({
        origin: client.origin,
        connectedAt: new Date(client.connectedAt).toISOString(),
        active: client === active,
        state: client.state,
      })),
      controllers: [...this.clients].filter((client) => client.role === "controller").length,
      lastRejected: this.lastRejected,
    };
  }

  /** Envia um pedido à mesa ativa e espera a resposta. */
  async request(method: string, params?: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (this.closed) throw new MesaError("HUB_GONE", "A ponte foi encerrada.");
    const table = await this.waitForTable(options.waitTableMs ?? DEFAULT_WAIT_TABLE_MS);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const id = `${this.pid}-${++this.seq}`;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MesaError("TIMEOUT", `A mesa não respondeu a "${method}" em ${timeoutMs / 1000}s.`));
      }, timeoutMs);
      this.pending.set(id, { client: table, resolve, reject, timer });
      this.send(table, { type: "request", id, method, params });
    });
  }

  /**
   * Entrega (e esvazia) as mensagens dos jogadores. Se não houver nenhuma,
   * espera até `waitMs` por uma e devolve lista vazia se ninguém escrever.
   */
  takeMessages(waitMs = 0): Promise<PlayerMessage[]> {
    if (this.inbox.length > 0 || waitMs <= 0 || this.closed) return Promise.resolve(this.inbox.splice(0));
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.inboxWaiters.delete(done);
        resolve(this.inbox.splice(0));
      };
      const timer = setTimeout(done, waitMs);
      this.inboxWaiters.add(done);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const waiter of [...this.inboxWaiters]) waiter();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new MesaError("HUB_GONE", "A ponte foi encerrada."));
      this.pending.delete(id);
    }
    for (const waiter of [...this.tableWaiters]) waiter();
    for (const client of this.clients) client.ws.terminate();
    this.clients.clear();
    this.wss.close();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private noTable(): MesaError {
    return new MesaError(
      "NO_TABLE",
      `Nenhuma mesa conectada. Abra a sala no Owlbear Rodeo como mestre, com a extensão "Mestre Claude" ativada (manifesto: http://localhost:${this.port}/manifest.json).`,
    );
  }

  /** Mesa que recebe os comandos: de preferência a do mestre, e a conectada por último. */
  private activeTable(): Client | null {
    let best: Client | null = null;
    for (const client of this.clients) {
      if (client.role !== "table" || client.ws.readyState !== WebSocket.OPEN) continue;
      if (!best) {
        best = client;
        continue;
      }
      const clientIsGm = client.state?.player.role === "GM";
      const bestIsGm = best.state?.player.role === "GM";
      if (clientIsGm !== bestIsGm) {
        if (clientIsGm) best = client;
      } else if (client.connectedAt >= best.connectedAt) {
        best = client;
      }
    }
    return best;
  }

  private waitForTable(waitMs: number): Promise<Client> {
    const current = this.activeTable();
    if (current) return Promise.resolve(current);
    if (waitMs <= 0) return Promise.reject(this.noTable());

    return new Promise<Client>((resolve, reject) => {
      const check = () => {
        if (this.closed) {
          finish();
          reject(new MesaError("HUB_GONE", "A ponte foi encerrada."));
          return;
        }
        const table = this.activeTable();
        if (table) {
          finish();
          resolve(table);
        }
      };
      const timer = setTimeout(() => {
        finish();
        reject(this.noTable());
      }, waitMs);
      const finish = () => {
        clearTimeout(timer);
        this.tableWaiters.delete(check);
      };
      this.tableWaiters.add(check);
    });
  }

  private send(client: Client, message: WireMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(message));
  }

  private checkClients(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }

  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/ws") return refuse("404 Not Found");
    if (!hostAllowed(req.headers.host)) return refuse("403 Forbidden");

    const origin = req.headers.origin;
    const kind = classifyOrigin(origin, this.options.extraOrigins);
    if (kind === "rejected") {
      this.lastRejected = { origin: origin ?? "", at: new Date().toISOString() };
      this.log(`conexão recusada: origem "${origin}" não é permitida`);
      return refuse("403 Forbidden");
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = {
        ws,
        kind,
        origin: origin ?? "processo local",
        role: null,
        connectedAt: Date.now(),
        state: null,
        alive: true,
      };
      this.clients.add(client);
      ws.on("pong", () => {
        client.alive = true;
      });
      ws.on("message", (data) => this.handleMessage(client, data));
      ws.on("error", (err) => this.log(`erro no WebSocket: ${errorMessage(err)}`));
      ws.on("close", () => this.handleClose(client));
    });
  }

  private handleClose(client: Client): void {
    this.clients.delete(client);
    if (client.role === "table") this.log(`mesa desconectada (${client.origin})`);
    for (const [id, pending] of this.pending) {
      if (pending.client !== client) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new MesaError("NO_TABLE", "A mesa se desconectou antes de responder."));
    }
  }

  private handleMessage(client: Client, data: RawData): void {
    let message: WireMessage;
    try {
      message = JSON.parse(data.toString()) as WireMessage;
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;

    switch (message.type) {
      case "hello": {
        if (message.role === "controller" && client.kind !== "local") {
          client.ws.close(1008, "controller precisa ser um processo local");
          return;
        }
        client.role = message.role;
        if (message.role === "table") {
          client.state = message.state ?? null;
          const who = client.state ? `${client.state.player.name} (${client.state.player.role})` : "sem estado";
          this.log(`mesa conectada: ${who}, origem ${client.origin}`);
        }
        this.send(client, { type: "welcome", name: APP_NAME, version: this.options.version, pid: this.pid });
        if (message.role === "table") for (const waiter of [...this.tableWaiters]) waiter();
        return;
      }
      case "event": {
        if (client.role !== "table") return;
        if (message.name === "state") {
          client.state = message.data;
        } else if (message.name === "message") {
          const text = typeof message.data?.text === "string" ? message.data.text.trim().slice(0, 500) : "";
          if (!text) return;
          const id = typeof message.data.id === "string" ? message.data.id.slice(0, 80) : `${Date.now()}`;
          // Duas abas da mesa podem repassar a mesma fala: só a primeira conta.
          if (this.seenMessages.has(id)) return;
          this.seenMessages.add(id);
          if (this.seenMessages.size > 500) this.seenMessages.clear();
          // O autor vem da extensão do mestre, que o tira da lista de jogadores do Owlbear.
          const author = typeof message.data.author === "string" && message.data.author.trim() ? message.data.author.trim().slice(0, 60) : (client.state?.player.name ?? "Jogador");
          this.inbox.push({ id, author, text, at: new Date().toISOString() });
          if (this.inbox.length > 100) this.inbox.shift();
          for (const waiter of [...this.inboxWaiters]) waiter();
        }
        return;
      }
      case "response": {
        const pending = this.pending.get(message.id);
        if (!pending || pending.client !== client) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new MesaError(message.error?.code ?? "TABLE_ERROR", message.error?.message ?? "Erro na mesa."));
        return;
      }
      case "request": {
        if (client.role !== "controller") return;
        const { id, method, params, options } = message;
        const work: Promise<unknown> =
          method === "$info"
            ? Promise.resolve(this.info())
            : method === "$mensagens"
              ? this.takeMessages(Number((params as { waitMs?: unknown } | undefined)?.waitMs) || 0)
              : this.request(method, params, options);
        work.then(
          (result) => this.send(client, { type: "response", id, ok: true, result }),
          (err) =>
            this.send(client, {
              type: "response",
              id,
              ok: false,
              error: { code: errorCode(err), message: errorMessage(err) },
            }),
        );
        return;
      }
    }
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD, OPTIONS" }).end();
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }

    if (pathname === "/status") {
      // Sem CORS de propósito: outros sites não devem conseguir ler isto.
      const body = JSON.stringify({
        ok: true,
        name: APP_NAME,
        version: this.options.version,
        mesas: this.info().tables.length,
      });
      res.writeHead(200, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }

    const root = path.resolve(this.options.staticDir);
    // O manifesto usa /mestre-claude/... (o caminho do GitHub Pages); aqui a extensão fica na raiz.
    const unprefixed = pathname === "/mestre-claude" ? "/" : pathname.startsWith("/mestre-claude/") ? pathname.slice("/mestre-claude".length) : pathname;
    const relative = unprefixed.endsWith("/") ? `${unprefixed}index.html` : unprefixed;
    const file = path.resolve(root, `.${relative}`);
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403, CORS).end();
      return;
    }

    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      const built = await readFile(path.join(root, "manifest.json")).then(
        () => true,
        () => false,
      );
      res.writeHead(built ? 404 : 503, { ...CORS, "Content-Type": "text/plain; charset=utf-8" });
      res.end(built ? "Não encontrado." : "A extensão ainda não foi compilada. Rode `npm run build` na pasta do projeto.");
      return;
    }

    res.writeHead(200, {
      ...CORS,
      "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }
}
