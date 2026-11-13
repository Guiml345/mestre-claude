import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nevoa } from "./actions.js";
import { MesaError } from "./errors.js";
import { FakeTable, memoryLink, sampleState } from "./testing.js";

describe("névoa", () => {
  it("respeita a opção desligada no painel, mas deixa ver o estado", async () => {
    const table = new FakeTable();
    table.fogEnabled = false;
    const ctx = { table: memoryLink(table) };
    await assert.rejects(nevoa(ctx, { acao: "cobrir" }), (err: unknown) => err instanceof MesaError && err.code === "FOG_DISABLED");
    assert.match(await nevoa(ctx, { acao: "estado" }), /Névoa cobrindo o mapa: não/);
    assert.equal(table.fogFilled, false);
  });

  it("cobre, revela por retângulos em casas, esconde, revela de novo e limpa", async () => {
    const table = new FakeTable([], sampleState());
    table.fog.push({ id: "manual", name: "Feita à mão", visible: true, ours: false });
    const ctx = { table: memoryLink(table) };

    assert.match(await nevoa(ctx, { acao: "revelar", area: "Salão", retangulos: [{ coluna: 12, linha: 4, largura: 5, altura: 13 }] }), /Atenção: a névoa não está cobrindo/);
    assert.match(await nevoa(ctx, { acao: "cobrir" }), /cobrindo o mapa todo/);
    assert.equal(table.fogFilled, true);
    assert.match(await nevoa(ctx, { acao: "estado" }), /"Salão" \(revelada\)[\s\S]*feitas à mão pelo mestre: 1/);

    assert.match(await nevoa(ctx, { acao: "esconder", area: "salao" }), /coberta de novo/);
    assert.equal(table.fog.find((a) => a.ours)!.visible, true);
    assert.match(await nevoa(ctx, { acao: "revelar", area: "Salão" }), /revelada de novo/);
    assert.equal(table.fog.find((a) => a.ours)!.visible, false);

    await assert.rejects(nevoa(ctx, { acao: "revelar", area: "Cozinha" }), MesaError);
    await assert.rejects(nevoa(ctx, { acao: "esconder", area: "Cozinha" }), MesaError);

    assert.match(await nevoa(ctx, { acao: "limpar" }), /1 área\(s\) do Claude apagada/);
    assert.deepEqual(table.fog.map((a) => a.id), ["manual"]);
    assert.equal(table.fogFilled, false);
  });
});

describe("névoa: ligar e desligar a pedido", () => {
  it("desligar mostra o mapa todo mesmo com a opção ligada; ligar cobre de novo", async () => {
    const table = new FakeTable();
    table.fogFilled = true;
    const ctx = { table: memoryLink(table) };
    assert.match(await nevoa(ctx, { acao: "desligar" }), /mapa todo aparece/);
    assert.equal(table.fogEnabled, false);
    assert.equal(table.fogFilled, false);
    assert.match(await nevoa(ctx, { acao: "ligar" }), /voltou a ficar coberto/);
    assert.equal(table.fogEnabled, true);
    assert.equal(table.fogFilled, true);
  });
});

describe("inventário", () => {
  it("cria personagem, dá e tira itens, mexe nas moedas e lista", async () => {
    const { inventario } = await import("./actions.js");
    const table = new FakeTable();
    const ctx = { table: memoryLink(table) };
    assert.match(await inventario(ctx, { acao: "ver" }), /Inventário vazio/);
    await assert.rejects(inventario(ctx, { acao: "dar", personagem: "Guilherme", item: "Corda" }), MesaError);
    assert.match(await inventario(ctx, { acao: "criar", personagem: "Guilherme", jogador: "GM" }), /Guilherme criado no inventário\./);
    await inventario(ctx, { acao: "dar", personagem: "guilherme", item: "Corda 15 m" });
    await inventario(ctx, { acao: "dar", personagem: "guilherme", item: "corda 15 m", qtd: 2 });
    assert.match(await inventario(ctx, { acao: "dar", personagem: "Guilherme", item: "Espada longa", nota: "+1" }), /3× Corda 15 m; Espada longa \(\+1\)/);
    assert.match(await inventario(ctx, { acao: "tirar", personagem: "Guilherme", item: "Corda 15 m", qtd: 3 }), /Itens: Espada longa \(\+1\)\./);
    assert.match(await inventario(ctx, { acao: "moedas", personagem: "Guilherme", po: 50, pp: 3 }), /50 po, 3 pp, 0 pc/);
    await assert.rejects(inventario(ctx, { acao: "moedas", personagem: "Guilherme", po: -60 }), MesaError);
    assert.match(await inventario(ctx, { acao: "ver" }), /^Guilherme \[GM\]: 50 po/);
    assert.equal(table.inventory.personagens[0]!.itens.length, 1);
  });

  it("monta o personagem pela ficha numa chamada e pode repetir sem duplicar", async () => {
    const { inventario } = await import("./actions.js");
    const table = new FakeTable();
    const ctx = { table: memoryLink(table) };
    const ficha = { acao: "criar" as const, personagem: "Marcos", jogador: "Marcos", po: 10, itens: [{ nome: "Arco longo" }, { nome: "Flechas", qtd: 20 }, { nome: "Adaga", qtd: 2 }] };
    assert.match(await inventario(ctx, ficha), /Marcos criado no inventário; entraram 3 item\(ns\)\.\nMarcos \[Marcos\]: 10 po, 0 pp, 0 pc\. Itens: Arco longo; 20× Flechas; 2× Adaga\./);
    // Gastou flechas e ganhou ouro no jogo; montar de novo pela ficha não mexe nisso.
    await inventario(ctx, { acao: "tirar", personagem: "Marcos", item: "Flechas", qtd: 5 });
    await inventario(ctx, { acao: "moedas", personagem: "Marcos", po: 5 });
    assert.match(await inventario(ctx, { ...ficha, itens: [...ficha.itens, { nome: "Capa de ranger" }] }), /já estava no inventário; entraram 1 item\(ns\)\.\nMarcos \[Marcos\]: 15 po.*15× Flechas.*Capa de ranger/);
    // Saque inteiro de uma vez.
    assert.match(await inventario(ctx, { acao: "dar", personagem: "Marcos", itens: [{ nome: "Flechas", qtd: 3 }, { nome: "Orelha de goblin", qtd: 4 }] }), /18× Flechas.*4× Orelha de goblin/);
  });
});

describe("pausa e estilo do mestre", () => {
  it("em pausa não entrega as falas; fora da pausa entrega com o estilo escolhido", async () => {
    const { aguardarJogadores } = await import("./actions.js");
    const table = new FakeTable();
    table.outbox.push({ id: "1", author: "Leo", text: "abro a porta", at: new Date().toISOString() });
    const ctx = { table: memoryLink(table) };
    table.paused = true;
    assert.match(await aguardarJogadores(ctx, { segundos: 0 }), /em pausa/);
    assert.equal(table.outbox.length, 1);
    table.paused = false;
    const text = await aguardarJogadores(ctx, { segundos: 0 });
    assert.match(text, /Leo: abro a porta/);
    assert.match(text, /Estilo escolhido no painel: narração média .*dificuldade padrão; explique cada regra/);
  });
});

describe("estilo com opções faltando", () => {
  it("usa os padrões quando a extensão antiga não manda as opções novas", async () => {
    const { describeStyle } = await import("./actions.js");
    assert.equal(
      describeStyle({ nevoa: true }),
      "Estilo escolhido no painel: narração média (3 a 5 frases); dificuldade padrão; explique cada regra em uma frase quando aparecer.",
    );
  });
});
