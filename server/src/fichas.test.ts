import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ficha, type ActionContext } from "./actions.js";
import { loadRulesData, mergeSheets } from "./fichas.js";
import type { Ficha } from "./protocol.js";
import { checkSheet, findSpell, parseSheet, preparableSpells, spellLimits } from "./regras.js";
import { FakeTable, memoryLink } from "./testing.js";

const dataDir = fileURLToPath(new URL("../../extension/public/dados", import.meta.url));

function paladin(extra: Partial<Ficha> = {}): Ficha {
  return parseSheet({
    nome: "Guilherme",
    jogador: "GM",
    especie: "Anão",
    classe: "paladino",
    nivel: 2,
    atributos: { for: 17, des: 10, con: 15, int: 8, sab: 12, car: 14 },
    pv: { max: 22, atual: 22, temp: 0 },
    ca: 19,
    iniciativa: 0,
    deslocamento: "9 m",
    proficiencia: 2,
    salvaguardas: ["sab", "car"],
    magia: { atributo: "car", cd: 12, ataque: 4, truques: [], preparadas: [], sempre: [], gastos: [] },
    pendencias: ["Escolher 3 magias preparadas de 1º nível."],
    atualizadoEm: "2026-11-13T10:00:00.000Z",
    ...extra,
  })!;
}

describe("regras de ficha (SRD 5.2.1)", () => {
  it("dá os espaços e o limite de magias preparadas de cada classe", async () => {
    const { tables } = await loadRulesData(dataDir);
    assert.deepEqual(spellLimits(tables, "paladino", 2), { espacos: [2], preparadas: 3, truques: 0, nivelMax: 1, sempre: ["divine-smite"] });
    assert.deepEqual(spellLimits(tables, "mago", 2)?.espacos, [3]);
    assert.equal(spellLimits(tables, "mago", 2)?.preparadas, 5);
    assert.deepEqual(spellLimits(tables, "patrulheiro", 5)?.espacos, [4, 2]);
    assert.deepEqual(spellLimits(tables, "bruxo", 5)?.espacos, [0, 0, 2]);
    assert.deepEqual(spellLimits(tables, "clerigo", 20)?.espacos, [4, 3, 3, 3, 3, 2, 2, 1, 1]);
    assert.equal(spellLimits(tables, "guerreiro", 2), null);
  });

  it("lista só as magias da classe até o nível que ela alcança", async () => {
    const { spells, tables } = await loadRulesData(dataDir);
    const list = preparableSpells(spells, tables, "paladino", 2);
    assert.ok(list.some((s) => s.id === "bless") && list.every((s) => s.nivel === 1 && s.classes.includes("paladino")));
    assert.ok(!list.some((s) => s.id === "aid"));
    assert.ok(preparableSpells(spells, tables, "paladino", 5).some((s) => s.id === "aid"));
    assert.equal(findSpell(spells, "Hunter's Mark")?.id, "hunters-mark");
  });

  it("aponta o que está fora da regra", async () => {
    const { spells, tables } = await loadRulesData(dataDir);
    assert.deepEqual(checkSheet(paladin(), spells, tables), []);
    const wrong = paladin({ magia: { atributo: "car", cd: 13, ataque: 4, truques: [], preparadas: ["bless", "command", "heroism", "shield-of-faith", "aid", "fireball"], sempre: [], gastos: [3] } });
    const problems = checkSheet(wrong, spells, tables).join(" ");
    assert.match(problems, /6 magias preparadas; o limite no nível 2 é 3/);
    assert.match(problems, /Aid é de 2º nível/);
    assert.match(problems, /Fireball não está na lista de Paladino/);
    assert.match(problems, /3 espaços de 1º nível gastos, mas só tem 2/);
    assert.match(problems, /CD de magia 13; pela ficha seria 12/);
  });

  it("limpa ficha vinda da sala (qualquer um escreve lá)", () => {
    assert.equal(parseSheet({ nome: "X" }), null);
    const f = parseSheet({ nome: "Zé da Silva", classe: "mago", nivel: 99, atributos: { for: "muito" }, ataques: [{ nome: "Soco", bonus: "2" }] })!;
    assert.equal(f.id, "ze-da-silva");
    assert.equal(f.nivel, 20);
    assert.equal(f.atributos.for, 10);
    assert.equal(f.ataques[0]!.bonus, 0);
  });

  it("junta disco e sala ficando com a mais nova", () => {
    const old = paladin({ atualizadoEm: "2026-11-13T10:00:00.000Z" });
    const fresh = paladin({ ca: 20, atualizadoEm: "2026-11-13T11:00:00.000Z" });
    const a = mergeSheets([old], [fresh]);
    assert.equal(a.fichas[0]!.ca, 20);
    assert.equal(a.paraDisco.length, 1);
    assert.equal(a.paraSala, false);
    const b = mergeSheets([fresh], [old]);
    assert.equal(b.paraDisco.length, 0);
    assert.equal(b.paraSala, true);
  });
});

describe("ferramenta ficha", () => {
  let dir: string;
  let table: FakeTable;
  let ctx: ActionContext;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "mesa-fichas-"));
    await mkdir(path.join(dir, "fichas"));
    await writeFile(path.join(dir, "fichas", "guilherme.json"), JSON.stringify(paladin()));
    table = new FakeTable();
    ctx = { table: memoryLink(table), campaignDir: async () => dir, dataDir, now: () => new Date("2026-11-13T12:00:00Z") };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("publica as fichas do disco na sala e mostra", async () => {
    const text = await ficha(ctx, { acao: "ver", nome: "guilherme" });
    assert.match(text, /Guilherme \[GM\]: Anão, Paladino 2\. PV 22\/22, CA 19/);
    assert.match(text, /Preparadas \(0\/3\): nenhuma/);
    assert.match(text, /Sempre preparadas: Divine Smite/);
    assert.match(text, /Pendências: Escolher 3 magias/);
    assert.equal(table.sheets.personagens[0]?.nome, "Guilherme");
  });

  it("prepara magias conferindo lista, nível e limite, e grava nos dois lugares", async () => {
    await assert.rejects(ficha(ctx, { acao: "preparar", nome: "Guilherme", magias: ["bless", "aid"] }), /Aid \(2º nível\) não está disponível/);
    await assert.rejects(ficha(ctx, { acao: "preparar", nome: "Guilherme", magias: ["bless", "command", "heroism", "shield of faith"] }), /São 4 magias; o limite é 3/);
    const text = await ficha(ctx, { acao: "preparar", nome: "Guilherme", magias: ["Bless", "command", "Shield of Faith", "divine-smite"] });
    assert.match(text, /Preparadas \(3\/3\): Bless, Command, Shield of Faith/);
    const disk = JSON.parse(await readFile(path.join(dir, "fichas", "guilherme.json"), "utf8"));
    assert.deepEqual(disk.magia.preparadas, ["bless", "command", "shield-of-faith"]);
    assert.equal(disk.pendencias.length, 0);
    assert.deepEqual(table.sheets.personagens[0]?.magia?.preparadas, ["bless", "command", "shield-of-faith"]);
  });

  it("gasta espaço e o descanso longo recupera tudo", async () => {
    assert.match(await ficha(ctx, { acao: "gastar", nome: "Guilherme", nivel: 1 }), /sobram 1\/2/);
    await ficha(ctx, { acao: "gastar", nome: "Guilherme", nivel: 1 });
    await assert.rejects(ficha(ctx, { acao: "gastar", nome: "Guilherme", nivel: 1 }), /só tem 0 espaço/);
    assert.match(await ficha(ctx, { acao: "descanso" }), /Descanso longo: Guilherme/);
    assert.match(await ficha(ctx, { acao: "ver", nome: "Guilherme" }), /Espaços livres: 1º 2\/2/);
  });

  it("o que o jogador mudou no painel volta para o disco", async () => {
    await ficha(ctx, { acao: "ver" });
    const room = table.sheets.personagens[0]!;
    room.pv.atual = 7;
    room.atualizadoEm = "2026-11-13T13:00:00.000Z";
    const text = await ficha(ctx, { acao: "sincronizar" });
    assert.match(text, /Atualizei no disco o que mudou no painel: Guilherme/);
    const disk = JSON.parse(await readFile(path.join(dir, "fichas", "guilherme.json"), "utf8"));
    assert.equal(disk.pv.atual, 7);
  });
});

describe("combate e ficha", () => {
  it("o dano no combate chega ao PV da ficha (disco e sala)", async () => {
    const { alterarCombatente, iniciarCombate } = await import("./actions.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "mesa-fichas-"));
    try {
      await mkdir(path.join(dir, "fichas"));
      await writeFile(path.join(dir, "fichas", "guilherme.json"), JSON.stringify(paladin({ token: "Gui" })));
      const table = new FakeTable();
      const ctx: ActionContext = { table: memoryLink(table), campaignDir: async () => dir, dataDir };
      await iniciarCombate(ctx, { combatentes: [{ nome: "Guilherme", iniciativa: 10, pv: 22, ca: 19, lado: "jogador", token: "Gui" }, { nome: "Goblin", iniciativa: 5, pv: 7 }] });
      assert.match(await alterarCombatente(ctx, { nome: "Guilherme", pv_delta: -8 }), /Ficha atualizada: Guilherme 14\/22/);
      assert.equal(JSON.parse(await readFile(path.join(dir, "fichas", "guilherme.json"), "utf8")).pv.atual, 14);
      assert.equal(table.sheets.personagens[0]?.pv.atual, 14);
      // Inimigo não tem ficha: nada muda.
      assert.doesNotMatch(await alterarCombatente(ctx, { nome: "Goblin", pv_delta: -3 }), /Ficha atualizada/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
