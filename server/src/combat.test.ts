import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { alterarCombatente, encerrarCombate, iniciarCombate, proximoTurno, verCombate } from "./actions.js";
import { changeCombatant, healthWord, nextTurn, startCombat } from "./combat.js";
import { MesaError } from "./errors.js";
import { FakeTable, memoryLink } from "./testing.js";

const party = [
  { nome: "Goblin 2", iniciativa: 11, pv: 6, pv_max: 10, ca: 15 },
  { nome: "Batata", iniciativa: 22, pv: 0, pv_max: 7, ca: 12, lado: "jogador" as const },
  { nome: "Guilherme", iniciativa: 20, pv: 12, ca: 18, lado: "jogador" as const },
  { nome: "Goblin 3", iniciativa: 11, pv: 10, ca: 15 },
];

describe("combate (lógica)", () => {
  it("ordena pela iniciativa e mantém a ordem de entrada no empate", () => {
    const combat = startCombat(party);
    assert.deepEqual(combat.combatentes.map((c) => c.nome), ["Batata", "Guilherme", "Goblin 2", "Goblin 3"]);
    assert.equal(combat.rodada, 1);
    assert.equal(combat.vez, 0);
    assert.equal(combat.combatentes[2]!.pvMax, 10);
    assert.equal(combat.combatentes[3]!.lado, "inimigo");
  });

  it("passa a vez, pula inimigo caído mas não jogador caído, e vira a rodada", () => {
    let combat = startCombat(party);
    combat = changeCombatant(combat, "goblin 3", { pv_delta: -20 }).combat;
    combat = nextTurn(combat); // Guilherme
    combat = nextTurn(combat); // Goblin 2
    assert.equal(combat.combatentes[combat.vez]!.nome, "Goblin 2");
    combat = nextTurn(combat); // pula Goblin 3 (caído) e volta ao Batata, caído mas jogador
    assert.equal(combat.combatentes[combat.vez]!.nome, "Batata");
    assert.equal(combat.rodada, 2);
  });

  it("dano e cura ficam entre 0 e o máximo, e condições não repetem", () => {
    let combat = startCombat(party);
    let r = changeCombatant(combat, "Guilherme", { pv_delta: -15 });
    assert.equal(r.c!.pv, 0);
    assert.match(r.note, /CAIU: inconsciente/);
    r = changeCombatant(r.combat, "Guilherme", { pv_delta: 50 });
    assert.equal(r.c!.pv, 12);
    r = changeCombatant(r.combat, "Guilherme", { adicionar_condicao: "Envenenado" });
    r = changeCombatant(r.combat, "guilherme", { adicionar_condicao: "envenenado" });
    assert.deepEqual(r.c!.condicoes, ["Envenenado"]);
    r = changeCombatant(r.combat, "Guilherme", { remover_condicao: "ENVENENADO" });
    assert.deepEqual(r.c!.condicoes, []);
    combat = changeCombatant(r.combat, "Goblin 2", { remover: true }).combat;
    assert.ok(!combat.combatentes.some((c) => c.nome === "Goblin 2"));
  });

  it("recusa nomes repetidos, vazios e combatente desconhecido", () => {
    assert.throws(() => startCombat([]), MesaError);
    assert.throws(() => startCombat([{ nome: "A", iniciativa: 1, pv: 1 }, { nome: "a", iniciativa: 2, pv: 1 }]), MesaError);
    assert.throws(() => changeCombatant(startCombat(party), "orc", { pv_delta: -1 }), MesaError);
    assert.throws(() => changeCombatant(startCombat(party), "goblin", { pv_delta: -1 }), MesaError);
  });

  it("descreve a saúde dos inimigos sem números", () => {
    const c = { pv: 10, pvMax: 10 } as Parameters<typeof healthWord>[0];
    assert.equal(healthWord(c), "ileso");
    assert.equal(healthWord({ ...c, pv: 6 }), "ferido");
    assert.equal(healthWord({ ...c, pv: 5 }), "muito ferido");
    assert.equal(healthWord({ ...c, pv: 0 }), "caído");
  });
});

describe("combate (ações na mesa)", () => {
  it("inicia, guarda na sala, avança turnos, aplica dano e encerra", async () => {
    const table = new FakeTable();
    const ctx = { table: memoryLink(table) };
    assert.match(await verCombate(ctx), /Não há combate/);
    await assert.rejects(proximoTurno(ctx), (err: unknown) => err instanceof MesaError && err.code === "NO_COMBAT");

    const started = await iniciarCombate(ctx, { combatentes: party });
    assert.match(started, /▶ 22 Batata \(jogador\): PV 0\/7/);
    assert.equal(table.combat?.combatentes.length, 4);
    assert.match(table.announcements.at(-1)!.text, /vez de Batata, caído. Faça o teste de morte/);

    assert.match(await proximoTurno(ctx), /▶ 20 Guilherme/);
    assert.match(table.announcements.at(-1)!.text, /Rodada 1: vez de Guilherme!/);
    assert.match(await alterarCombatente(ctx, { nome: "goblin 2", pv_delta: -6 }), /Goblin 2: PV 6 → 0\/10; CAIU/);

    const more = await iniciarCombate(ctx, { combatentes: [{ nome: "Chefe Goblin", iniciativa: 21, pv: 21, ca: 17 }], adicionar: true });
    assert.match(more, /Combatentes adicionados/);
    // A vez continua com o Guilherme mesmo com o chefe entrando antes dele na ordem.
    assert.match(more, /▶ 20 Guilherme/);

    assert.match(await encerrarCombate(ctx), /Combate encerrado depois de 1 rodada/);
    assert.equal(table.combat, null);
  });
});

describe("turno_monstro", () => {
  it("move, ataca contra a CA, desconta o dano e passa a vez", async () => {
    const { turnoMonstro } = await import("./actions.js");
    const { token } = await import("./testing.js");
    const table = new FakeTable([token("g", "Goblin 3", 2, 2), token("h", "Guilherme", 6, 2)]);
    // Dados na ordem: ataque 1 (d20=15), dano 1 (d6=4), ataque 2 (d20=1), ataque 3 (20 natural), dano 3 (4 e 5).
    const dice = [15, 4, 1, 20, 4, 5];
    const ctx = { table: memoryLink(table), rng: () => dice.shift()! };
    await iniciarCombate(ctx, {
      combatentes: [
        { nome: "Goblin 3", iniciativa: 15, pv: 7, ca: 15 },
        { nome: "Guilherme", iniciativa: 10, pv: 20, ca: 18, lado: "jogador", jogador: "GM" },
      ],
    });

    const out = await turnoMonstro(ctx, {
      monstro: "goblin 3",
      narracao: "O goblin avança gritando.",
      mover: { junto_de: "Guilherme" },
      ataques: [
        { alvo: "Guilherme", nome: "Cimitarra", bonus: 4, dano: "1d6+2" },
        { alvo: "Guilherme", bonus: 4, dano: "1d6+2" },
        { alvo: "Guilherme", bonus: 4, dano: "1d6+2" },
      ],
    });
    assert.match(out, /Contra CA 18: ACERTOU/);
    assert.match(out, /Guilherme: PV 20 → 14\/20/);
    assert.match(out, /ERRO automático/);
    assert.match(out, /ACERTO CRÍTICO/);
    // Crítico: 2d6+2 = 4+5+2 = 11.
    assert.match(out, /Guilherme: PV 14 → 3\/20/);
    assert.equal(table.combat?.combatentes.find((c) => c.nome === "Guilherme")?.pv, 3);
    assert.match(out, /▶ 10 Guilherme/);
    assert.ok(table.announcements.some((a) => a.text === "O goblin avança gritando."));
    assert.match(table.announcements.at(-1)!.text, /vez de Guilherme/);
    assert.equal(dice.length, 0);

    // Fora da vez: avisa; com aplicar false, não desconta.
    dice.push(19, 6);
    const held = await turnoMonstro(ctx, {
      monstro: "Goblin 3",
      ataques: [{ alvo: "Guilherme", bonus: 4, dano: "1d6+2", aplicar: false }],
      passar_vez: false,
    });
    assert.match(held, /não era a vez de Goblin 3/);
    assert.match(held, /Dano não descontado/);
    assert.equal(table.combat?.combatentes.find((c) => c.nome === "Guilherme")?.pv, 3);
  });
});

describe("câmera", () => {
  it("acompanha movimento e pode ser levada a um token ou área", async () => {
    const { focarCamera, moverToken } = await import("./actions.js");
    const { token } = await import("./testing.js");
    const table = new FakeTable([token("a", "Guilherme", 6, 3)]);
    const ctx = { table: memoryLink(table) };
    await moverToken(ctx, { token: "Guilherme", para: { coluna: 9, linha: 3 } });
    // Do (6,3) ao (9,3) com 3 casas de margem: colunas 3 a 12, linhas 0 a 6.
    // Centrada no destino (9,3), com 3 casas de margem: colunas 6 a 12, linhas 0 a 6.
    assert.deepEqual(table.focused.at(-1), { x: 6 * 150, y: 0, w: 7 * 150, h: 7 * 150 });
    assert.match(await focarCamera(ctx, { token: "guilherme" }), /colunas 9 a 9, linhas 3 a 3/);
    assert.match(await focarCamera(ctx, { area: { coluna: 0, linha: 0, largura: 5, altura: 2 } }), /colunas 0 a 4/);
    await assert.rejects(focarCamera(ctx, {}), MesaError);
  });
});
