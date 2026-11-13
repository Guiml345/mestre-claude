import path from "node:path";
import sharp from "sharp";

/**
 * Folha de conferência: vários ícones do catálogo lado a lado, numerados e com o
 * nome embaixo, para conferir de uma vez como cada um fica antes de usar.
 */

const TILE = 160;
const LABEL = 28;
const COLUMNS = 6;

function escapeXml(text: string): string {
  return text.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
}

/** `icons` em "autor/nome"; `labels` (opcional) troca o texto embaixo de cada um. */
export async function contactSheet(tokensDir: string, icons: string[], labels?: string[]): Promise<{ image: Buffer; missing: string[] }> {
  const tiles: sharp.OverlayOptions[] = [];
  const missing: string[] = [];
  let index = 0;
  for (const [i, icon] of icons.entries()) {
    const file = path.join(tokensDir, `${icon}.png`);
    const image = await sharp(file).resize(TILE, TILE).png().toBuffer().catch(() => null);
    if (!image) {
      missing.push(icon);
      continue;
    }
    const x = (index % COLUMNS) * TILE;
    const y = Math.floor(index / COLUMNS) * (TILE + LABEL);
    index++;
    const text = escapeXml(`${index}. ${labels?.[i] ?? icon.split("/")[1] ?? icon}`).slice(0, 40);
    tiles.push({ input: image, left: x, top: y });
    tiles.push({
      input: Buffer.from(`<svg width="${TILE}" height="${LABEL}"><rect width="100%" height="100%" fill="white"/><text x="4" y="19" font-size="13" font-family="Arial">${text}</text></svg>`),
      left: x,
      top: y + TILE,
    });
  }
  const rows = Math.max(1, Math.ceil(index / COLUMNS));
  const image = await sharp({ create: { width: COLUMNS * TILE, height: rows * (TILE + LABEL), channels: 3, background: "white" } })
    .composite(tiles)
    .png()
    .toBuffer();
  return { image, missing };
}
