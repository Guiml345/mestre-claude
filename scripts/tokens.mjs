// Gera tokens redondos (PNG) a partir dos ícones do game-icons.net em icons/.
// Saída: extension/public/tokens/<autor>/<nome>.png, publicada junto com a extensão.
// Uso: npm run build:tokens   (só refaz os que faltam; --todos refaz tudo)
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "icons", "ffffff", "000000", "1x1");
const output = path.join(root, "extension", "public", "tokens");
const redoAll = process.argv.includes("--todos");

const SIZE = 256;

/** Disco escuro com aro dourado e o desenho do ícone em branco no meio. */
function tokenSvg(iconSvg) {
  const inner = iconSvg
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    // O primeiro caminho é o fundo quadrado preto: sai.
    .replace(/<path d="M0 0h512v512H0z"\/>/, "");
  const glyph = 150;
  const offset = (SIZE - glyph) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <circle cx="${SIZE / 2}" cy="${SIZE / 2}" r="${SIZE / 2 - 6}" fill="#2b2f3a" stroke="#c9a14a" stroke-width="10"/>
  <svg x="${offset}" y="${offset}" width="${glyph}" height="${glyph}" viewBox="0 0 512 512">${inner}</svg>
</svg>`;
}

async function exists(file) {
  return stat(file).then(
    () => true,
    () => false,
  );
}

const authors = (await readdir(source, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
let made = 0;
let skipped = 0;
for (const author of authors) {
  const files = (await readdir(path.join(source, author))).filter((f) => f.endsWith(".svg"));
  await mkdir(path.join(output, author), { recursive: true });
  for (const file of files) {
    const target = path.join(output, author, file.replace(/\.svg$/, ".png"));
    if (!redoAll && (await exists(target))) {
      skipped++;
      continue;
    }
    const svg = await readFile(path.join(source, author, file), "utf8");
    await sharp(Buffer.from(tokenSvg(svg))).png({ compressionLevel: 9, palette: true }).toFile(target);
    made++;
  }
}

// Créditos junto dos tokens publicados (exigência da licença CC BY 3.0).
await writeFile(path.join(output, "CREDITOS.txt"), await readFile(path.join(root, "icons", "license.txt")));
console.log(`Tokens: ${made} gerados, ${skipped} já existiam (${authors.length} autores).`);
