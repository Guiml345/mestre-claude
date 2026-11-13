import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { encerrarCombate, restaurarCena, salvarCena, type ActionContext } from "./actions.js";
import { matchTokens, type SavedToken } from "./cenas.js";
import { MesaError } from "./errors.js";
import { FakeTable, mapItem, memoryLink, token } from "./testing.js";

const CATALOG_URL = "https://guiml345.github.io/mestre-claude/tokens/lorc/wolf-head.png";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "mesa-cena-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup() {
  const table = new FakeTable([
    mapItem("map-0001", "Taverna", 20, 14),
    token("aaaaaaaa-1111", "Guilherme", 6, 3),
    token("bbbbbbbb-2222", "Lobo", 2, 2, { name: "wolf-head", image: { width: 256, height: 256, url: CATALOG_URL }, grid: { dpi: 256, offset: { x: 128, y: 128 } } }),
    token("cccccccc-3333", "Goblin", 1, 3, { visible: false }),
  ]);
  const ctx: ActionContext = { table: memoryLink(table), campaignDir: async () => dir, now: () => new Date("2026-11-13T12:00:00Z") };
  const cellOf = (label: string) => {
    const item = table.items.find((candidate) => candidate.text === label)!;
    return [Math.floor(item.position.x / 150), Math.floor(item.position.y / 150)];
  };
  return { table, ctx, cellOf };
}

describe("salvar_cena e restaurar_cena", () => {
  it("salva tokens, combate e inventário em cena.json", async () => {
    const { table, ctx } = setup();
    table.combat = { rodada: 2, vez: 0, combatentes: [{ id: "c1", nome: "Guilherme", iniciativa: 15, pv: 20, pvMax: 24, lado: "jogador", condicoes: [] }] };
    table.inventory = { personagens: [{ id: "i1", nome: "Guilherme", moedas: { po: 5, pp: 0, pc: 0 }, itens: [] }] };
    const text = await salvarCena(ctx, { motivo: "fim da sessão" });
    assert.match(text, /mapa "Taverna", 3 token\(s\), combate na rodada 2, inventário de 1/);
    const saved = JSON.parse(await readFile(path.join(dir, "cena.json"), "utf8"));
    assert.equal(saved.motivo, "fim da sessão");
    assert.deepEqual(saved.tokens.map((t: SavedToken) => [t.rotulo, t.coluna, t.linha, t.visivel]), [
      ["Guilherme", 6, 3, true],
      ["Lobo", 2, 2, true],
      ["Goblin", 1, 3, false],
    ]);
  });

  it("guarda o salvamento anterior", async () => {
    const { ctx, table } = setup();
    await salvarCena(ctx);
    table.items = table.items.filter((item) => item.text !== "Goblin");
    await salvarCena(ctx);
    const previous = JSON.parse(await readFile(path.join(dir, "cena.anterior.json"), "utf8"));
    assert.equal(previous.tokens.length, 3);
  });

  it("move de volta, acerta visibilidade e mostra a prévia antes", async () => {
    const { table, ctx, cellOf } = setup();
    await salvarCena(ctx);
    const guilherme = table.items.find((item) => item.text === "Guilherme")!;
    guilherme.position = { x: 10.5 * 150, y: 8.5 * 150 };
    table.items.find((item) => item.text === "Goblin")!.visible = true;

    const preview = await restaurarCena(ctx, { previa: true });
    assert.match(preview, /Mudaria 2 token/);
    assert.deepEqual(cellOf("Guilherme"), [10, 8]);

    const text = await restaurarCena(ctx);
    assert.match(text, /"Guilherme": \(10, 8\) → \(6, 3\)/);
    assert.deepEqual(cellOf("Guilherme"), [6, 3]);
    assert.equal(table.items.find((item) => item.text === "Goblin")!.visible, false);
  });

  it("recria token do catálogo, avisa dos que não dá e lista as sobras", async () => {
    const { table, ctx } = setup();
    await salvarCena(ctx);
    table.items = table.items.filter((item) => item.text !== "Lobo" && item.text !== "Goblin");
    table.items.push(token("dddddddd-4444", "Dragão", 15, 10));

    const text = await restaurarCena(ctx);
    assert.match(text, /Recriei 1 token\(s\) do catálogo: "Lobo" em \(2, 2\)/);
    assert.match(text, /Não dá para recriar.*"Goblin"/);
    assert.match(text, /1 token\(s\) não estavam na cena salva: "Dragão"\. Ficaram/);
    const lobo = table.items.find((item) => item.text === "Lobo")!;
    assert.deepEqual([Math.floor(lobo.position.x / 150), Math.floor(lobo.position.y / 150)], [2, 2]);
    assert.ok(table.items.some((item) => item.text === "Dragão"));

    const again = await restaurarCena(ctx, { remover_sobras: true });
    assert.match(again, /Removi 1 token/);
    assert.ok(!table.items.some((item) => item.text === "Dragão"));
  });

  it("volta o combate e o inventário só se a sala estiver sem", async () => {
    const { table, ctx } = setup();
    table.combat = { rodada: 3, vez: 0, combatentes: [{ id: "c1", nome: "Guilherme", iniciativa: 15, pv: 20, pvMax: 24, lado: "jogador", condicoes: [] }] };
    table.inventory = { personagens: [{ id: "i1", nome: "Guilherme", moedas: { po: 5, pp: 0, pc: 0 }, itens: [] }] };
    await salvarCena(ctx);
    table.combat = null;
    table.inventory = { personagens: [] };
    const text = await restaurarCena(ctx);
    assert.match(text, /Voltou o combate \(rodada 3, vez de Guilherme\)/);
    assert.equal((table.combat as { rodada: number } | null)?.rodada, 3);
    assert.equal(table.inventory.personagens.length, 1);
  });

  it("recusa outro mapa, a menos que force", async () => {
    const { table, ctx } = setup();
    await salvarCena(ctx);
    table.items[0] = mapItem("map-0002", "Caverna", 20, 14);
    await assert.rejects(restaurarCena(ctx), (err: unknown) => err instanceof MesaError && /mapa "Taverna".*"Caverna"/.test(err.message));
    assert.match(await restaurarCena(ctx, { forcar: true }), /Restaurando/);
  });

  it("diz quando não há cena salva", async () => {
    const { ctx } = setup();
    assert.match(await restaurarCena(ctx), /Não há cena salva/);
  });

  it("encerrar_combate salva a cena sozinho", async () => {
    const { table, ctx } = setup();
    table.combat = { rodada: 1, vez: 0, combatentes: [{ id: "c1", nome: "Guilherme", iniciativa: 15, pv: 20, pvMax: 24, lado: "jogador", condicoes: [] }] };
    const text = await encerrarCombate(ctx);
    assert.match(text, /Cena salva em/);
    const saved = JSON.parse(await readFile(path.join(dir, "cena.json"), "utf8"));
    assert.equal(saved.motivo, "fim do combate");
    assert.equal(saved.combate, null);
  });
});

describe("matchTokens", () => {
  const s = (id: string, rotulo: string, nome = rotulo): SavedToken => ({ id, nome, rotulo, camada: "CHARACTER", coluna: 0, linha: 0, largura: 1, altura: 1, visivel: true });

  it("casa pelo id e, se não achar, pelo rótulo e imagem, sem repetir", () => {
    const { pairs, missing, extra } = matchTokens(
      [s("a", "Lobo", "wolf"), s("b", "Lobo", "wolf"), s("c", "Goblin")],
      [{ id: "x", name: "wolf", text: "lobo" }, { id: "a", name: "wolf", text: "Lobo" }, { id: "z", name: "Orc", text: "Orc" }],
    );
    assert.deepEqual(pairs.map((p) => [p.saved.id, p.item.id]), [["a", "a"], ["b", "x"]]);
    assert.deepEqual(missing.map((m) => m.id), ["c"]);
    assert.deepEqual(extra.map((e) => e.id), ["z"]);
  });
});
