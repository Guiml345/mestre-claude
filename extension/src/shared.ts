import type { AnnounceVariant, Announcement, Combat, Inventory, TableConfig } from "../../server/src/protocol";

export const EXT_ID = "mestre-claude";
export const VERSION = "0.1.0";

/** Canais de mensagens do Owlbear usados pela extensão. */
export const CH_ANNOUNCE = `${EXT_ID}/anuncio`;
export const CH_STATUS = `${EXT_ID}/status`;
export const CH_STATUS_REQUEST = `${EXT_ID}/status-pedido`;
/** Chave do combate nos dados da sala do Owlbear (visível para todos na sala). */
export const COMBAT_KEY = `${EXT_ID}/combate`;
/** Opções do mestre (ex.: névoa automática), nos dados da sala. */
export const CONFIG_KEY = `${EXT_ID}/config`;

export function parseConfig(data: unknown): TableConfig {
  const raw = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  return {
    nevoa: raw.nevoa === true,
    pausado: raw.pausado === true,
    narracao: raw.narracao === "curta" || raw.narracao === "detalhada" ? raw.narracao : "media",
    dificuldade: raw.dificuldade === "gentil" || raw.dificuldade === "mortal" ? raw.dificuldade : "padrao",
    regras: raw.regras !== false,
  };
}
/** O painel avisa a página de segundo plano que o jogador digitou algo. */
export const CH_SAY = `${EXT_ID}/fala`;
/** Mesmo aviso, pelo armazenamento local, caso o canal não chegue. */
export const SAY_KEY = `${EXT_ID}/fala`;
/** O navegador ligado ao Claude avisa a todos que está no ar (e para de avisar quando cai). */
export const CH_HOST = `${EXT_ID}/anfitriao`;
/** O navegador ligado ao Claude recusa uma fala fora da vez. */
export const CH_SAY_REJECT = `${EXT_ID}/fala-recusada`;
/** Pedido para a câmera de cada um ir até uma área. */
export const CH_CAMERA = `${EXT_ID}/camera`;
/** Este navegador já se conectou ao Claude antes (então tenta de novo mesmo sem ser mestre). */
export const HOST_KEY = `${EXT_ID}/anfitriao`;
/** Preferência de cada pessoa: a câmera segue a ação. */
export const CAMERA_KEY = `${EXT_ID}/camera`;
/** Preferência de cada pessoa: avisar com som e abrir o painel quando for a vez dela. */
export const TURN_ALERT_KEY = `${EXT_ID}/aviso-vez`;

export function readFlag(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "1";
  } catch {
    return fallback;
  }
}

export function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Sem armazenamento: a preferência só não fica lembrada.
  }
}

/**
 * Quem pode digitar agora. Fora de combate, todos. Em combate, só quem controla
 * o personagem da vez; se a ficha do combate não diz quem controla, qualquer jogador.
 */
export function turnGate(combat: Combat | null, playerName: string): { allowed: boolean; reason: string } {
  const current = combat?.combatentes[combat.vez];
  if (!combat || !current) return { allowed: true, reason: "" };
  if (current.lado === "inimigo") return { allowed: false, reason: `Vez de ${current.nome}. Aguarde.` };
  if (!current.jogador) return { allowed: true, reason: "" };
  const mine = current.jogador.trim().toLowerCase() === playerName.trim().toLowerCase();
  return mine ? { allowed: true, reason: "" } : { allowed: false, reason: `Vez de ${current.nome} (${current.jogador}). Aguarde.` };
}

/** O que o painel manda quando o jogador digita uma ação. */
export interface Say {
  id: string;
  text: string;
}

export function parseSay(data: unknown): Say | null {
  if (!data || typeof data !== "object") return null;
  const raw = data as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id || raw.id.length > 80) return null;
  if (typeof raw.text !== "string" || !raw.text.trim()) return null;
  return { id: raw.id, text: raw.text.trim().slice(0, 500) };
}

/** Porta padrão da ponte do Claude (igual à do servidor). */
const DEFAULT_BRIDGE_PORT = 7420;
const MAX_LOG = 60;
const MAX_TEXT = 500;
const VARIANTS: AnnounceVariant[] = ["DEFAULT", "INFO", "SUCCESS", "WARNING", "ERROR"];
const KINDS: Announcement["kind"][] = ["rolagem", "narracao", "aviso", "jogador"];

export type BridgeState = "conectado" | "procurando" | "jogador";

export interface BridgeStatus {
  state: BridgeState;
  url: string;
}

/**
 * Endereço da ponte. Em produção a extensão é servida pela própria ponte,
 * então é o mesmo endereço da página; no `vite dev`, é a porta padrão.
 */
export function bridgeUrl(): string {
  // Servida pela própria ponte (localhost): o mesmo endereço da página.
  // Servida de fora (ex.: GitHub Pages): a ponte roda no computador de quem tem o Claude.
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) || location.hostname.endsWith(".localhost");
  if (import.meta.env.DEV || !local) return `ws://localhost:${DEFAULT_BRIDGE_PORT}/ws`;
  return `ws://${location.host}/ws`;
}

/**
 * Valida um aviso antes de mostrar. Qualquer jogador da sala pode mandar
 * mensagens neste canal, então nada aqui é confiável: só passa texto puro, cortado.
 */
export function parseAnnouncement(data: unknown): Announcement | null {
  if (!data || typeof data !== "object") return null;
  const raw = data as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id || raw.id.length > 80) return null;
  if (typeof raw.text !== "string" || !raw.text.trim()) return null;
  const when = typeof raw.at === "string" && !Number.isNaN(Date.parse(raw.at)) ? raw.at : new Date().toISOString();
  return {
    id: raw.id,
    text: raw.text.trim().slice(0, MAX_TEXT),
    variant: VARIANTS.includes(raw.variant as AnnounceVariant) ? (raw.variant as AnnounceVariant) : "DEFAULT",
    kind: KINDS.includes(raw.kind as Announcement["kind"]) ? (raw.kind as Announcement["kind"]) : "aviso",
    at: when,
  };
}

function logKey(roomId: string): string {
  return `${EXT_ID}/log/${roomId}`;
}

const STATUS_KEY = `${EXT_ID}/status`;

// O armazenamento local pode estar bloqueado pelo navegador (a extensão roda
// num iframe de terceiros), então toda leitura e escrita é tolerante a falha.

export function loadLog(roomId: string): Announcement[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(logKey(roomId)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseAnnouncement).filter((entry): entry is Announcement => entry !== null);
  } catch {
    return [];
  }
}

export function appendLog(roomId: string, entry: Announcement): void {
  try {
    const entries = loadLog(roomId).filter((existing) => existing.id !== entry.id);
    entries.push(entry);
    localStorage.setItem(logKey(roomId), JSON.stringify(entries.slice(-MAX_LOG)));
  } catch {
    // Sem armazenamento: o aviso ainda aparece na tela, só não fica no histórico.
  }
}

export function clearLog(roomId: string): void {
  try {
    localStorage.removeItem(logKey(roomId));
  } catch {
    // Nada a limpar.
  }
}

export function isLogKey(key: string | null, roomId: string): boolean {
  return key === null || key === logKey(roomId);
}

export function saveStatus(status: BridgeStatus): void {
  try {
    localStorage.setItem(STATUS_KEY, JSON.stringify(status));
  } catch {
    // Sem armazenamento: o painel recebe o status pelo canal de mensagens.
  }
}

export function parseStatus(data: unknown): BridgeStatus | null {
  if (!data || typeof data !== "object") return null;
  const raw = data as Record<string, unknown>;
  if (raw.state !== "conectado" && raw.state !== "procurando" && raw.state !== "jogador") return null;
  return { state: raw.state, url: typeof raw.url === "string" ? raw.url.slice(0, 200) : "" };
}

export function loadStatus(): BridgeStatus | null {
  try {
    return parseStatus(JSON.parse(localStorage.getItem(STATUS_KEY) ?? "null"));
  } catch {
    return null;
  }
}

export function isStatusKey(key: string | null): boolean {
  return key === null || key === STATUS_KEY;
}

/** Valida o combate guardado na sala; qualquer um na sala pode escrever ali. */
export function parseCombat(data: unknown): Combat | null {
  if (!data || typeof data !== "object") return null;
  const raw = data as Record<string, unknown>;
  if (!Array.isArray(raw.combatentes)) return null;
  const sides = ["jogador", "aliado", "inimigo"];
  const combatentes = (raw.combatentes as Array<Record<string, unknown>>)
    .slice(0, 40)
    .filter((c) => c && typeof c.nome === "string" && Number.isFinite(c.pv) && Number.isFinite(c.pvMax))
    .map((c) => ({
      id: String(c.id ?? c.nome),
      nome: String(c.nome).slice(0, 40),
      iniciativa: Number(c.iniciativa) || 0,
      pv: Number(c.pv),
      pvMax: Math.max(1, Number(c.pvMax)),
      ca: Number.isFinite(c.ca) ? Number(c.ca) : undefined,
      lado: (sides.includes(c.lado as string) ? c.lado : "inimigo") as Combat["combatentes"][number]["lado"],
      token: typeof c.token === "string" ? c.token.slice(0, 60) : undefined,
      jogador: typeof c.jogador === "string" ? c.jogador.slice(0, 60) : undefined,
      condicoes: Array.isArray(c.condicoes) ? c.condicoes.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 30)) : [],
    }));
  return {
    rodada: Number(raw.rodada) || 1,
    vez: Math.min(Math.max(Number(raw.vez) || 0, 0), Math.max(combatentes.length - 1, 0)),
    combatentes,
  };
}

/** Inventário de todos os personagens, nos dados da sala. */
export const INVENTORY_KEY = `${EXT_ID}/inventario`;

const LIMITS = { chars: 12, items: 80, name: 60, note: 120, qty: 99_999, coins: 9_999_999 };

function clampInt(value: unknown, min: number, max: number): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : min;
}

/** Valida o inventário guardado na sala; qualquer um na sala pode escrever ali. */
export function parseInventory(data: unknown): Inventory {
  const raw = (data && typeof data === "object" ? data : {}) as { personagens?: unknown };
  const list = Array.isArray(raw.personagens) ? raw.personagens : [];
  return {
    personagens: list
      .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object" && typeof (c as { nome?: unknown }).nome === "string")
      .slice(0, LIMITS.chars)
      .map((c) => {
        const moedas = (c.moedas && typeof c.moedas === "object" ? c.moedas : {}) as Record<string, unknown>;
        const itens = Array.isArray(c.itens) ? c.itens : [];
        return {
          id: typeof c.id === "string" ? c.id.slice(0, 60) : String(c.nome),
          nome: String(c.nome).slice(0, 40),
          jogador: typeof c.jogador === "string" && c.jogador.trim() ? c.jogador.slice(0, 60) : undefined,
          moedas: { po: clampInt(moedas.po, 0, LIMITS.coins), pp: clampInt(moedas.pp, 0, LIMITS.coins), pc: clampInt(moedas.pc, 0, LIMITS.coins) },
          itens: itens
            .filter((i): i is Record<string, unknown> => Boolean(i) && typeof i === "object" && typeof (i as { nome?: unknown }).nome === "string")
            .slice(0, LIMITS.items)
            .map((i) => ({
              id: typeof i.id === "string" ? i.id.slice(0, 60) : String(i.nome),
              nome: String(i.nome).slice(0, LIMITS.name),
              qtd: clampInt(i.qtd ?? 1, 1, LIMITS.qty),
              nota: typeof i.nota === "string" && i.nota.trim() ? i.nota.slice(0, LIMITS.note) : undefined,
            })),
        };
      }),
  };
}
