import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FakeTable, mapItem, token } from "./testing.js";

const ENTRY = fileURLToPath(new URL("./index.js", import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error("tempo esgotado esperando a condição");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function childEnv(port: number, campaignDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.MESA_RPG_PORT = String(port);
  env.MESA_RPG_CAMPANHA = campaignDir;
  return env;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((part) => part.text ?? "").join("\n");
}

describe("servidor MCP", () => {
  it("funciona de ponta a ponta pelo protocolo, com uma mesa simulada", async () => {
    const port = await freePort();
    const campaignDir = await mkdtemp(path.join(os.tmpdir(), "mesa-campanha-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: childEnv(port, campaignDir),
      stderr: "pipe",
    });
    const client = new Client({ name: "teste", version: "0" });
    const table = new FakeTable([
      mapItem("map-0001", "Vila", 20, 14),
      token("aaaaaaaa-1111", "Guilherme", 6, 3),
      token("cccccccc-3333", "Goblin", 1, 3),
    ]);

    try {
      await client.connect(transport);
      assert.match(client.getInstructions() ?? "", /D&D 5\.5/);

      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [
        "aguardar_jogadores",
        "alterar_combatente",
        "anunciar",
        "campanha",
        "criar_token",
        "editar_token",
        "encerrar_combate",
        "focar_camera",
        "iniciar_combate",
        "inventario",
        "listar_tokens",
        "mover_token",
        "nevoa",
        "proximo_turno",
        "remover_token",
        "rolar",
        "status_mesa",
        "ver_combate",
        "ver_mapa",
      ]);
      for (const tool of tools) {
        assert.ok(tool.description && tool.description.length > 40, `${tool.name} sem descrição`);
        assert.equal(tool.inputSchema.type, "object");
      }
      const rolarTool = tools.find((tool) => tool.name === "rolar")!;
      assert.deepEqual(rolarTool.inputSchema.required, ["expressao"]);

      // Sem mesa: rolar funciona, o resto explica como conectar.
      const offlineRoll = await client.callTool({ name: "rolar", arguments: { expressao: "2d6+3", rotulo: "Teste" } });
      assert.ok(!offlineRoll.isError);
      assert.match(textOf(offlineRoll), /🎲 Teste: 2d6\+3 → \[\d, \d\] \+ 3 = \d+/);
      assert.match(textOf(offlineRoll), /nenhuma mesa conectada/);
      const offlineStatus = await client.callTool({ name: "status_mesa", arguments: {} });
      assert.match(textOf(offlineStatus), /Mesa: NÃO conectada/);
      assert.match(textOf(offlineStatus), new RegExp(`localhost:${port}/manifest\\.json`));

      // Argumentos inválidos são recusados pelo esquema, sem derrubar o servidor.
      const invalid = await client.callTool({ name: "rolar", arguments: { expressao: 5 } }).catch((err: unknown) => ({ isError: true, content: [{ type: "text", text: String(err) }] }));
      assert.ok(invalid.isError);
      const badDice = await client.callTool({ name: "rolar", arguments: { expressao: "um dado" } });
      assert.ok(badDice.isError);
      assert.match(textOf(badDice), /Exemplos válidos/);

      await table.connect(port);

      const status = await client.callTool({ name: "status_mesa", arguments: {} });
      assert.match(textOf(status), /Mesa: conectada\. Navegador de Mestre \(mestre\)/);

      const list = await client.callTool({ name: "listar_tokens", arguments: {} });
      assert.match(textOf(list), /"Goblin": casa \(1, 3\)/);
      assert.match(textOf(list), /Mapa "Vila": colunas 0 a 19, linhas 0 a 13/);

      const move = await client.callTool({ name: "mover_token", arguments: { token: "goblin", junto_de: "guilherme" } });
      assert.ok(!move.isError, textOf(move));
      assert.match(textOf(move), /para \(5, 3\): 4 casas \(20ft\)/);
      const goblin = table.items.find((item) => item.id === "cccccccc-3333")!;
      assert.deepEqual(goblin.position, { x: 5.5 * 150, y: 3.5 * 150 });

      const missing = await client.callTool({ name: "mover_token", arguments: { token: "orc", para: { coluna: 1, linha: 1 } } });
      assert.ok(missing.isError);
      assert.match(textOf(missing), /Não achei nenhum token chamado "orc"/);

      const edit = await client.callTool({ name: "editar_token", arguments: { token: "goblin", rotulo: "Grukk", visivel: false } });
      assert.ok(!edit.isError, textOf(edit));
      assert.equal(goblin.text, "Grukk");
      assert.equal(goblin.visible, false);

      const announce = await client.callTool({ name: "anunciar", arguments: { mensagem: "Vez do Leo!", tom: "info" } });
      assert.ok(!announce.isError, textOf(announce));

      const attack = await client.callTool({
        name: "rolar",
        arguments: { expressao: "1d20+4", rotulo: "Ataque do Grukk", tipo: "ataque", cd: 18 },
      });
      assert.match(textOf(attack), /Mostrada na mesa/);
      assert.deepEqual(table.announcements.map((a) => a.kind), ["aviso", "rolagem"]);
      assert.ok(!table.announcements[1]!.text.includes("CA"));

      // Um jogador digita no painel enquanto o mestre espera.
      const waiting = client.callTool({ name: "aguardar_jogadores", arguments: { segundos: 10 } });
      setTimeout(() => table.say("  corro até o goblin  "), 150);
      const heard = textOf(await waiting);
      assert.match(heard, /Mestre: corro até o goblin$/m);
      const quiet = await client.callTool({ name: "aguardar_jogadores", arguments: { segundos: 0 } });
      assert.match(textOf(quiet), /Ninguém escreveu/);

      const log = (await readFile(path.join(campaignDir, "rolagens.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(log.length, 2);
      assert.equal(log[1].rotulo, "Ataque do Grukk");
      assert.equal(log[1].cd, 18);
    } finally {
      await client.close().catch(() => {});
      await table.close();
      // Fechada a sessão, o servidor tem de sair e soltar a porta.
      await waitFor(async () => !(await portInUse(port)));
      await rm(campaignDir, { recursive: true, force: true });
    }
  });

  it("encerra sozinho quando a entrada padrão fecha, sem deixar a porta presa", async () => {
    const port = await freePort();
    const campaignDir = await mkdtemp(path.join(os.tmpdir(), "mesa-campanha-"));
    const child = spawn(process.execPath, [ENTRY], { env: childEnv(port, campaignDir), stdio: ["pipe", "pipe", "pipe"] });
    try {
      await waitFor(() => portInUse(port));
      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      child.stdin.end();
      assert.equal(await exited, 0);
      assert.equal(await portInUse(port), false);
    } finally {
      child.kill();
      await rm(campaignDir, { recursive: true, force: true });
    }
  });
});
