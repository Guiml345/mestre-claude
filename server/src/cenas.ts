import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { CATALOG_BASE } from "./catalog.js";
import { normalize } from "./grid.js";
import type { Combat, Inventory } from "./protocol.js";

/**
 * Cena salva de uma campanha: onde cada token estava, o combate, a névoa e o
 * inventário. Fica em campanhas/<nome>/cena.json; a versão anterior vai para
 * cena.anterior.json a cada salvamento.
 */

export const SCENE_FILE = "cena.json";
export const PREVIOUS_SCENE_FILE = "cena.anterior.json";

/** Só imagens publicadas pela própria extensão podem ser recriadas. */
export const RESTORABLE_PREFIX = `${new URL(CATALOG_BASE).origin}/`;

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
  imagem?: { url: string; largura: number; altura: number };
}

export interface SceneSnapshot {
  versao: 1;
  salvoEm: string;
  motivo?: string;
  /** Nome do mapa da cena (para não restaurar no mapa errado). */
  mapa: string | null;
  tokens: SavedToken[];
  combate: Combat | null;
  nevoa: { cobrindo: boolean; reveladas: string[] } | null;
  inventario: Inventory | null;
}

export async function writeSnapshot(dir: string, snapshot: SceneSnapshot): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, SCENE_FILE);
  await rename(file, path.join(dir, PREVIOUS_SCENE_FILE)).catch(() => {});
  await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return file;
}

export async function readSnapshot(dir: string, previous = false): Promise<SceneSnapshot | null> {
  const text = await readFile(path.join(dir, previous ? PREVIOUS_SCENE_FILE : SCENE_FILE), "utf8").catch(() => null);
  if (text === null) return null;
  const data = JSON.parse(text) as SceneSnapshot;
  if (data?.versao !== 1 || !Array.isArray(data.tokens)) throw new Error("cena.json em formato desconhecido.");
  return data;
}

export function canRecreate(token: SavedToken): boolean {
  return Boolean(token.imagem?.url.startsWith(RESTORABLE_PREFIX));
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
