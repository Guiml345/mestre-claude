import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { CATALOG_BASE } from "./catalog.js";
import { normalize } from "./grid.js";
import type { Combat, Inventory, Vec2 } from "./protocol.js";

/**
 * Cenas salvas de uma campanha: o mapa, onde cada token estava (com imagem,
 * tamanho e escala), o combate, a névoa e o inventário.
 * - Sem nome: campanhas/<nome>/cena.json.
 * - Com nome: campanhas/<nome>/cenas/<cena>.json.
 * A versão anterior de cada uma fica ao lado, com ".anterior" no nome. A última
 * cena usada fica anotada em cenas/.atual, para o salvamento automático cair nela.
 */

export const SCENE_FILE = "cena.json";
export const PREVIOUS_SCENE_FILE = "cena.anterior.json";
const SCENES_DIR = "cenas";
const CURRENT_FILE = ".atual";

/** Imagens que a extensão aceita recriar: o catálogo e as do próprio Owlbear. */
export const RESTORABLE_PREFIXES = [`${new URL(CATALOG_BASE).origin}/`, "https://images.owlbear.rodeo/"];

export interface SavedImage {
  url: string;
  largura: number;
  altura: number;
  mime?: string;
  /** Grade da própria imagem (pixels por casa e âncora). */
  grade?: { dpi: number; offset: Vec2 };
}

export interface SavedToken {
  id: string;
  /** Nome da imagem no Owlbear. */
  nome: string;
  /** Rótulo escrito embaixo do token. */
  rotulo: string;
  camada: string;
  coluna: number;
  linha: number;
  /** Tamanho em casas. */
  largura: number;
  altura: number;
  visivel: boolean;
  imagem?: SavedImage;
  /** Posição exata em pixels da cena, escala e rotação. */
  posicao?: Vec2;
  escala?: Vec2;
  rotacao?: number;
  travado?: boolean;
}

export interface SavedMap {
  nome: string;
  imagem: SavedImage;
  posicao: Vec2;
  escala: Vec2;
  rotacao: number;
  visivel: boolean;
  travado: boolean;
}

export interface SceneSnapshot {
  versao: 1;
  salvoEm: string;
  motivo?: string;
  /** Nome da cena, quando salva com nome. */
  cena?: string;
  /** Id da sala do Owlbear onde foi salva (para não restaurar na sala errada). */
  sala?: string;
  /** Nome do mapa da cena (para não restaurar no mapa errado). */
  mapa: string | null;
  /** O mapa completo, para recriar numa cena vazia. */
  mapaImagem?: SavedMap;
  /** Pixels por casa da cena quando foi salva. */
  grade?: { dpi: number };
  tokens: SavedToken[];
  combate: Combat | null;
  nevoa: { cobrindo: boolean; reveladas: string[] } | null;
  inventario: Inventory | null;
}

export function sceneSlug(name: string): string {
  return normalize(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}

/** Qual cena usar: a do nome; sem nome, a última usada; sem nenhuma, a cena.json. */
async function resolveScene(dir: string, name?: string): Promise<{ file: string; previous: string; label: string | null }> {
  let slug = name?.trim() ? sceneSlug(name) : "";
  if (name?.trim() && !slug) throw new Error("Nome de cena inválido.");
  if (!slug && name === undefined) {
    slug = (await readFile(path.join(dir, SCENES_DIR, CURRENT_FILE), "utf8").catch(() => "")).trim();
  }
  if (!slug) return { file: path.join(dir, SCENE_FILE), previous: path.join(dir, PREVIOUS_SCENE_FILE), label: null };
  return {
    file: path.join(dir, SCENES_DIR, `${slug}.json`),
    previous: path.join(dir, SCENES_DIR, `${slug}.anterior.json`),
    label: slug,
  };
}

async function markCurrent(dir: string, label: string | null): Promise<void> {
  if (!label) return;
  await mkdir(path.join(dir, SCENES_DIR), { recursive: true });
  await writeFile(path.join(dir, SCENES_DIR, CURRENT_FILE), `${label}\n`, "utf8");
}

export async function writeSnapshot(dir: string, snapshot: SceneSnapshot, name?: string): Promise<string> {
  const target = await resolveScene(dir, name);
  await mkdir(path.dirname(target.file), { recursive: true });
  await rename(target.file, target.previous).catch(() => {});
  const data: SceneSnapshot = target.label ? { ...snapshot, cena: target.label } : snapshot;
  await writeFile(target.file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await markCurrent(dir, target.label);
  return target.file;
}

export async function readSnapshot(dir: string, options: { name?: string; previous?: boolean } = {}): Promise<{ snapshot: SceneSnapshot | null; file: string }> {
  const target = await resolveScene(dir, options.name);
  const file = options.previous ? target.previous : target.file;
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return { snapshot: null, file };
  const data = JSON.parse(text) as SceneSnapshot;
  if (data?.versao !== 1 || !Array.isArray(data.tokens)) throw new Error(`${path.basename(file)} em formato desconhecido.`);
  await markCurrent(dir, target.label);
  return { snapshot: data, file };
}

/** Cenas salvas com nome (sem as anteriores), e se existe a cena.json sem nome. */
export async function listScenes(dir: string): Promise<{ named: string[]; current: string | null; unnamed: boolean }> {
  const files = await readdir(path.join(dir, SCENES_DIR)).catch(() => [] as string[]);
  const named = files.filter((f) => f.endsWith(".json") && !f.endsWith(".anterior.json")).map((f) => f.slice(0, -5)).sort();
  const current = (await readFile(path.join(dir, SCENES_DIR, CURRENT_FILE), "utf8").catch(() => "")).trim() || null;
  const unnamed = await readFile(path.join(dir, SCENE_FILE), "utf8").then(() => true, () => false);
  return { named, current, unnamed };
}

export function isRestorableUrl(url: string | undefined): boolean {
  return Boolean(url && RESTORABLE_PREFIXES.some((prefix) => url.startsWith(prefix)));
}

export function canRecreate(token: SavedToken): boolean {
  return isRestorableUrl(token.imagem?.url);
}

interface Matchable {
  id: string;
  name: string;
  text?: string;
}

function key(nome: string, rotulo: string | undefined): string {
  return `${normalize(rotulo || nome)}|${normalize(nome)}`;
}

/**
 * Casa cada token salvo com um da cena: primeiro pelo id (mesma cena), depois
 * pelo rótulo + nome da imagem. Cada token da cena é usado uma vez só.
 */
export function matchTokens<T extends Matchable>(saved: SavedToken[], current: T[]): { pairs: Array<{ saved: SavedToken; item: T }>; missing: SavedToken[]; extra: T[] } {
  const free = new Map(current.map((item) => [item.id, item]));
  const pairs: Array<{ saved: SavedToken; item: T }> = [];
  const pending: SavedToken[] = [];
  for (const s of saved) {
    const item = free.get(s.id);
    if (item) {
      pairs.push({ saved: s, item });
      free.delete(s.id);
    } else {
      pending.push(s);
    }
  }
  const missing: SavedToken[] = [];
  for (const s of pending) {
    const wanted = key(s.nome, s.rotulo);
    const item = [...free.values()].find((candidate) => key(candidate.name, candidate.text) === wanted);
    if (item) {
      pairs.push({ saved: s, item });
      free.delete(item.id);
    } else {
      missing.push(s);
    }
  }
  return { pairs, missing, extra: [...free.values()] };
}
