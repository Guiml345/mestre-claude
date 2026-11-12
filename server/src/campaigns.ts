import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { MesaError } from "./errors.js";
import { normalize } from "./grid.js";

/**
 * Campanhas: cada uma é uma pasta em campanhas/<nome>/ com resumo.md, fichas/ e
 * rolagens.jsonl. A campanha ativa fica anotada em campanhas/.ativa.
 */

const ACTIVE_FILE = ".ativa";
const TEMPLATE_DIR = "_modelo";
/** Usada quando nenhuma campanha foi escolhida, para nada se misturar com as de verdade. */
export const FALLBACK_CAMPAIGN = "teste";

export interface CampaignInfo {
  slug: string;
  dir: string;
  ativa: boolean;
  temResumo: boolean;
  fichas: string[];
  rolagens: number;
}

/** "Vila do Queijo Mofado" vira "vila-do-queijo-mofado". */
export function slugify(name: string): string {
  return normalize(name)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

export async function getActiveCampaign(root: string): Promise<string> {
  const name = (await readFile(path.join(root, ACTIVE_FILE), "utf8").catch(() => "")).trim();
  return name && (await exists(path.join(root, name))) ? name : FALLBACK_CAMPAIGN;
}

export async function activeCampaignDir(root: string): Promise<string> {
  return path.join(root, await getActiveCampaign(root));
}

async function describe(root: string, slug: string, active: string): Promise<CampaignInfo> {
  const dir = path.join(root, slug);
  const fichas = (await readdir(path.join(dir, "fichas")).catch(() => [] as string[])).filter((f) => f.endsWith(".md"));
  const log = await readFile(path.join(dir, "rolagens.jsonl"), "utf8").catch(() => "");
  return {
    slug,
    dir,
    ativa: slug === active,
    temResumo: await exists(path.join(dir, "resumo.md")),
    fichas,
    rolagens: log.split("\n").filter(Boolean).length,
  };
}

export async function listCampaigns(root: string): Promise<CampaignInfo[]> {
  const active = await getActiveCampaign(root);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const slugs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== TEMPLATE_DIR).map((e) => e.name);
  return Promise.all(slugs.sort().map((slug) => describe(root, slug, active)));
}

/** Cria a pasta da campanha a partir do modelo (resumo e ficha em branco). */
export async function createCampaign(root: string, name: string): Promise<CampaignInfo> {
  const slug = slugify(name);
  if (!slug || slug === TEMPLATE_DIR) throw new MesaError("BAD_REQUEST", "Nome de campanha inválido.");
  const dir = path.join(root, slug);
  if (await exists(dir)) throw new MesaError("BAD_REQUEST", `A campanha "${slug}" já existe.`);
  await mkdir(path.join(dir, "fichas"), { recursive: true });
  const template = path.join(root, TEMPLATE_DIR);
  const resumo = await readFile(path.join(template, "resumo.md"), "utf8").catch(() => "# Resumo da campanha\n");
  await writeFile(path.join(dir, "resumo.md"), resumo.replace("{{NOME}}", name.trim()), "utf8");
  await copyFile(path.join(template, "fichas", "MODELO.md"), path.join(dir, "fichas", "MODELO.md")).catch(() => {});
  return describe(root, slug, await getActiveCampaign(root));
}

/** Escolhe a campanha ativa, aceitando o nome ou parte dele. */
export async function setActiveCampaign(root: string, name: string): Promise<CampaignInfo> {
  const all = await listCampaigns(root);
  const key = slugify(name);
  const found = all.find((c) => c.slug === key) ?? (all.filter((c) => c.slug.includes(key)).length === 1 ? all.find((c) => c.slug.includes(key)) : undefined);
  if (!found) {
    throw new MesaError("BAD_REQUEST", `Não achei a campanha "${name}". Campanhas: ${all.map((c) => c.slug).join(", ") || "nenhuma"}.`);
  }
  await writeFile(path.join(root, ACTIVE_FILE), `${found.slug}\n`, "utf8");
  return { ...found, ativa: true };
}

export function describeCampaign(c: CampaignInfo): string {
  const parts = [
    `"${c.slug}"${c.ativa ? " (ativa)" : ""}: pasta ${c.dir}`,
    c.temResumo ? "resumo.md" : "sem resumo",
    c.fichas.length ? `fichas: ${c.fichas.join(", ")}` : "sem fichas",
    `${c.rolagens} rolagem(ns) registradas`,
  ];
  return parts.join("; ");
}
