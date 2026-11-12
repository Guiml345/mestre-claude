import { randomInt } from "node:crypto";
import { MesaError } from "./errors.js";

/** Devolve um inteiro de 1 até `sides`. Trocável nos testes. */
export type Rng = (sides: number) => number;

/** Dado justo, usando o gerador criptográfico do sistema. */
export const cryptoRng: Rng = (sides) => randomInt(1, sides + 1);

export type KeepMode = "kh" | "kl" | "dh" | "dl";

export interface DiceTerm {
  kind: "dice";
  sign: 1 | -1;
  count: number;
  sides: number;
  keep?: { mode: KeepMode; n: number };
}

export interface ConstTerm {
  kind: "const";
  sign: 1 | -1;
  value: number;
}

export type Term = DiceTerm | ConstTerm;

export const DICE_LIMITS = { terms: 20, count: 100, sides: 1000, constant: 100_000 } as const;

const EXAMPLES = "Exemplos válidos: 1d20+5, 2d6+3, 4d6kh3, d100, 1d8+1d6-1.";

function bad(message: string): MesaError {
  return new MesaError("BAD_DICE", `${message} ${EXAMPLES}`);
}

/**
 * Lê uma expressão de dados.
 * Aceita somas e subtrações de dados e números, e os sufixos
 * kh/kl (mantém os N maiores/menores) e dh/dl (descarta os N maiores/menores).
 */
export function parseDice(input: string): Term[] {
  const text = input
    .toLowerCase()
    .replace(/[−–—]/g, "-")
    .trim();
  if (!text) throw bad("Expressão de dados vazia.");

  // Espaços só são aceitos em volta dos sinais: "1d20 5" é erro, não "1d205".
  const re = /\s*([+-])?\s*(?:(\d*)d(\d+|%)(?:(kh|kl|dh|dl|k)(\d+))?|(\d+))\s*/y;
  const terms: Term[] = [];
  let pos = 0;

  while (pos < text.length) {
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) throw bad(`Não entendi "${input}" (problema em "${text.slice(pos)}").`);
    const [whole, signChar, countText, sidesText, keepText, keepCount, constText] = m;

    if (terms.length > 0 && !signChar) {
      throw bad(`Faltou um + ou - antes de "${text.slice(pos)}" em "${input}".`);
    }
    if (terms.length >= DICE_LIMITS.terms) {
      throw bad(`Expressão longa demais (máximo de ${DICE_LIMITS.terms} termos).`);
    }
    const sign: 1 | -1 = signChar === "-" ? -1 : 1;

    if (constText !== undefined) {
      const value = Number.parseInt(constText, 10);
      if (value > DICE_LIMITS.constant) {
        throw bad(`Número grande demais: ${constText} (máximo ${DICE_LIMITS.constant}).`);
      }
      terms.push({ kind: "const", sign, value });
    } else {
      const count = countText ? Number.parseInt(countText, 10) : 1;
      const sides = sidesText === "%" ? 100 : Number.parseInt(sidesText ?? "", 10);
      if (count < 1 || count > DICE_LIMITS.count) {
        throw bad(`Quantidade de dados inválida: ${count} (de 1 a ${DICE_LIMITS.count}).`);
      }
      if (sides < 2 || sides > DICE_LIMITS.sides) {
        throw bad(`Dado inválido: d${sides} (de d2 a d${DICE_LIMITS.sides}).`);
      }
      const term: DiceTerm = { kind: "dice", sign, count, sides };
      if (keepText) {
        const mode: KeepMode = keepText === "k" ? "kh" : (keepText as KeepMode);
        const n = Number.parseInt(keepCount ?? "", 10);
        const max = mode === "kh" || mode === "kl" ? count : count - 1;
        if (n < 1 || n > max) {
          throw bad(`"${keepText}${keepCount}" não faz sentido com ${count}d${sides}.`);
        }
        term.keep = { mode, n };
      }
      terms.push(term);
    }
    pos += whole.length;
  }

  return terms;
}

export function formatExpression(terms: Term[]): string {
  return terms
    .map((term, index) => {
      const sign = term.sign < 0 ? "-" : index === 0 ? "" : "+";
      if (term.kind === "const") return `${sign}${term.value}`;
      const keep = term.keep ? `${term.keep.mode}${term.keep.n}` : "";
      return `${sign}${term.count}d${term.sides}${keep}`;
    })
    .join("");
}

export interface RolledDie {
  value: number;
  /** Falso quando o dado foi descartado (vantagem, kh/kl etc.). */
  kept: boolean;
}

export type RolledTerm =
  | (DiceTerm & { rolls: RolledDie[]; subtotal: number })
  | (ConstTerm & { subtotal: number });

export type RollMode = "normal" | "vantagem" | "desvantagem";

export interface RollOptions {
  mode?: RollMode;
  /** Acerto crítico: rola duas vezes cada dado (use em rolagens de dano). */
  critical?: boolean;
  rng?: Rng;
}

export interface RollResult {
  /** Expressão como foi pedida. */
  input: string;
  /** Expressão como foi rolada, já com vantagem/crítico aplicados. */
  expression: string;
  terms: RolledTerm[];
  total: number;
  /** Dados que saíram, ex.: "[17, (4)] + 5". Entre parênteses, os descartados. */
  breakdown: string;
  /** Valor natural do d20 que contou, quando a rolagem tem exatamente um. */
  d20: number | null;
}

function applyMode(terms: Term[], mode: RollMode): Term[] {
  if (mode === "normal") return terms;
  const index = terms.findIndex(
    (term) => term.kind === "dice" && term.sides === 20 && term.count === 1 && !term.keep && term.sign === 1,
  );
  if (index < 0) {
    throw new MesaError(
      "BAD_DICE",
      "Vantagem e desvantagem só valem para uma rolagem com um único d20 (ex.: 1d20+5).",
    );
  }
  return terms.map((term, i) =>
    i === index && term.kind === "dice"
      ? { ...term, count: 2, keep: { mode: mode === "vantagem" ? "kh" : "kl", n: 1 } }
      : term,
  );
}

function applyCritical(terms: Term[]): Term[] {
  return terms.map((term) => {
    if (term.kind !== "dice") return term;
    const doubled: DiceTerm = { ...term, count: term.count * 2 };
    if (term.keep) doubled.keep = { mode: term.keep.mode, n: term.keep.n * 2 };
    return doubled;
  });
}

function markKept(values: number[], keep: DiceTerm["keep"]): RolledDie[] {
  const dice = values.map((value) => ({ value, kept: true }));
  if (!keep) return dice;
  const ascending = dice.map((_, index) => index).sort((a, b) => values[a]! - values[b]! || a - b);
  const descending = dice.map((_, index) => index).sort((a, b) => values[b]! - values[a]! || a - b);
  let dropped: number[];
  switch (keep.mode) {
    case "kh":
      dropped = descending.slice(keep.n);
      break;
    case "kl":
      dropped = ascending.slice(keep.n);
      break;
    case "dh":
      dropped = descending.slice(0, keep.n);
      break;
    case "dl":
      dropped = ascending.slice(0, keep.n);
      break;
  }
  for (const index of dropped) dice[index]!.kept = false;
  return dice;
}

export function roll(input: string, options: RollOptions = {}): RollResult {
  const rng = options.rng ?? cryptoRng;
  let terms = applyMode(parseDice(input), options.mode ?? "normal");
  if (options.critical) terms = applyCritical(terms);

  const totalDice = terms.reduce((sum, term) => sum + (term.kind === "dice" ? term.count : 0), 0);
  if (totalDice > DICE_LIMITS.count * 2) {
    throw bad(`Dados demais numa rolagem só (${totalDice}).`);
  }

  const rolled: RolledTerm[] = terms.map((term) => {
    if (term.kind === "const") return { ...term, subtotal: term.sign * term.value };
    const values = Array.from({ length: term.count }, () => {
      const value = rng(term.sides);
      if (!Number.isInteger(value) || value < 1 || value > term.sides) {
        throw new MesaError("INTERNAL", `O gerador de dados devolveu ${value} para um d${term.sides}.`);
      }
      return value;
    });
    const rolls = markKept(values, term.keep);
    const sum = rolls.reduce((acc, die) => acc + (die.kept ? die.value : 0), 0);
    return { ...term, rolls, subtotal: term.sign * sum };
  });

  const d20Terms = rolled.filter((term) => term.kind === "dice" && term.sides === 20);
  let d20: number | null = null;
  if (d20Terms.length === 1 && d20Terms[0]!.kind === "dice") {
    const kept = d20Terms[0]!.rolls.filter((die) => die.kept);
    if (kept.length === 1) d20 = kept[0]!.value;
  }

  const breakdown = rolled
    .map((term, index) => {
      const sign = term.sign < 0 ? (index === 0 ? "-" : " - ") : index === 0 ? "" : " + ";
      if (term.kind === "const") return `${sign}${term.value}`;
      const dice = term.rolls.map((die) => (die.kept ? String(die.value) : `(${die.value})`)).join(", ");
      return `${sign}[${dice}]`;
    })
    .join("");

  return {
    input,
    expression: formatExpression(terms),
    terms: rolled,
    total: rolled.reduce((sum, term) => sum + term.subtotal, 0),
    breakdown,
    d20,
  };
}
