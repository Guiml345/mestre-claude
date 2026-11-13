import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { normalize } from "./grid.js";

/** Onde os tokens do catálogo ficam publicados (junto com a extensão, no GitHub Pages). */
export const CATALOG_BASE = "https://guiml345.github.io/mestre-claude/tokens";
/** Tamanho em pixels dos tokens gerados por scripts/tokens.mjs. */
export const CATALOG_SIZE = 256;

export interface CatalogIcon {
  /** Nome do arquivo, ex.: "goblin-head". Em inglês, como no game-icons.net. */
  name: string;
  author: string;
}

let cache: CatalogIcon[] | null = null;

/** Lê a lista de ícones da pasta icons/ (game-icons.net). */
export async function loadCatalog(iconsDir: string): Promise<CatalogIcon[]> {
  if (cache) return cache;
  const base = path.join(iconsDir, "ffffff", "000000", "1x1");
  const authors = await readdir(base, { withFileTypes: true }).catch(() => []);
  const list: CatalogIcon[] = [];
  for (const dir of authors) {
    if (!dir.isDirectory()) continue;
    for (const file of await readdir(path.join(base, dir.name)).catch(() => [] as string[])) {
      if (file.endsWith(".svg")) list.push({ name: file.slice(0, -4), author: dir.name });
    }
  }
  cache = list.sort((a, b) => a.name.localeCompare(b.name));
  return cache;
}

export function iconUrl(icon: CatalogIcon): string {
  return `${CATALOG_BASE}/${icon.author}/${icon.name}.png`;
}

/**
 * Procura ícones pelo nome (em inglês). Todas as palavras precisam aparecer.
 * Primeiro os nomes exatos, depois os que começam com a busca, depois os mais curtos.
 */
export function searchCatalog(list: CatalogIcon[], query: string, limit = 25): CatalogIcon[] {
  const words = normalize(query).replace(/[-_]+/g, " ").split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const key = words.join("-");
  const scored = list
    .map((icon) => ({ icon, text: icon.name.replace(/-/g, " ") }))
    .filter(({ text }) => words.every((w) => text.includes(w)))
    .map(({ icon }) => ({
      icon,
      score: (icon.name === key ? 0 : icon.name.startsWith(key) ? 1 : 2) * 1000 + icon.name.length,
    }))
    .sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.icon);
}

/** Papel comum de RPG (em português) com o ícone já conferido. Fica em server/papeis.json. */
export interface Role {
  nome: string;
  icone: string;
  grupo: string;
  sinonimos: string[];
  alternativas: string[];
}

/** Lê os papéis. Sem o arquivo, a lista fica vazia (o catálogo continua funcionando em inglês). */
export async function loadRoles(file: string | undefined): Promise<Role[]> {
  if (!file) return [];
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return [];
  const data = JSON.parse(text) as { papeis?: Record<string, { icone?: string; grupo?: string; sinonimos?: string[]; alternativas?: string[] }> };
  return Object.entries(data.papeis ?? {})
    .filter(([, r]) => typeof r.icone === "string" && r.icone.includes("/"))
    .map(([nome, r]) => ({ nome, icone: r.icone!, grupo: r.grupo ?? "outros", sinonimos: r.sinonimos ?? [], alternativas: r.alternativas ?? [] }));
}

/** Acha o papel pelo nome ou sinônimo, ignorando acentos e maiúsculas. */
export function findRole(roles: Role[], query: string): Role | null {
  const key = normalize(query).replace(/-/g, " ");
  const same = (text: string) => normalize(text).replace(/-/g, " ") === key;
  return roles.find((r) => same(r.nome)) ?? roles.find((r) => r.sinonimos.some(same)) ?? null;
}

/** Acha um ícone exato ("goblin" ou "lorc/wolf-head"); se não houver, o melhor da busca. */
export function resolveIcon(list: CatalogIcon[], query: string): { icon: CatalogIcon | null; options: CatalogIcon[] } {
  const [maybeAuthor, maybeName] = query.includes("/") ? query.split("/", 2) : [undefined, query];
  if (maybeAuthor && maybeName) {
    const found = list.find((i) => i.author === maybeAuthor && i.name === maybeName);
    if (found) return { icon: found, options: [] };
  }
  const options = searchCatalog(list, query, 12);
  const exact = options.filter((i) => i.name === normalize(query).replace(/\s+/g, "-"));
  if (exact.length >= 1) return { icon: exact[0]!, options };
  return { icon: options[0] ?? null, options };
}
