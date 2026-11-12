// Serve a mesa simulada (um "Owlbear de mentira") para testar a extensão sem entrar numa sala real.
// Uso: npm run simulador   → abre em http://localhost:7421
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const port = Number.parseInt(process.env.SIMULADOR_PORT ?? "", 10) || 7421;

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname !== "/" && pathname !== "/index.html") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Não encontrado.");
    return;
  }
  try {
    const page = await readFile(path.join(dir, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(page);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end(String(err));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Mesa simulada em http://localhost:${port}  (Ctrl+C para sair)`);
});
