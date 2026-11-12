import { MesaError } from "./errors.js";
import { normalize } from "./grid.js";
import type { Combat, Combatant, CombatSide } from "./protocol.js";

export interface NewCombatant {
  nome: string;
  iniciativa: number;
  pv: number;
  pv_max?: number;
  ca?: number;
  lado?: CombatSide;
  token?: string;
  jogador?: string;
}

function makeCombatant(input: NewCombatant, existing: Combatant[]): Combatant {
  const name = input.nome.trim().slice(0, 40);
  if (!name) throw new MesaError("BAD_REQUEST", "Todo combatente precisa de nome.");
  if (existing.some((c) => normalize(c.nome) === normalize(name))) {
    throw new MesaError("BAD_REQUEST", `Já existe um combatente chamado "${name}".`);
  }
  const max = Math.max(1, Math.trunc(input.pv_max ?? input.pv));
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    nome: name,
    iniciativa: Math.trunc(input.iniciativa),
    pv: Math.min(Math.max(Math.trunc(input.pv), 0), max),
    pvMax: max,
    ca: input.ca === undefined ? undefined : Math.trunc(input.ca),
    lado: input.lado ?? "inimigo",
    token: input.token?.trim() || undefined,
    jogador: input.jogador?.trim() || undefined,
    condicoes: [],
  };
}

/** Ordem de iniciativa: maior primeiro; empate fica com quem é jogador, depois ordem de entrada. */
function sortOrder(list: Combatant[]): Combatant[] {
  const sideRank = (c: Combatant) => (c.lado === "jogador" ? 0 : c.lado === "aliado" ? 1 : 2);
  return list
    .map((c, index) => ({ c, index }))
    .sort((a, b) => b.c.iniciativa - a.c.iniciativa || sideRank(a.c) - sideRank(b.c) || a.index - b.index)
    .map(({ c }) => c);
}

export function startCombat(list: NewCombatant[]): Combat {
  if (list.length === 0) throw new MesaError("BAD_REQUEST", "Informe pelo menos um combatente.");
  const combatants: Combatant[] = [];
  for (const input of list) combatants.push(makeCombatant(input, combatants));
  return { rodada: 1, vez: 0, combatentes: sortOrder(combatants) };
}

export function addCombatants(combat: Combat, list: NewCombatant[]): Combat {
  const current = combat.combatentes[combat.vez];
  const combatants = [...combat.combatentes];
  for (const input of list) combatants.push(makeCombatant(input, combatants));
  const sorted = sortOrder(combatants);
  return { ...combat, combatentes: sorted, vez: current ? sorted.findIndex((c) => c.id === current.id) : 0 };
}

export function findCombatant(combat: Combat, name: string): Combatant {
  const key = normalize(name);
  const exact = combat.combatentes.find((c) => normalize(c.nome) === key);
  if (exact) return exact;
  const partial = combat.combatentes.filter((c) => normalize(c.nome).includes(key));
  if (partial.length === 1) return partial[0]!;
  const names = combat.combatentes.map((c) => c.nome).join(", ");
  throw new MesaError(partial.length > 1 ? "TOKEN_AMBIGUOUS" : "TOKEN_NOT_FOUND", `Não achei um combatente só chamado "${name}". No combate: ${names}.`);
}

/** Passa a vez, pulando inimigos caídos. Volta a rodada quando chega ao fim. */
export function nextTurn(combat: Combat): Combat {
  const total = combat.combatentes.length;
  let vez = combat.vez;
  let rodada = combat.rodada;
  for (let step = 0; step < total; step++) {
    vez++;
    if (vez >= total) {
      vez = 0;
      rodada++;
    }
    const c = combat.combatentes[vez]!;
    // Jogador caído ainda tem vez (testes de morte); inimigo caído não.
    if (c.pv > 0 || c.lado === "jogador") break;
  }
  return { ...combat, vez, rodada };
}

export interface CombatantChange {
  /** Dano (negativo) ou cura (positivo). */
  pv_delta?: number;
  pv?: number;
  adicionar_condicao?: string;
  remover_condicao?: string;
  remover?: boolean;
}

export function changeCombatant(combat: Combat, name: string, change: CombatantChange): { combat: Combat; c: Combatant | null; note: string } {
  const target = findCombatant(combat, name);
  if (change.remover) {
    const current = combat.combatentes[combat.vez];
    const combatentes = combat.combatentes.filter((c) => c.id !== target.id);
    let vez = current ? combatentes.findIndex((c) => c.id === current.id) : 0;
    if (vez < 0) vez = Math.min(combat.vez, Math.max(combatentes.length - 1, 0));
    return { combat: { ...combat, combatentes, vez }, c: null, note: `${target.nome} saiu do combate.` };
  }
  const c: Combatant = { ...target, condicoes: [...target.condicoes] };
  const notes: string[] = [];
  if (change.pv !== undefined) c.pv = Math.min(Math.max(Math.trunc(change.pv), 0), c.pvMax);
  if (change.pv_delta !== undefined) c.pv = Math.min(Math.max(c.pv + Math.trunc(change.pv_delta), 0), c.pvMax);
  if (change.pv !== undefined || change.pv_delta !== undefined) {
    notes.push(`PV ${target.pv} → ${c.pv}/${c.pvMax}`);
    if (c.pv === 0 && target.pv > 0) notes.push(c.lado === "jogador" ? "CAIU: inconsciente, faz testes de morte" : "CAIU");
  }
  const add = change.adicionar_condicao?.trim();
  if (add && !c.condicoes.some((x) => normalize(x) === normalize(add))) {
    c.condicoes.push(add.slice(0, 30));
    notes.push(`+${add}`);
  }
  const rem = change.remover_condicao?.trim();
  if (rem) {
    const before = c.condicoes.length;
    c.condicoes = c.condicoes.filter((x) => normalize(x) !== normalize(rem));
    if (c.condicoes.length < before) notes.push(`-${rem}`);
  }
  const combatentes = combat.combatentes.map((x) => (x.id === c.id ? c : x));
  return { combat: { ...combat, combatentes }, c, note: `${c.nome}: ${notes.join("; ") || "sem mudança"}.` };
}

/** Estado do PV em palavras, para não revelar números de inimigos. */
export function healthWord(c: Combatant): string {
  if (c.pv <= 0) return "caído";
  const ratio = c.pv / c.pvMax;
  if (ratio >= 1) return "ileso";
  if (ratio > 0.5) return "ferido";
  return "muito ferido";
}

export function describeCombat(combat: Combat): string {
  const lines = [`Rodada ${combat.rodada}.`];
  combat.combatentes.forEach((c, index) => {
    const turn = index === combat.vez ? "▶ " : "  ";
    const ca = c.ca === undefined ? "" : `, CA ${c.ca}`;
    const cond = c.condicoes.length ? `, ${c.condicoes.join(", ")}` : "";
    const token = (c.token ? `, token "${c.token}"` : "") + (c.jogador ? `, jogador ${c.jogador}` : "");
    lines.push(`${turn}${c.iniciativa} ${c.nome} (${c.lado}): PV ${c.pv}/${c.pvMax}${ca}${cond}${token}`);
  });
  return lines.join("\n");
}
