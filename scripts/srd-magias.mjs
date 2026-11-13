#!/usr/bin/env node
/**
 * Extrai as magias do SRD 5.2.1 (D&D 2024, licença CC-BY-4.0) para JSON.
 *
 * Uso:
 *   1. Baixe o PDF oficial: https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf
 *   2. pdftotext SRD_CC_v5.2.1.pdf srd.txt      (sem -layout)
 *   3. node scripts/srd-magias.mjs srd.txt
 *
 * Grava extension/public/dados/magias.json, que vai junto com a extensão (GitHub Pages)
 * e é lido pelo servidor. O PDF não fica no repositório.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "extension", "public", "dados", "magias.json");

const CLASSES = { Bard: "bardo", Cleric: "clerigo", Druid: "druida", Paladin: "paladino", Ranger: "patrulheiro", Sorcerer: "feiticeiro", Warlock: "bruxo", Wizard: "mago" };
const SCHOOLS = {
  Abjuration: "Abjuração", Conjuration: "Conjuração", Divination: "Adivinhação", Enchantment: "Encantamento",
  Evocation: "Evocação", Illusion: "Ilusão", Necromancy: "Necromancia", Transmutation: "Transmutação",
};

const HEADER = /^(?:Level ([1-9]) ([A-Z][a-z]+)|([A-Z][a-z]+) Cantrip) \((.+)\)$/;
const FOOTER = /^\d+ System Reference Document 5\.2\.1$/;

function slug(name) {
  return name.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const input = process.argv[2];
if (!input) {
  console.error("Uso: node scripts/srd-magias.mjs <srd.txt>");
  process.exit(1);
}
const lines = (await readFile(input, "utf8")).split(/\r?\n/);
const start = lines.findIndex((l, i) => i > 5000 && l.trim() === "Spell Descriptions");
const end = lines.findIndex((l, i) => i > start && l.trim() === "Rules Glossary");
if (start < 0 || end < 0) throw new Error("Não achei a seção \"Spell Descriptions\" no texto.");

// Junta o corpo sem rodapés de página; quebras de linha no meio de frase viram espaço.
// O rodapé vem como "107 System Reference Document 5.2.1" ou em duas linhas ("161" e o título).
const raw = lines.slice(start + 1, end).map((l) => l.replace(/\f/g, ""));
const body = raw.filter((l, i) => {
  const t = l.trim();
  if (FOOTER.test(t) || t === "System Reference Document 5.2.1") return false;
  if (/^\d+$/.test(t)) {
    const next = raw.slice(i + 1, i + 4).find((n) => n.trim());
    if (next?.trim() === "System Reference Document 5.2.1") return false;
  }
  return true;
});

const spells = [];
for (let i = 0; i < body.length; i++) {
  const m = HEADER.exec(body[i]?.trim() ?? "");
  if (!m) continue;
  const name = body[i - 1].trim();
  const level = m[1] ? Number(m[1]) : 0;
  const school = m[2] ?? m[3];
  const classes = m[4].split(",").map((c) => c.trim()).filter((c) => CLASSES[c]).map((c) => CLASSES[c]);
  // Linhas até o próximo cabeçalho (a linha antes dele é o nome da próxima magia).
  let j = i + 1;
  while (j < body.length && !HEADER.test(body[j].trim())) j++;
  const chunk = body.slice(i + 1, j < body.length ? j - 1 : j);
  // Bloco de conjuração: do "Casting Time:" até o fim do "Duration: ...".
  let meta = "";
  let k = 0;
  while (k < chunk.length && !/Duration: /.test(meta)) meta += ` ${chunk[k++].trim()}`;
  // A duração pode continuar na linha seguinte (ex.: "Concentration, up to").
  const pick = (re) => (re.exec(meta)?.[1] ?? "").trim();
  const text = chunk
    .slice(k)
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/([^.:!?”"])\n\s*(?=[a-z0-9(,])/g, "$1 ")
    .replace(/ {2,}/g, " ")
    .trim();
  spells.push({
    id: slug(name),
    nome: name,
    nivel: level,
    escola: SCHOOLS[school] ?? school,
    classes,
    tempo: pick(/Casting Time: (.*?) Range:/),
    alcance: pick(/Range: (.*?) Components?:/),
    componentes: pick(/Components?: (.*?) Duration:/),
    duracao: pick(/Duration: (.*)$/),
    ritual: /\bRitual\b/.test(pick(/Casting Time: (.*?) Range:/)),
    concentracao: /Concentration/.test(pick(/Duration: (.*)$/)),
    texto: text,
  });
}

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(
  OUT,
  `${JSON.stringify({ fonte: "System Reference Document 5.2.1 (Wizards of the Coast), licença CC-BY-4.0", magias: spells })}\n`,
  "utf8",
);
const byClass = Object.values(CLASSES).map((c) => `${c} ${spells.filter((s) => s.classes.includes(c)).length}`).join(", ");
console.log(`${spells.length} magias gravadas em ${path.relative(ROOT, OUT)} (${byClass}).`);
