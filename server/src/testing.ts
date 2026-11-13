/** Mesa de mentira, usada só nos testes: faz o papel da extensão do Owlbear. */
import { WebSocket } from "ws";
import type { BridgeInfo, TableLink } from "./bridge.js";
import { MesaError, errorCode, errorMessage } from "./errors.js";
import type { Announcement, Combat, FogArea, Inventory, GridInfo, ItemUpdate, PlayerMessage, RawItem, TableState, WireMessage } from "./protocol.js";

export const SQUARE_GRID: GridInfo = {
  dpi: 150,
  type: "SQUARE",
  measurement: "CHEBYSHEV",
  scale: { raw: "5ft", multiplier: 5, unit: "ft", digits: 0 },
};

/** Token de 1 casa (imagem 300×300, 300 px por casa, âncora no centro) na casa dada. */
export function token(id: string, label: string, col: number, row: number, extra: Partial<RawItem> = {}): RawItem {
  return {
    id,
    type: "IMAGE",
    name: label,
    layer: "CHARACTER",
    position: { x: (col + 0.5) * SQUARE_GRID.dpi, y: (row + 0.5) * SQUARE_GRID.dpi },
    rotation: 0,
    scale: { x: 1, y: 1 },
    visible: true,
    locked: false,
    text: label,
    image: { width: 300, height: 300, url: "https://example.invalid/token.png" },
    grid: { dpi: 300, offset: { x: 150, y: 150 } },
    ...extra,
  };
}

/** Mapa com a âncora no canto superior esquerdo, cobrindo `cols` × `rows` casas a partir da origem. */
export function mapItem(id: string, name: string, cols: number, rows: number): RawItem {
  return {
    id,
    type: "IMAGE",
    name,
    layer: "MAP",
    position: { x: 0, y: 0 },
    rotation: 0,
    scale: { x: 1, y: 1 },
    visible: true,
    locked: true,
    text: "",
    image: { width: cols * 70, height: rows * 70, url: "https://example.invalid/mapa.png" },
    grid: { dpi: 70, offset: { x: 0, y: 0 } },
  };
}

export function sampleState(overrides: Partial<TableState> = {}): TableState {
  return {
    extensionVersion: "teste",
    roomId: "sala-teste",
    sceneReady: true,
    player: { id: "gm-1", name: "Mestre", role: "GM" },
    party: [{ id: "p-1", name: "Leo", role: "PLAYER" }],
    grid: structuredClone(SQUARE_GRID),
    ...overrides,
  };
}

export class FakeTable {
  items: RawItem[];
  state: TableState;
  announcements: Announcement[] = [];
  requests: string[] = [];
  /** Finge aceitar updateItems mas não muda nada (como o Owlbear faria sem permissão). */
  ignoreUpdates = false;
  /** Mensagens de jogadores para a ligação em memória entregar. */
  outbox: PlayerMessage[] = [];
  combat: Combat | null = null;
  fogEnabled = true;
  paused = false;
  inventory: Inventory = { personagens: [] };
  focused: Array<{ x: number; y: number; w: number; h: number }> = [];
  fogFilled = false;
  fog: FogArea[] = [];
  private ws: WebSocket | null = null;

  /** Manda pela ponte um texto como se um jogador tivesse digitado no painel. */
  say(text: string, id = `m-${Date.now()}-${Math.random()}`): void {
    this.send({ type: "event", name: "message", data: { id, text } });
  }

  constructor(items: RawItem[] = [], state: TableState = sampleState()) {
    this.items = items;
    this.state = state;
  }

  handle(method: string, params: unknown): unknown {
    this.requests.push(method);
    switch (method) {
      case "ping":
        return { pong: true };
      case "getState":
        return structuredClone(this.state);
      case "getItems": {
        if (!this.state.sceneReady) throw new MesaError("NO_SCENE", "Nenhuma cena aberta no Owlbear Rodeo.");
        const layers = (params as { layers?: string[] } | undefined)?.layers;
        return structuredClone(layers ? this.items.filter((item) => layers.includes(item.layer)) : this.items);
      }
      case "updateItems": {
        if (!this.state.sceneReady) throw new MesaError("NO_SCENE", "Nenhuma cena aberta no Owlbear Rodeo.");
        const { updates } = params as { updates: ItemUpdate[] };
        let updated = 0;
        for (const update of updates) {
          const item = this.items.find((candidate) => candidate.id === update.id);
          if (!item) continue;
          updated++;
          if (this.ignoreUpdates) continue;
          if (update.position) item.position = { ...update.position };
          if (update.visible !== undefined) item.visible = update.visible;
          if (update.locked !== undefined) item.locked = update.locked;
          if (update.text !== undefined) item.text = update.text;
        }
        return { updated };
      }
      case "cloneItems": {
        const { sourceId, copies } = params as { sourceId: string; copies: Array<{ position: { x: number; y: number }; text: string; visible?: boolean }> };
        const source = this.items.find((item) => item.id === sourceId);
        if (!source) throw new MesaError("TOKEN_NOT_FOUND", "O token modelo não está mais na cena.");
        const ids = copies.map((copy, index) => {
          const id = `clone-${this.items.length}-${index}`;
          this.items.push({ ...structuredClone(source), id, position: { ...copy.position }, text: copy.text, visible: copy.visible ?? source.visible, locked: false });
          return id;
        });
        return { ids };
      }
      case "deleteItems": {
        const { ids } = params as { ids: string[] };
        const before = this.items.length;
        if (!this.ignoreUpdates) this.items = this.items.filter((item) => !ids.includes(item.id));
        return { deleted: before - this.items.length };
      }
      case "focus":
        this.focused.push(params as { x: number; y: number; w: number; h: number });
        return { sent: true };
      case "setMarkers":
        return { markers: 1 };
      case "getConfig":
        return { nevoa: this.fogEnabled, pausado: this.paused, narracao: "media", dificuldade: "padrao", regras: true };
      case "fogState":
        return { filled: this.fogFilled, areas: structuredClone(this.fog) };
      case "getInventory":
        return structuredClone(this.inventory);
      case "setInventory":
        this.inventory = structuredClone((params as { inventory: Inventory }).inventory);
        return { saved: true };
      case "addImages": {
        const { tokens, size } = params as { tokens: Array<{ position: { x: number; y: number }; text: string; name: string; visible?: boolean }>; size: number };
        const ids = tokens.map((t, i) => {
          const id = `img-${this.items.length}-${i}`;
          this.items.push({ id, type: "IMAGE", name: t.name, layer: "CHARACTER", position: { ...t.position }, rotation: 0, scale: { x: 1, y: 1 }, visible: t.visible ?? true, locked: false, text: t.text, image: { width: size, height: size, url: "" }, grid: { dpi: size, offset: { x: size / 2, y: size / 2 } } });
          return id;
        });
        return { ids };
      }
      case "setConfig":
        this.fogEnabled = (params as { nevoa?: boolean }).nevoa ?? this.fogEnabled;
        this.paused = (params as { pausado?: boolean }).pausado ?? this.paused;
        return { nevoa: this.fogEnabled, pausado: this.paused, narracao: "media", dificuldade: "padrao", regras: true };
      case "fogSetFilled":
        this.fogFilled = (params as { filled: boolean }).filled;
        return { filled: this.fogFilled };
      case "fogAddRects": {
        const { name, cut } = params as { name: string; cut: boolean };
        const id = `fog-${this.fog.length}`;
        this.fog.push({ id, name, visible: !cut, ours: true });
        return { ids: [id] };
      }
      case "fogSetCut": {
        const { ids, cut } = params as { ids: string[]; cut: boolean };
        for (const area of this.fog) if (ids.includes(area.id) && area.ours) area.visible = !cut;
        return { updated: ids.length };
      }
      case "fogDelete": {
        const ids = (params as { ids?: string[] }).ids;
        const before = this.fog.length;
        this.fog = this.fog.filter((area) => !area.ours || (ids && !ids.includes(area.id)));
        return { deleted: before - this.fog.length };
      }
      case "getCombat":
        return structuredClone(this.combat);
      case "setCombat":
        this.combat = structuredClone((params as { combat: Combat | null }).combat);
        return { saved: true };
      case "announce":
        this.announcements.push(params as Announcement);
        return { delivered: true };
      default:
        throw new MesaError("BAD_REQUEST", `Método desconhecido: ${method}`);
    }
  }

  /** Conecta na ponte como a extensão faria. Resolve quando a ponte dá as boas-vindas. */
  connect(port: number, origin: string | null = `http://localhost:${port}`): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { origin } : {});
      this.ws = ws;
      ws.on("open", () => this.send({ type: "hello", role: "table", protocol: 1, state: this.state }));
      ws.on("error", reject);
      ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.on("message", (data) => {
        const message = JSON.parse(data.toString()) as WireMessage;
        if (message.type === "welcome") {
          resolve();
        } else if (message.type === "request") {
          try {
            this.send({ type: "response", id: message.id, ok: true, result: this.handle(message.method, message.params) });
          } catch (err) {
            this.send({
              type: "response",
              id: message.id,
              ok: false,
              error: { code: errorCode(err), message: errorMessage(err) },
            });
          }
        }
      });
    });
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close(): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      ws.once("close", () => resolve());
      ws.terminate();
    });
  }

  private send(message: WireMessage): void {
    this.ws?.send(JSON.stringify(message));
  }
}

/** Ligação direta com uma mesa de mentira, sem rede. `null` simula mesa desconectada. */
export function memoryLink(table: FakeTable | null, port = 7420): TableLink {
  return {
    async call(method, params) {
      if (!table) throw new MesaError("NO_TABLE", "Nenhuma mesa conectada.");
      return table.handle(method, params) as never;
    },
    async messages() {
      return table ? table.outbox.splice(0) : [];
    },
    async info(): Promise<BridgeInfo> {
      return {
        mode: "hub",
        port,
        pid: 1,
        version: "teste",
        controllers: 0,
        lastRejected: null,
        tables: table
          ? [{ origin: "teste", connectedAt: new Date(0).toISOString(), active: true, state: table.state }]
          : [],
      };
    },
  };
}
