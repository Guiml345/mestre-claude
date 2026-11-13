import sharp from "sharp";
import { MesaError, errorMessage } from "./errors.js";
import { TOKEN_LAYERS, bounds, displayName, footprint } from "./grid.js";
import type { GridInfo, RawItem } from "./protocol.js";

/** Lado maior da imagem devolvida: bom para o Claude ler sem gastar demais. */
const MAX_SIDE = 1568;
const imageCache = new Map<string, Buffer>();

export interface MapArea {
  col: number;
  row: number;
  w: number;
  h: number;
}

export interface MapView {
  image: Buffer;
  mimeType: "image/jpeg";
  /** Área mostrada, em casas. */
  area: MapArea;
  pxPerCell: number;
  mapName: string;
}

async function download(url: string): Promise<Buffer> {
  const cached = imageCache.get(url);
  if (cached) return cached;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MesaError("MAP_UNAVAILABLE", "O mapa não tem um endereço de imagem válido.");
  }
  // Só baixa do armazenamento de imagens do Owlbear.
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith("owlbear.rodeo")) {
    throw new MesaError("MAP_UNAVAILABLE", `A imagem do mapa está fora do Owlbear (${parsed.hostname}); não baixo de outros sites.`);
  }
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new MesaError("MAP_UNAVAILABLE", `Não consegui baixar a imagem do mapa: ${errorMessage(err)}`);
  }
  if (!response.ok) throw new MesaError("MAP_UNAVAILABLE", `O Owlbear recusou a imagem do mapa (HTTP ${response.status}).`);
  const buffer = Buffer.from(await response.arrayBuffer());
  imageCache.clear();
  imageCache.set(url, buffer);
  return buffer;
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** Desenha a grade numerada e os tokens por cima de um pedaço do mapa. */
function overlaySvg(
  width: number,
  height: number,
  area: MapArea,
  cell: number,
  tokens: Array<{ label: string; col: number; row: number; w: number; h: number; hidden: boolean }>,
): string {
  const parts: string[] = [];
  const font = Math.max(9, Math.min(16, Math.round(cell * 0.32)));
  // Linhas da grade: cada 5ª casa mais forte.
  for (let i = 0; i <= area.w; i++) {
    const x = Math.round(i * cell);
    const strong = (area.col + i) % 5 === 0;
    parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="${strong ? "#ff0" : "#fff"}" stroke-opacity="${strong ? 0.55 : 0.3}" stroke-width="${strong ? 2 : 1}"/>`);
  }
  for (let j = 0; j <= area.h; j++) {
    const y = Math.round(j * cell);
    const strong = (area.row + j) % 5 === 0;
    parts.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="${strong ? "#ff0" : "#fff"}" stroke-opacity="${strong ? 0.55 : 0.3}" stroke-width="${strong ? 2 : 1}"/>`);
  }
  // Números das colunas (em cima) e das linhas (à esquerda).
  for (let i = 0; i < area.w; i++) {
    const x = (i + 0.5) * cell;
    parts.push(`<rect x="${x - font * 0.9}" y="1" width="${font * 1.8}" height="${font + 4}" fill="#000" fill-opacity="0.7" rx="3"/>`);
    parts.push(`<text x="${x}" y="${font + 1}" font-size="${font}" fill="#fff" text-anchor="middle" font-family="Arial" font-weight="bold">${area.col + i}</text>`);
  }
  for (let j = 0; j < area.h; j++) {
    const y = (j + 0.5) * cell;
    parts.push(`<rect x="1" y="${y - font * 0.65}" width="${font * 1.8}" height="${font + 4}" fill="#000" fill-opacity="0.7" rx="3"/>`);
    parts.push(`<text x="${1 + font * 0.9}" y="${y + font * 0.4}" font-size="${font}" fill="#0ff" text-anchor="middle" font-family="Arial" font-weight="bold">${area.row + j}</text>`);
  }
  // Tokens: contorno e nome.
  for (const token of tokens) {
    const x = (token.col - area.col) * cell;
    const y = (token.row - area.row) * cell;
    const color = token.hidden ? "#f0f" : "#f33";
    parts.push(`<rect x="${x + 2}" y="${y + 2}" width="${token.w * cell - 4}" height="${token.h * cell - 4}" fill="none" stroke="${color}" stroke-width="3" rx="6"/>`);
    const label = escapeXml(token.label + (token.hidden ? " (oculto)" : ""));
    parts.push(`<text x="${x + (token.w * cell) / 2}" y="${y + token.h * cell + font}" font-size="${font}" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke" text-anchor="middle" font-family="Arial" font-weight="bold">${label}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("")}</svg>`;
}

/**
 * Mostra o mapa da cena (ou um pedaço dele) com a grade numerada e os tokens.
 * Funciona em grade quadrada, com o mapa girado de 90 em 90 graus (ou sem rotação).
 */
export async function renderMap(items: RawItem[], grid: GridInfo, wanted?: MapArea): Promise<MapView> {
  const maps = items.filter((item) => item.layer === "MAP" && item.image && item.grid);
  if (maps.length === 0) throw new MesaError("MAP_UNAVAILABLE", "A cena não tem uma imagem de mapa.");
  // O maior mapa da cena é o principal.
  const map = maps.sort((a, b) => footprint(b, grid).w * footprint(b, grid).h - footprint(a, grid).w * footprint(a, grid).h)[0]!;
  const rotation = (((map.rotation || 0) % 360) + 360) % 360;
  if (rotation % 90 !== 0) throw new MesaError("MAP_UNAVAILABLE", `O mapa está girado ${rotation}°; só sei desenhar a grade em mapas girados de 90 em 90 graus.`);

  const mapFp = footprint(map, grid);
  const area: MapArea = wanted
    ? {
        col: Math.max(mapFp.col, wanted.col),
        row: Math.max(mapFp.row, wanted.row),
        w: Math.min(mapFp.col + mapFp.w, wanted.col + wanted.w) - Math.max(mapFp.col, wanted.col),
        h: Math.min(mapFp.row + mapFp.h, wanted.row + wanted.h) - Math.max(mapFp.row, wanted.row),
      }
    : { col: mapFp.col, row: mapFp.row, w: mapFp.w, h: mapFp.h };
  if (area.w <= 0 || area.h <= 0) {
    throw new MesaError("BAD_REQUEST", `Essa área fica fora do mapa (colunas ${mapFp.col} a ${mapFp.col + mapFp.w - 1}, linhas ${mapFp.row} a ${mapFp.row + mapFp.h - 1}).`);
  }

  // Gira a imagem como o Owlbear mostra; aí o retângulo da cena (bounds) cobre a imagem
  // inteira e a conversão de pixel da cena para pixel da imagem é só uma escala.
  const raw = await download(map.image!.url);
  const source = rotation ? await sharp(raw).rotate(rotation).toBuffer() : raw;
  const meta = await sharp(source).metadata();
  const b = bounds(map, grid);
  const imgW = meta.width ?? Math.round(b.x1 - b.x0);
  const imgH = meta.height ?? Math.round(b.y1 - b.y0);
  const fx = imgW / (b.x1 - b.x0);
  const fy = imgH / (b.y1 - b.y0);
  const toImgX = (sceneX: number) => (sceneX - b.x0) * fx;
  const toImgY = (sceneY: number) => (sceneY - b.y0) * fy;

  const left = Math.max(0, Math.round(toImgX(area.col * grid.dpi)));
  const top = Math.max(0, Math.round(toImgY(area.row * grid.dpi)));
  const right = Math.min(imgW, Math.round(toImgX((area.col + area.w) * grid.dpi)));
  const bottom = Math.min(imgH, Math.round(toImgY((area.row + area.h) * grid.dpi)));

  const ratio = Math.min(1, MAX_SIDE / Math.max(right - left, bottom - top));
  const outW = Math.round((right - left) * ratio);
  const outH = Math.round((bottom - top) * ratio);
  const cell = outW / area.w;

  const tokens = items
    .filter((item) => TOKEN_LAYERS.includes(item.layer) && !item.attachedTo)
    .map((item) => ({ item, fp: footprint(item, grid) }))
    .filter(({ fp }) => fp.col + fp.w > area.col && fp.col < area.col + area.w && fp.row + fp.h > area.row && fp.row < area.row + area.h)
    .map(({ item, fp }) => ({ label: displayName(item), col: fp.col, row: fp.row, w: fp.w, h: fp.h, hidden: !item.visible }));

  const image = await sharp(source)
    .extract({ left, top, width: right - left, height: bottom - top })
    .resize(outW, outH)
    .composite([{ input: Buffer.from(overlaySvg(outW, outH, area, cell, tokens)), top: 0, left: 0 }])
    .jpeg({ quality: 82 })
    .toBuffer();

  return { image, mimeType: "image/jpeg", area, pxPerCell: cell, mapName: displayName(map) };
}
