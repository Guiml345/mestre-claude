import { MesaError } from "./errors.js";
import type { GridInfo, RawItem } from "./protocol.js";

/** Camadas tratadas como "tokens" quando se procura por nome. */
export const TOKEN_LAYERS = ["CHARACTER", "MOUNT", "PROP"];
/** Camadas cujos tokens ocupam espaço (bloqueiam uma casa). */
export const BLOCKING_LAYERS = ["CHARACTER", "MOUNT"];

/** Onde um item está na grade. `col`/`row` são a casa do canto superior esquerdo. */
export interface Footprint {
  col: number;
  row: number;
  /** Largura e altura em casas (mínimo 1). */
  w: number;
  h: number;
  centerX: number;
  centerY: number;
}

/** Evita o "-0" que o JavaScript produz ao arredondar. */
function clean(value: number): number {
  return value === 0 ? 0 : value;
}

export function requireSquare(grid: GridInfo): void {
  if (grid.type !== "SQUARE") {
    throw new MesaError(
      "GRID_UNSUPPORTED",
      `A cena usa grade ${grid.type}. Por enquanto só consigo mover tokens por casas em grade quadrada.`,
    );
  }
}

/**
 * Calcula a área que um item ocupa na grade.
 * A posição de uma imagem no Owlbear é a âncora (`grid.offset`), que pode ser o
 * centro (tokens) ou o canto (mapas), então a conta parte das bordas reais.
 */
/**
 * Retângulo que a imagem ocupa na cena, em pixels, já com escala e rotação.
 * O Owlbear gira a imagem em sentido horário em volta da posição (a âncora).
 */
export function bounds(item: RawItem, grid: GridInfo): { x0: number; y0: number; x1: number; y1: number } {
  if (!item.image || !item.grid || item.grid.dpi <= 0) {
    const half = grid.dpi / 2;
    return { x0: item.position.x - half, y0: item.position.y - half, x1: item.position.x + half, y1: item.position.y + half };
  }
  const k = grid.dpi / item.grid.dpi;
  // Cantos da imagem em relação à âncora, já na escala da cena.
  const left = -item.grid.offset.x * k * item.scale.x;
  const right = (item.image.width - item.grid.offset.x) * k * item.scale.x;
  const top = -item.grid.offset.y * k * item.scale.y;
  const bottom = (item.image.height - item.grid.offset.y) * k * item.scale.y;
  const rad = ((item.rotation || 0) * Math.PI) / 180;
  // Rotações de 90 em 90 dão números exatos (sem 1e-13 de seno e cosseno).
  const exact = (v: number) => (Math.abs(v) < 1e-9 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-9 ? Math.sign(v) : v);
  const cos = exact(Math.cos(rad));
  const sin = exact(Math.sin(rad));
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [[left, top], [right, top], [left, bottom], [right, bottom]] as const) {
    xs.push(item.position.x + x * cos - y * sin);
    ys.push(item.position.y + x * sin + y * cos);
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

export function footprint(item: RawItem, grid: GridInfo): Footprint {
  const dpi = grid.dpi;
  const b = bounds(item, grid);
  const centerX = (b.x0 + b.x1) / 2;
  const centerY = (b.y0 + b.y1) / 2;
  const widthPx = b.x1 - b.x0;
  const heightPx = b.y1 - b.y0;

  const w = Math.max(1, Math.round(widthPx / dpi));
  const h = Math.max(1, Math.round(heightPx / dpi));
  return {
    col: clean(Math.round((centerX - (w * dpi) / 2) / dpi)),
    row: clean(Math.round((centerY - (h * dpi) / 2) / dpi)),
    w,
    h,
    centerX,
    centerY,
  };
}

/** Posição (em pixels da cena) que coloca o item com o canto superior esquerdo na casa pedida. */
export function positionForCell(item: RawItem, grid: GridInfo, col: number, row: number): { x: number; y: number } {
  const fp = footprint(item, grid);
  const targetX = col * grid.dpi + (fp.w * grid.dpi) / 2;
  const targetY = row * grid.dpi + (fp.h * grid.dpi) / 2;
  return {
    x: item.position.x + (targetX - fp.centerX),
    y: item.position.y + (targetY - fp.centerY),
  };
}

/** Nome para mostrar: o rótulo do token, se tiver, senão o nome da imagem. */
export function displayName(item: RawItem): string {
  return item.text?.trim() || item.name?.trim() || "sem nome";
}

/** Tira acentos, caixa e espaços extras para comparar nomes. */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function describeCandidate(item: RawItem, grid?: GridInfo): string {
  const where = grid ? ` na casa (${footprint(item, grid).col}, ${footprint(item, grid).row})` : "";
  return `"${displayName(item)}"${where} [id ${item.id.slice(0, 8)}]`;
}

/**
 * Acha um token pelo que o mestre escreveu: id (ou começo do id), rótulo ou nome.
 * Ignora acentos e maiúsculas. Dá erro se não achar ou se houver mais de um.
 */
export function resolveToken(items: RawItem[], query: string, grid?: GridInfo): RawItem {
  const wanted = query.trim();
  if (!wanted) throw new MesaError("TOKEN_NOT_FOUND", "Faltou dizer qual token.");

  const exactId = items.find((item) => item.id === wanted);
  if (exactId) return exactId;

  const tokens = items.filter((item) => TOKEN_LAYERS.includes(item.layer));
  const key = normalize(wanted);
  const stages: Array<(item: RawItem) => boolean> = [
    (item) => normalize(item.text ?? "") === key,
    (item) => normalize(item.name ?? "") === key,
    (item) => wanted.length >= 6 && item.id.startsWith(wanted),
    (item) => normalize(item.text ?? "").includes(key) || normalize(item.name ?? "").includes(key),
  ];

  for (const matches of stages) {
    const found = tokens.filter(matches);
    if (found.length === 1) return found[0]!;
    if (found.length > 1) {
      throw new MesaError(
        "TOKEN_AMBIGUOUS",
        `Há ${found.length} tokens que batem com "${query}": ${found
          .map((item) => describeCandidate(item, grid))
          .join("; ")}. Use o id para escolher.`,
      );
    }
  }

  const available = tokens.length
    ? `Tokens na cena: ${tokens.map((item) => describeCandidate(item, grid)).join("; ")}.`
    : "Não há tokens na cena.";
  throw new MesaError("TOKEN_NOT_FOUND", `Não achei nenhum token chamado "${query}". ${available}`);
}

function overlaps(a: { col: number; row: number; w: number; h: number }, b: Footprint): boolean {
  return a.col < b.col + b.w && a.col + a.w > b.col && a.row < b.row + b.h && a.row + a.h > b.row;
}

/** Verdadeiro quando os dois ocupam casas vizinhas (inclusive na diagonal) sem se sobrepor. */
export function isAdjacent(a: Footprint, b: Footprint): boolean {
  if (overlaps(a, b)) return false;
  return a.col <= b.col + b.w && a.col + a.w >= b.col && a.row <= b.row + b.h && a.row + a.h >= b.row;
}

/** Tokens que ocupam alguma casa da área dada. */
export function occupants(area: { col: number; row: number; w: number; h: number }, items: RawItem[], grid: GridInfo, ignoreIds: string[] = []): RawItem[] {
  return items.filter(
    (item) =>
      BLOCKING_LAYERS.includes(item.layer) &&
      !item.attachedTo &&
      !ignoreIds.includes(item.id) &&
      overlaps(area, footprint(item, grid)),
  );
}

/**
 * Escolhe a casa livre vizinha ao alvo mais próxima de onde o token está.
 * Não calcula caminho nem enxerga paredes.
 */
export function adjacentCell(
  mover: RawItem,
  target: RawItem,
  items: RawItem[],
  grid: GridInfo,
): { col: number; row: number; already: boolean } {
  const m = footprint(mover, grid);
  const t = footprint(target, grid);
  if (isAdjacent(m, t)) return { col: m.col, row: m.row, already: true };

  let best: { col: number; row: number; steps: number; straight: number } | null = null;
  for (let col = t.col - m.w; col <= t.col + t.w; col++) {
    for (let row = t.row - m.h; row <= t.row + t.h; row++) {
      const area = { col, row, w: m.w, h: m.h };
      if (overlaps(area, t)) continue;
      if (occupants(area, items, grid, [mover.id, target.id]).length > 0) continue;
      const dc = col - m.col;
      const dr = row - m.row;
      const steps = Math.max(Math.abs(dc), Math.abs(dr));
      const straight = dc * dc + dr * dr;
      if (!best || steps < best.steps || (steps === best.steps && straight < best.straight)) {
        best = { col, row, steps, straight };
      }
    }
  }

  if (!best) {
    throw new MesaError("NO_SPACE", `Não há casa livre ao lado de "${displayName(target)}".`);
  }
  return { col: best.col, row: best.row, already: false };
}

/**
 * Casas livres para colocar `count` cópias de `model` em volta de `anchor`,
 * da mais próxima para a mais distante. Não enxerga paredes.
 */
export function freeCellsAround(
  model: RawItem,
  anchor: RawItem,
  count: number,
  items: RawItem[],
  grid: GridInfo,
  bounds?: { col: number; row: number; w: number; h: number },
): Array<{ col: number; row: number }> {
  const m = footprint(model, grid);
  const a = footprint(anchor, grid);
  const taken: Footprint[] = items
    .filter((item) => BLOCKING_LAYERS.includes(item.layer) && !item.attachedTo)
    .map((item) => footprint(item, grid));
  const chosen: Array<{ col: number; row: number }> = [];

  const inside = (col: number, row: number) =>
    !bounds || (col >= bounds.col && row >= bounds.row && col + m.w <= bounds.col + bounds.w && row + m.h <= bounds.row + bounds.h);

  for (let ring = 1; ring <= 20 && chosen.length < count; ring++) {
    const candidates: Array<{ col: number; row: number; d: number }> = [];
    for (let col = a.col - m.w - ring + 1; col <= a.col + a.w + ring - 1; col++) {
      for (let row = a.row - m.h - ring + 1; row <= a.row + a.h + ring - 1; row++) {
        // Só as casas exatamente neste anel, para crescer em volta do alvo.
        const gapX = Math.max(a.col - (col + m.w), col - (a.col + a.w), -1) + 1;
        const gapY = Math.max(a.row - (row + m.h), row - (a.row + a.h), -1) + 1;
        if (Math.max(gapX, gapY) !== ring) continue;
        candidates.push({ col, row, d: (col - a.col) ** 2 + (row - a.row) ** 2 });
      }
    }
    candidates.sort((x, y) => x.d - y.d || x.row - y.row || x.col - y.col);
    for (const cell of candidates) {
      if (chosen.length >= count) break;
      const area = { col: cell.col, row: cell.row, w: m.w, h: m.h, centerX: 0, centerY: 0 };
      if (!inside(cell.col, cell.row)) continue;
      if (taken.some((fp) => overlaps(area, fp))) continue;
      chosen.push({ col: cell.col, row: cell.row });
      taken.push(area);
    }
  }

  if (chosen.length < count) {
    throw new MesaError("NO_SPACE", `Só achei ${chosen.length} casa(s) livre(s) perto de "${displayName(anchor)}".`);
  }
  return chosen;
}

/** Distância em casas entre duas casas, seguindo a regra de medição da sala. */
export function cellDistance(dCol: number, dRow: number, measurement: string): number {
  const a = Math.abs(dCol);
  const b = Math.abs(dRow);
  switch (measurement) {
    case "MANHATTAN":
      return a + b;
    case "EUCLIDEAN":
      return Math.sqrt(a * a + b * b);
    case "ALTERNATING": {
      const diagonal = Math.min(a, b);
      return Math.max(a, b) + Math.floor(diagonal / 2);
    }
    default:
      return Math.max(a, b);
  }
}

function formatNumber(value: number, digits: number): string {
  return Number(value.toFixed(Math.max(digits, 0))).toLocaleString("pt-BR");
}

/** Ex.: "3 casas (15ft)". */
export function formatDistance(cells: number, grid: GridInfo): string {
  const shown = formatNumber(cells, 1);
  const label = `${shown} ${cells === 1 ? "casa" : "casas"}`;
  const { multiplier, unit, digits } = grid.scale;
  if (!Number.isFinite(multiplier) || multiplier <= 0) return label;
  return `${label} (${formatNumber(cells * multiplier, Math.max(digits, 1))}${unit})`;
}

const GRID_TYPES: Record<string, string> = {
  SQUARE: "quadrada",
  HEX_VERTICAL: "hexagonal vertical",
  HEX_HORIZONTAL: "hexagonal horizontal",
  DIMETRIC: "dimétrica",
  ISOMETRIC: "isométrica",
};

const MEASUREMENTS: Record<string, string> = {
  CHEBYSHEV: "diagonal conta 1 casa",
  ALTERNATING: "diagonais alternam 1 e 2 casas",
  EUCLIDEAN: "distância real em linha reta",
  MANHATTAN: "diagonal conta 2 casas",
};

export function describeGrid(grid: GridInfo): string {
  const type = GRID_TYPES[grid.type] ?? grid.type;
  const measurement = MEASUREMENTS[grid.measurement] ?? grid.measurement;
  return `grade ${type}, 1 casa = ${grid.scale.raw} (${grid.dpi} px), ${measurement}`;
}
