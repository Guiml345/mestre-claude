import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Ficha } from "./protocol.js";
import { ATRIBUTOS, NOMES_ATRIBUTOS, checkSheet, modifier, parseSheet, signed, spellLimits, type ClassTables, type SpellData } from "./regras.js";
export { parseSheet, sheetSlug } from "./regras.js";

/** Fichas em JSON: campanhas/<nome>/fichas/<id>.json. As imagens e PDFs ao lado são só a origem. */

let spellCache: { dir: string; spells: SpellData[]; tables: ClassTables } | null = null;

/** Magias e tabelas de classe (extension/public/dados). */
export async function loadRulesData(dataDir: string): Promise<{ spells: SpellData[]; tables: ClassTables }> {
  if (spellCache?.dir === dataDir) return spellCache;
  const spells = JSON.parse(await readFile(path.join(dataDir, "magias.json"), "utf8")).magias as SpellData[];
  const tables = JSON.parse(await readFile(path.join(dataDir, "classes.json"), "utf8")) as ClassTables;
  spellCache = { dir: dataDir, spells, tables };
  return spellCache;
}

/** Lê as fichas JSON da pasta da campanha. Arquivos com erro vão para `erros`. */
export async function readSheets(campaignDir: string): Promise<{ fichas: Ficha[]; erros: string[] }> {
  const dir = path.join(campaignDir, "fichas");
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
  const fichas: Ficha[] = [];
  const erros: string[] = [];
  for (const file of files.sort()) {
    try {
      const sheet = parseSheet(JSON.parse(await readFile(path.join(dir, file), "utf8")));
      if (sheet) fichas.push({ ...sheet, id: file.slice(0, -5) });
      else erros.push(`${file}: não parece uma ficha (falta nome ou classe).`);
    } catch (err) {
      erros.push(`${file}: ${(err as Error).message}`);
    }
  }
  return { fichas, erros };
}

export async function writeSheet(campaignDir: string, sheet: Ficha): Promise<string> {
  const dir = path.join(campaignDir, "fichas");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sheet.id}.json`);
  await writeFile(file, `${JSON.stringify(sheet, null, 2)}\n`, "utf8");
  return file;
}

function newer(a: Ficha, b: Ficha): boolean {
  return Date.parse(a.atualizadoEm) > Date.parse(b.atualizadoEm);
}

/**
 * Junta as fichas do disco e da sala: para cada personagem fica a mais nova.
 * Diz quais precisam ir para o disco e quais para a sala.
 */
export function mergeSheets(disk: Ficha[], room: Ficha[]): { fichas: Ficha[]; paraDisco: Ficha[]; paraSala: boolean } {
  const out = new Map<string, Ficha>();
  const paraDisco: Ficha[] = [];
  let paraSala = false;
  for (const d of disk) out.set(d.id, d);
  for (const r of room) {
    const d = out.get(r.id);
    if (!d || newer(r, d)) {
      out.set(r.id, r);
      paraDisco.push(r);
    }
  }
  for (const d of disk) {
    const r = room.find((x) => x.id === d.id);
    if (!r || newer(d, r)) paraSala = true;
  }
  return { fichas: [...out.values()].sort((a, b) => a.nome.localeCompare(b.nome)), paraDisco, paraSala };
}

/** Texto da ficha para o mestre: o que importa na mesa. */
export function describeSheet(f: Ficha, spells: SpellData[], tables: ClassTables, full = true): string {
  const classe = tables.classes[f.classe]?.nome ?? f.classe;
  const head = `${f.nome}${f.jogador ? ` [${f.jogador}]` : ""}: ${f.especie}, ${classe}${f.subclasse ? ` (${f.subclasse})` : ""} ${f.nivel}. PV ${f.pv.atual}/${f.pv.max}${f.pv.temp ? ` +${f.pv.temp} temp` : ""}, CA ${f.ca}, iniciativa ${signed(f.iniciativa)}, deslocamento ${f.deslocamento}.`;
  const limits = spellLimits(tables, f.classe, f.nivel);
  const byId = new Map(spells.map((s) => [s.id, s]));
  const name = (id: string) => byId.get(id)?.nome ?? `${id}?`;
  const lines = [head];
  if (full) {
    lines.push(ATRIBUTOS.map((a) => `${NOMES_ATRIBUTOS[a]} ${f.atributos[a]} (${signed(modifier(f.atributos[a]))})`).join(", ") + ".");
    lines.push(`Salvaguardas: ${ATRIBUTOS.map((a) => `${NOMES_ATRIBUTOS[a]} ${signed(modifier(f.atributos[a]) + (f.salvaguardas.includes(a) ? f.proficiencia : 0))}`).join(", ")}.`);
    if (f.pericias.length) lines.push(`Perícias: ${f.pericias.map((p) => `${p.nome} ${signed(p.bonus)}`).join(", ")}.`);
    if (f.sentidos) lines.push(`Sentidos: ${f.sentidos}.`);
    if (f.ataques.length) lines.push(`Ataques: ${f.ataques.map((a) => `${a.nome} ${signed(a.bonus)} (${a.dano}${a.nota ? `; ${a.nota}` : ""})`).join("; ")}.`);
    for (const c of f.caracteristicas) lines.push(`• ${c.nome}: ${c.texto}`);
  }
  const m = f.magia;
  if (m && limits) {
    const slots = limits.espacos.map((n, i) => `${i + 1}º ${n - (m.gastos[i] ?? 0)}/${n}`).filter((s) => !s.endsWith("/0")).join(", ");
    lines.push(`Magia (${NOMES_ATRIBUTOS[m.atributo]}): CD ${m.cd}, ataque ${signed(m.ataque)}. Espaços livres: ${slots || "nenhum"}.`);
    if (m.truques.length) lines.push(`Truques: ${m.truques.map(name).join(", ")}.`);
    lines.push(`Preparadas (${m.preparadas.length}/${limits.preparadas}): ${m.preparadas.map(name).join(", ") || "nenhuma"}.`);
    const sempre = [...new Set([...limits.sempre, ...m.sempre])];
    if (sempre.length) lines.push(`Sempre preparadas: ${sempre.map(name).join(", ")}.`);
    if (m.extras?.length) lines.push(`Extras: ${m.extras.map((e) => `${name(e.id)} (${e.fonte})`).join(", ")}.`);
    if (m.grimorio?.length && full) lines.push(`Grimório: ${m.grimorio.map(name).join(", ")}.`);
  }
  if (f.pendencias?.length) lines.push(`Pendências: ${f.pendencias.join(" | ")}`);
  const problems = checkSheet(f, spells, tables);
  if (problems.length) lines.push(`Fora da regra: ${problems.join(" ")}`);
  return lines.join("\n");
}
