/**
 * Tipos compartilhados entre o servidor (Node) e a extensão (navegador).
 * Só tipos: este arquivo não pode ter código de execução, porque a extensão
 * o importa com `import type`.
 */

export interface Vec2 {
  x: number;
  y: number;
}

/** Item da cena do Owlbear, já reduzido ao que o servidor precisa. */
export interface RawItem {
  id: string;
  type: string;
  /** Nome do item (normalmente o nome da imagem usada). */
  name: string;
  layer: string;
  position: Vec2;
  rotation: number;
  scale: Vec2;
  visible: boolean;
  locked: boolean;
  attachedTo?: string;
  /** Rótulo escrito embaixo do token. Só existe em imagens. */
  text?: string;
  image?: { width: number; height: number; url: string };
  /** Grade da própria imagem: quantos pixels dela valem uma casa e onde fica a âncora. */
  grid?: { dpi: number; offset: Vec2 };
}

export interface GridInfo {
  /** Pixels da cena por casa. */
  dpi: number;
  /** SQUARE, HEX_VERTICAL, HEX_HORIZONTAL, DIMETRIC ou ISOMETRIC. */
  type: string;
  /** CHEBYSHEV, ALTERNATING, EUCLIDEAN ou MANHATTAN. */
  measurement: string;
  scale: { raw: string; multiplier: number; unit: string; digits: number };
}

export interface PlayerInfo {
  id: string;
  name: string;
  role: "GM" | "PLAYER";
}

export interface TableState {
  extensionVersion: string;
  roomId: string;
  sceneReady: boolean;
  player: PlayerInfo;
  /** Os outros jogadores conectados na sala. */
  party: PlayerInfo[];
  grid: GridInfo | null;
}

export interface ItemUpdate {
  id: string;
  position?: Vec2;
  visible?: boolean;
  locked?: boolean;
  /** Novo rótulo do token (só imagens). */
  text?: string;
}

export type AnnounceVariant = "DEFAULT" | "INFO" | "SUCCESS" | "WARNING" | "ERROR";

export interface Announcement {
  id: string;
  text: string;
  variant: AnnounceVariant;
  kind: "rolagem" | "narracao" | "aviso" | "jogador";
  /** Data e hora em ISO 8601. */
  at: string;
}

/** Texto que um jogador digitou no painel da extensão, para o mestre ler. */
export interface PlayerMessage {
  id: string;
  /** Nome do jogador, tirado do estado da mesa (não do que a página afirma). */
  author: string;
  text: string;
  at: string;
}

/** Chamadas que o servidor pode fazer à extensão. */
export interface TableMethods {
  ping: { params: undefined; result: { pong: true } };
  getState: { params: undefined; result: TableState };
  getItems: { params: { layers?: string[] } | undefined; result: RawItem[] };
  updateItems: { params: { updates: ItemUpdate[] }; result: { updated: number } };
  announce: { params: Announcement; result: { delivered: true } };
  /** Cria cópias de um token (mesma imagem, tamanho e camada) nas posições dadas. */
  cloneItems: { params: { sourceId: string; copies: CloneCopy[] }; result: { ids: string[] } };
  /** Cria tokens a partir de uma imagem publicada (catálogo de tokens). */
  addImages: { params: { url: string; size: number; layer?: "CHARACTER" | "PROP"; tokens: Array<{ position: Vec2; text: string; name: string; visible?: boolean }> }; result: { ids: string[] } };
  deleteItems: { params: { ids: string[] }; result: { deleted: number } };
  getCombat: { params: undefined; result: Combat | null };
  setCombat: { params: { combat: Combat | null }; result: { saved: true } };
  getConfig: { params: undefined; result: TableConfig };
  setConfig: { params: Partial<TableConfig>; result: TableConfig };
  getInventory: { params: undefined; result: Inventory };
  setInventory: { params: { inventory: Inventory }; result: { saved: true } };
  /** Leva a câmera de quem deixou "Câmera segue a ação" ligada até a área (em pixels da cena). */
  focus: { params: { x: number; y: number; w: number; h: number }; result: { sent: true } };
  /** Troca as etiquetas de condição presas ao token (lista vazia tira todas). */
  setMarkers: { params: { tokenId: string; conditions: string[] }; result: { markers: number } };
  fogState: { params: undefined; result: FogState };
  fogSetFilled: { params: { filled: boolean }; result: { filled: boolean } };
  fogAddRects: { params: { rects: Array<{ x: number; y: number; w: number; h: number }>; cut: boolean; name: string }; result: { ids: string[] } };
  fogSetCut: { params: { ids: string[]; cut: boolean }; result: { updated: number } };
  fogDelete: { params: { ids?: string[] }; result: { deleted: number } };
}

export type CombatSide = "jogador" | "aliado" | "inimigo";

export interface Combatant {
  id: string;
  nome: string;
  iniciativa: number;
  pv: number;
  pvMax: number;
  ca?: number;
  lado: CombatSide;
  /** Rótulo ou nome do token na mesa, se houver. */
  token?: string;
  /** Nome do jogador no Owlbear que controla este personagem (só ele digita na vez dele). */
  jogador?: string;
  condicoes: string[];
}

/** Combate em andamento. Fica guardado nos dados da sala do Owlbear e aparece no painel. */
export interface Combat {
  rodada: number;
  /** Índice de quem está na vez em `combatentes`. */
  vez: number;
  combatentes: Combatant[];
}

export interface CloneCopy {
  position: Vec2;
  /** Rótulo do token novo. */
  text: string;
  visible?: boolean;
}

export type TableMethod = keyof TableMethods;

export interface RequestOptions {
  /** Tempo máximo esperando a resposta da mesa. */
  timeoutMs?: number;
  /** Tempo máximo esperando uma mesa se conectar antes de desistir. */
  waitTableMs?: number;
}

/** Mensagens que trafegam no WebSocket da ponte. */
export type WireMessage =
  | { type: "hello"; role: "table"; protocol: 1; state: TableState | null }
  | { type: "hello"; role: "controller"; protocol: 1; pid: number }
  | { type: "welcome"; name: string; version: string; pid: number }
  | { type: "request"; id: string; method: string; params?: unknown; options?: RequestOptions }
  | { type: "response"; id: string; ok: true; result?: unknown }
  | { type: "response"; id: string; ok: false; error: { code: string; message: string } }
  | { type: "event"; name: "state"; data: TableState }
  | { type: "event"; name: "message"; data: { id: string; text: string; author?: string } };

/** Opções que o mestre liga e desliga no painel. Ficam nos dados da sala. */
export type NarrationStyle = "curta" | "media" | "detalhada";
export type Difficulty = "gentil" | "padrao" | "mortal";

export interface TableConfig {
  /** Névoa de guerra ligada (o Claude cobre e revela o mapa). */
  nevoa: boolean;
  /** Mestre em pausa: as falas ficam guardadas e o Claude não responde. */
  pausado: boolean;
  /** Tamanho da narração. */
  narracao: NarrationStyle;
  /** O quanto os monstros pegam pesado. */
  dificuldade: Difficulty;
  /** Explicar cada regra quando aparece (bom para iniciantes). */
  regras: boolean;
}

export interface FogArea {
  id: string;
  name: string;
  visible: boolean;
  /** Criada pelo Mestre Claude (as outras são do mestre humano e não são tocadas). */
  ours: boolean;
  raw?: unknown;
}

export interface FogState {
  filled: boolean;
  areas: FogArea[];
}

export interface InventoryItem {
  id: string;
  nome: string;
  qtd: number;
  nota?: string;
}

export interface Coins {
  /** Peças de ouro, prata e cobre. */
  po: number;
  pp: number;
  pc: number;
}

export interface InventoryCharacter {
  id: string;
  nome: string;
  /** Nome no Owlbear de quem controla (só essa pessoa e o mestre editam pelo painel). */
  jogador?: string;
  moedas: Coins;
  itens: InventoryItem[];
}

/** Inventário de todos, nos dados da sala do Owlbear. Os jogadores editam pelo painel, sem passar pelo Claude. */
export interface Inventory {
  personagens: InventoryCharacter[];
}
