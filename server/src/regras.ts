/**
 * Regras de ficha do D&D 2024 que o servidor e o painel usam: espaços de magia,
 * limites de magias preparadas e conferência da ficha. Funções puras, sem Node:
 * a extensão importa este arquivo também.
 */
import type { Atributo, Ficha } from "./protocol.js";

export interface SpellData {
  id: string;
  nome: string;
  nivel: number;
  escola: string;
  classes: string[];
  tempo: string;
  alcance: string;
  componentes: string;
  duracao: string;
  ritual: boolean;
  concentracao: boolean;
  texto: string;
}

export interface ClassData {
  nome: string;
  atributo: Atributo;
  dadoVida: number;
  progressao: "completo" | "meio" | "pacto";
  truques: number[] | null;
  preparadas: number[];
  sempre?: Record<string, string[]>;
  magiaDePacto?: { espacos: number[]; nivel: number[] };
}

export interface ClassTables {
  progressoes: Record<string, number[][]>;
  classes: Record<string, ClassData>;
}

export const ATRIBUTOS: Atributo[] = ["for", "des", "con", "int", "sab", "car"];
export const NOMES_ATRIBUTOS: Record<Atributo, string> = { for: "FOR", des: "DES", con: "CON", int: "INT", sab: "SAB", car: "CAR" };

export function modifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

export interface SpellLimits {
  /** Espaços por nível de magia (posição 0 = 1º). */
  espacos: number[];
  preparadas: number;
  truques: number;
  /** Maior nível de magia que pode preparar. */
  nivelMax: number;
  /** Sempre preparadas pela classe neste nível. */
  sempre: string[];
}

/** O que a classe dá neste nível. Null se a classe não conjura (ou não está nas tabelas). */
export function spellLimits(tables: ClassTables, classe: string, nivel: number): SpellLimits | null {
  const c = tables.classes[classe];
  if (!c) return null;
  const i = Math.min(Math.max(Math.trunc(nivel), 1), 20) - 1;
  let espacos: number[];
  if (c.progressao === "pacto" && c.magiaDePacto) {
    const qtd = c.magiaDePacto.espacos[i] ?? 0;
    const lvl = c.magiaDePacto.nivel[i] ?? 1;
    espacos = Array.from({ length: lvl }, (_, k) => (k === lvl - 1 ? qtd : 0));
  } else {
    espacos = [...(tables.progressoes[c.progressao]?.[i] ?? [])];
  }
  const sempre = Object.entries(c.sempre ?? {})
    .filter(([lvl]) => Number(lvl) <= i + 1)
    .flatMap(([, ids]) => ids);
  return {
    espacos,
    preparadas: c.preparadas[i] ?? 0,
    truques: c.truques?.[i] ?? 0,
    nivelMax: espacos.length,
    sempre,
  };
}

/** Magias de nível 1+ que a classe pode preparar neste nível. */
export function preparableSpells(spells: SpellData[], tables: ClassTables, classe: string, nivel: number): SpellData[] {
  const limits = spellLimits(tables, classe, nivel);
  if (!limits) return [];
  return spells
    .filter((s) => s.nivel >= 1 && s.nivel <= limits.nivelMax && s.classes.includes(classe))
    .sort((a, b) => a.nivel - b.nivel || a.nome.localeCompare(b.nome));
}

/** Truques da lista da classe. */
export function classCantrips(spells: SpellData[], classe: string): SpellData[] {
  return spells.filter((s) => s.nivel === 0 && s.classes.includes(classe)).sort((a, b) => a.nome.localeCompare(b.nome));
}

/** Acha uma magia pelo id ou pelo nome (em inglês), ignorando maiúsculas e apóstrofos. */
export function findSpell(spells: SpellData[], query: string): SpellData | undefined {
  const key = query.trim().toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return spells.find((s) => s.id === key);
}

/** Problemas da ficha em relação às regras (vazio = tudo certo). */
export function checkSheet(f: Ficha, spells: SpellData[], tables: ClassTables): string[] {
  const out: string[] = [];
  if (f.nivel < 1 || f.nivel > 20) out.push(`Nível ${f.nivel} fora de 1 a 20.`);
  if (f.pv.atual > f.pv.max) out.push(`PV atual (${f.pv.atual}) acima do máximo (${f.pv.max}).`);
  const expectedProf = Math.ceil(f.nivel / 4) + 1;
  if (f.proficiencia !== expectedProf) out.push(`Bônus de proficiência ${signed(f.proficiencia)}; no nível ${f.nivel} é ${signed(expectedProf)}.`);
  const limits = spellLimits(tables, f.classe, f.nivel);
  const m = f.magia;
  if (!limits || !m) {
    if (m && !limits) out.push(`A classe "${f.classe}" não tem tabela de magias.`);
    return out;
  }
  const byId = new Map(spells.map((s) => [s.id, s]));
  const unknown = [...m.truques, ...m.preparadas, ...m.sempre, ...(m.grimorio ?? []), ...(m.extras ?? []).map((e) => e.id)].filter((id) => !byId.has(id));
  if (unknown.length) out.push(`Magias que não estão no SRD: ${[...new Set(unknown)].join(", ")}.`);
  if (m.preparadas.length > limits.preparadas) out.push(`${m.preparadas.length} magias preparadas; o limite no nível ${f.nivel} é ${limits.preparadas}.`);
  const classTruques = m.truques.filter((id) => byId.get(id)?.classes.includes(f.classe));
  if (limits.truques && classTruques.length > limits.truques) out.push(`${classTruques.length} truques da classe; o limite é ${limits.truques}.`);
  for (const id of m.preparadas) {
    const s = byId.get(id);
    if (!s) continue;
    if (s.nivel > limits.nivelMax) out.push(`${s.nome} é de ${s.nivel}º nível; no nível ${f.nivel} só até ${limits.nivelMax}º.`);
    if (!s.classes.includes(f.classe)) out.push(`${s.nome} não está na lista de ${tables.classes[f.classe]?.nome ?? f.classe}.`);
    if (f.classe === "mago" && m.grimorio && !m.grimorio.includes(id)) out.push(`${s.nome} está preparada mas não está no grimório.`);
  }
  m.gastos.forEach((g, i) => {
    if (g > (limits.espacos[i] ?? 0)) out.push(`${g} espaços de ${i + 1}º nível gastos, mas só tem ${limits.espacos[i] ?? 0}.`);
  });
  const atrib = tables.classes[f.classe]?.atributo;
  if (atrib && m.atributo === atrib) {
    const mod = modifier(f.atributos[atrib]);
    if (m.cd !== 8 + f.proficiencia + mod) out.push(`CD de magia ${m.cd}; pela ficha seria ${8 + f.proficiencia + mod}.`);
    if (m.ataque !== f.proficiencia + mod) out.push(`Ataque mágico ${signed(m.ataque)}; pela ficha seria ${signed(f.proficiencia + mod)}.`);
  }
  return out;
}

// ------------------------------------------------------------ validação

export function sheetSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

function str(v: unknown, max = 200): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

function ids(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length < 60).slice(0, 80) : [];
}

/**
 * Confere e limpa uma ficha vinda de arquivo ou da sala (qualquer jogador pode escrever
 * nos dados da sala). Devolve null se não for uma ficha.
 */
export function parseSheet(raw: unknown): Ficha | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const nome = str(r.nome, 40);
  const classe = str(r.classe, 30);
  if (!nome || !classe) return null;
  const atributos = Object.fromEntries(ATRIBUTOS.map((a) => [a, Math.min(Math.max(num(r.atributos?.[a], 10), 1), 30)])) as Record<Atributo, number>;
  const list = <T>(v: unknown, map: (x: any) => T | null, max = 40): T[] =>
    Array.isArray(v) ? v.map(map).filter((x): x is T => x !== null).slice(0, max) : [];
  const m = r.magia && typeof r.magia === "object" ? r.magia : null;
  return {
    id: str(r.id, 40) ? sheetSlug(r.id) : sheetSlug(nome),
    nome,
    jogador: str(r.jogador, 60),
    token: str(r.token, 60),
    especie: str(r.especie, 40) ?? "",
    classe,
    subclasse: str(r.subclasse, 40),
    nivel: Math.min(Math.max(num(r.nivel, 1), 1), 20),
    antecedente: str(r.antecedente, 40),
    xp: typeof r.xp === "number" ? num(r.xp, 0) : undefined,
    atributos,
    pv: { max: Math.max(num(r.pv?.max, 1), 1), atual: num(r.pv?.atual, num(r.pv?.max, 1)), temp: Math.max(num(r.pv?.temp, 0), 0) },
    ca: num(r.ca, 10),
    caNota: str(r.caNota, 80),
    iniciativa: num(r.iniciativa, 0),
    deslocamento: str(r.deslocamento, 30) ?? "9 m",
    proficiencia: num(r.proficiencia, 2),
    salvaguardas: ids(r.salvaguardas).filter((a): a is Atributo => (ATRIBUTOS as string[]).includes(a)),
    pericias: list(r.pericias, (p) => (str(p?.nome, 40) ? { nome: str(p.nome, 40)!, bonus: num(p.bonus, 0) } : null)),
    sentidos: str(r.sentidos, 120),
    idiomas: str(r.idiomas, 120),
    ataques: list(r.ataques, (a) =>
      str(a?.nome, 40) ? { nome: str(a.nome, 40)!, bonus: num(a.bonus, 0), dano: str(a.dano, 60) ?? "", nota: str(a.nota, 120) } : null,
    ),
    caracteristicas: list(r.caracteristicas, (c) => (str(c?.nome, 60) ? { nome: str(c.nome, 60)!, texto: str(c.texto, 400) ?? "" } : null)),
    magia: m
      ? {
          atributo: (ATRIBUTOS as string[]).includes(m.atributo) ? m.atributo : "int",
          cd: num(m.cd, 10),
          ataque: num(m.ataque, 0),
          truques: ids(m.truques),
          preparadas: ids(m.preparadas),
          sempre: ids(m.sempre),
          grimorio: Array.isArray(m.grimorio) ? ids(m.grimorio) : undefined,
          extras: Array.isArray(m.extras)
            ? list(m.extras, (e) => (str(e?.id, 60) ? { id: str(e.id, 60)!, fonte: str(e.fonte, 60) ?? "" } : null), 20)
            : undefined,
          gastos: Array.isArray(m.gastos) ? m.gastos.slice(0, 9).map((g: unknown) => Math.max(num(g, 0), 0)) : [],
        }
      : undefined,
    equipamento: list(r.equipamento, (e) => (str(e?.nome, 60) ? { nome: str(e.nome, 60)!, qtd: Math.max(num(e.qtd, 1), 1), nota: str(e.nota, 120) } : null), 60),
    moedas: r.moedas ? { po: Math.max(num(r.moedas.po, 0), 0), pp: Math.max(num(r.moedas.pp, 0), 0), pc: Math.max(num(r.moedas.pc, 0), 0) } : undefined,
    notas: str(r.notas, 2000),
    pendencias: Array.isArray(r.pendencias) ? r.pendencias.map((p: unknown) => str(p, 200)).filter((p: string | undefined): p is string => Boolean(p)).slice(0, 20) : undefined,
    atualizadoEm: typeof r.atualizadoEm === "string" && !Number.isNaN(Date.parse(r.atualizadoEm)) ? r.atualizadoEm : new Date(0).toISOString(),
  };
}

