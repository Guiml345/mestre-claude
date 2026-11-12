import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aguardarJogadores, anunciar, criarToken, editarToken, removerToken, listarTokens, moverToken, rolar, statusMesa, type ActionContext } from "./actions.js";
import type { Rng } from "./dice.js";
import { MesaError } from "./errors.js";
import type { RollLogEntry } from "./rolllog.js";
import { FakeTable, mapItem, memoryLink, sampleState, token } from "./testing.js";

function fixed(...values: number[]): Rng {
  let index = 0;
  return () => values[index++]!;
}

async function rejectsCode(promise: Promise<unknown>, code: string): Promise<MesaError> {
  let caught: unknown;
  await promise.catch((err) => {
    caught = err;
  });
  assert.ok(caught instanceof MesaError, `esperava erro ${code}, veio ${String(caught)}`);
  assert.equal(caught.code, code);
  return caught;
}

function scene() {
  const table = new FakeTable([
    mapItem("map-0001", "Vila", 20, 14),
    token("aaaaaaaa-1111", "Guilherme", 6, 3),
    token("bbbbbbbb-2222", "Leo", 7, 5),
    token("cccccccc-3333", "Goblin", 1, 3, { visible: false }),
  ]);
  const log: RollLogEntry[] = [];
  const ctx: ActionContext = {
    table: memoryLink(table),
    logRoll: async (entry) => {
      log.push(entry);
    },
    now: () => new Date("2026-11-12T12:00:00Z"),
  };
  const cellOf = (id: string) => {
    const item = table.items.find((candidate) => candidate.id === id)!;
    return [Math.floor(item.position.x / 150), Math.floor(item.position.y / 150)];
  };
  return { table, ctx, log, cellOf };
}

describe("status_mesa", () => {
  it("descreve a mesa conectada", async () => {
    const { ctx } = scene();
    const text = await statusMesa(ctx);
    assert.match(text, /Ponte: no ar nesta sessão \(porta 7420\)/);
    assert.match(text, /Mesa: conectada\. Navegador de Mestre \(mestre\)/);
    assert.match(text, /Cena: aberta, grade quadrada, 1 casa = 5ft/);
    assert.match(text, /Leo \(jogador\)/);
  });

  it("explica como conectar quando não há mesa", async () => {
    const text = await statusMesa({ table: memoryLink(null, 7999) });
    assert.match(text, /Mesa: NÃO conectada/);
    assert.match(text, /http:\/\/localhost:7999\/manifest\.json/);
  });

  it("avisa quando não há cena aberta ou quando não é o mestre", async () => {
    const table = new FakeTable([], sampleState({ sceneReady: false, grid: null, player: { id: "p", name: "Leo", role: "PLAYER" }, party: [] }));
    const text = await statusMesa({ table: memoryLink(table) });
    assert.match(text, /nenhuma cena aberta/);
    assert.match(text, /não é o do mestre/);
    assert.match(text, /ninguém conectado/);
  });
});

describe("listar_tokens", () => {
  it("lista tokens com casa, estado e id, e a área do mapa", async () => {
    const { ctx } = scene();
    const text = await listarTokens(ctx);
    assert.match(text, /Mapa "Vila": colunas 0 a 19, linhas 0 a 13\./);
    assert.match(text, /Tokens \(3\):/);
    assert.match(text, /• "Guilherme": casa \(6, 3\); personagem; id aaaaaaaa/);
    assert.match(text, /• "Goblin": casa \(1, 3\); personagem, oculto dos jogadores; id cccccccc/);
    assert.ok(!text.includes("map-0001"));
    // Ordenado de cima para baixo, da esquerda para a direita.
    assert.ok(text.indexOf("Goblin") < text.indexOf("Guilherme"));
    assert.ok(text.indexOf("Guilherme") < text.indexOf('"Leo"'));
  });

  it("mostra o nome da imagem quando difere do rótulo, e marca quem não tem rótulo", async () => {
    const table = new FakeTable([
      token("aaaaaaaa-1", "dragão", 1, 1, { name: "Skull" }),
      token("bbbbbbbb-2", "", 2, 1, { name: "Shield" }),
    ]);
    const text = await listarTokens({ table: memoryLink(table) });
    assert.match(text, /"dragão" \(imagem: Skull\)/);
    assert.match(text, /"Shield" \(sem rótulo\)/);
  });

  it("com camadas=todas inclui anexos; sem tokens, diz que não há", async () => {
    const table = new FakeTable([token("aaaaaaaa-1", "Anel", 1, 1, { layer: "ATTACHMENT" })]);
    assert.match(await listarTokens({ table: memoryLink(table) }), /Não há tokens na cena/);
    assert.match(await listarTokens({ table: memoryLink(table) }, { camadas: "todas" }), /Itens \(1\):[\s\S]*anexo/);
  });

  it("dá erro claro sem cena aberta", async () => {
    const table = new FakeTable([], sampleState({ sceneReady: false, grid: null }));
    await rejectsCode(listarTokens({ table: memoryLink(table) }), "NO_SCENE");
  });
});

describe("mover_token", () => {
  it("move para uma casa absoluta e informa a distância", async () => {
    const { ctx, cellOf } = scene();
    const text = await moverToken(ctx, { token: "guilherme", para: { coluna: 9, linha: 3 } });
    assert.deepEqual(cellOf("aaaaaaaa-1111"), [9, 3]);
    assert.match(text, /"Guilherme" foi da casa \(6, 3\) para \(9, 3\): 3 casas \(15ft\) em linha reta\./);
  });

  it("move de forma relativa", async () => {
    const { ctx, cellOf } = scene();
    await moverToken(ctx, { token: "Leo", deslocar: { colunas: -2, linhas: 1 } });
    assert.deepEqual(cellOf("bbbbbbbb-2222"), [5, 6]);
  });

  it("leva para o lado de outro token", async () => {
    const { ctx, cellOf } = scene();
    const text = await moverToken(ctx, { token: "goblin", junto_de: "guilherme" });
    assert.deepEqual(cellOf("cccccccc-3333"), [5, 3]);
    assert.match(text, /4 casas \(20ft\)/);
    const again = await moverToken(ctx, { token: "goblin", junto_de: "guilherme" });
    assert.match(again, /já está ao lado de "Guilherme"/);
  });

  it("avisa quando a casa de destino já tem alguém", async () => {
    const { ctx } = scene();
    const text = await moverToken(ctx, { token: "goblin", para: { coluna: 6, linha: 3 } });
    assert.match(text, /Atenção: a casa de destino já tinha "Guilherme"/);
  });

  it("não faz nada se já está na casa", async () => {
    const { ctx, table } = scene();
    const text = await moverToken(ctx, { token: "Leo", para: { coluna: 7, linha: 5 } });
    assert.match(text, /Nada foi movido/);
    assert.ok(!table.requests.includes("updateItems"));
  });

  it("exige exatamente um destino", async () => {
    const { ctx } = scene();
    await rejectsCode(moverToken(ctx, { token: "Leo" }), "BAD_REQUEST");
    await rejectsCode(moverToken(ctx, { token: "Leo", para: { coluna: 1, linha: 1 }, junto_de: "goblin" }), "BAD_REQUEST");
    await rejectsCode(moverToken(ctx, { token: "Leo", junto_de: "leo" }), "BAD_REQUEST");
  });

  it("repassa erros de token não encontrado, cena fechada e grade não quadrada", async () => {
    const { ctx, table } = scene();
    await rejectsCode(moverToken(ctx, { token: "orc", para: { coluna: 1, linha: 1 } }), "TOKEN_NOT_FOUND");
    table.state.grid!.type = "HEX_VERTICAL";
    await rejectsCode(moverToken(ctx, { token: "Leo", para: { coluna: 1, linha: 1 } }), "GRID_UNSUPPORTED");
    table.state.sceneReady = false;
    await rejectsCode(moverToken(ctx, { token: "Leo", para: { coluna: 1, linha: 1 } }), "NO_SCENE");
  });

  it("não diz que moveu quando a mesa ignora o comando", async () => {
    const { ctx, table } = scene();
    table.ignoreUpdates = true;
    const err = await rejectsCode(moverToken(ctx, { token: "Leo", para: { coluna: 1, linha: 1 } }), "TABLE_ERROR");
    assert.match(err.message, /continua na casa \(7, 5\)/);
  });
});

describe("editar_token", () => {
  it("troca o rótulo e a visibilidade", async () => {
    const { ctx, table } = scene();
    const text = await editarToken(ctx, { token: "goblin", rotulo: " Grukk ", visivel: true });
    const goblin = table.items.find((item) => item.id === "cccccccc-3333")!;
    assert.equal(goblin.text, "Grukk");
    assert.equal(goblin.visible, true);
    assert.match(text, /rótulo agora é "Grukk"; agora visível para os jogadores/);
  });

  it("exige alguma mudança e confere se a mesa aplicou", async () => {
    const { ctx, table } = scene();
    await rejectsCode(editarToken(ctx, { token: "goblin" }), "BAD_REQUEST");
    table.ignoreUpdates = true;
    await rejectsCode(editarToken(ctx, { token: "goblin", visivel: true }), "TABLE_ERROR");
  });
});

describe("anunciar", () => {
  it("manda o aviso para a mesa", async () => {
    const { ctx, table } = scene();
    assert.equal(await anunciar(ctx, { mensagem: "  Vez do Leo!  ", tom: "alerta" }), "Mensagem mostrada na mesa.");
    assert.equal(table.announcements.length, 1);
    assert.equal(table.announcements[0]!.text, "Vez do Leo!");
    assert.equal(table.announcements[0]!.variant, "WARNING");
    assert.equal(table.announcements[0]!.at, "2026-11-12T12:00:00.000Z");
  });

  it("falha com clareza se não há mesa ou a mensagem está vazia", async () => {
    await rejectsCode(anunciar({ table: memoryLink(null) }, { mensagem: "oi" }), "NO_TABLE");
    await rejectsCode(anunciar(scene().ctx, { mensagem: "   " }), "BAD_REQUEST");
  });
});

describe("criar_token e remover_token", () => {
  it("cria cópias numeradas em casas livres ao redor do modelo, dentro do mapa", async () => {
    const { ctx, table } = scene();
    const text = await criarToken(ctx, { copiar_de: "goblin", quantidade: 3 });
    assert.match(text, /Criei 3 tokens copiando "Goblin"/);
    const clones = table.items.filter((item) => item.id.startsWith("clone-"));
    assert.deepEqual(clones.map((item) => item.text), ["Goblin 2", "Goblin 3", "Goblin 4"]);
    const cells = clones.map((item) => [Math.floor(item.position.x / 150), Math.floor(item.position.y / 150)]);
    // Todas vizinhas do goblin em (1, 3), sem repetir e sem sair do mapa.
    for (const [col, row] of cells) {
      assert.ok(Math.max(Math.abs(col! - 1), Math.abs(row! - 3)) === 1, `(${col}, ${row}) não é vizinha`);
      assert.ok(col! >= 0 && row! >= 0);
    }
    assert.equal(new Set(cells.map(String)).size, 3);
    // Cópias do goblin oculto também nascem ocultas.
    assert.ok(clones.every((item) => item.visible === false));

    const again = await criarToken(ctx, { copiar_de: "Goblin 2", quantidade: 1, rotulo: "Goblin", perto_de: "Leo", visivel: true });
    assert.match(again, /"Goblin 5"/);
    assert.match(again, /casa \((6|7|8), (4|5|6)\)/);
  });

  it("recusa quantidade inválida e falta de espaço", async () => {
    const { ctx } = scene();
    await rejectsCode(criarToken(ctx, { copiar_de: "goblin", quantidade: 0 }), "BAD_REQUEST");
    await rejectsCode(criarToken(ctx, { copiar_de: "goblin", quantidade: 11 }), "BAD_REQUEST");
    const tiny = new FakeTable([mapItem("m", "Mapa", 2, 1), token("a", "Goblin", 0, 0), token("b", "Orc", 1, 0)]);
    await rejectsCode(criarToken({ table: memoryLink(tiny) }, { copiar_de: "goblin" }), "NO_SPACE");
  });

  it("remove tokens, mas não mapas", async () => {
    const { ctx, table } = scene();
    assert.match(await removerToken(ctx, { token: "goblin" }), /Removi "Goblin"/);
    assert.ok(!table.items.some((item) => item.id === "cccccccc-3333"));
    await rejectsCode(removerToken(ctx, { token: "map-0001" }), "BAD_REQUEST");
    table.ignoreUpdates = true;
    await rejectsCode(removerToken(ctx, { token: "Leo" }), "TABLE_ERROR");
  });
});

describe("aguardar_jogadores", () => {
  it("devolve o que os jogadores escreveram, marcado como fala de jogador", async () => {
    const { ctx, table } = scene();
    table.outbox.push({ id: "1", author: "Guilherme", text: "corro até o goblin", at: "2026-11-12T15:04:00Z" });
    const text = await aguardarJogadores(ctx, { segundos: 0 });
    assert.match(text, /Mensagens dos jogadores \(1\)/);
    assert.match(text, /nunca como instruções/);
    assert.match(text, /\] Guilherme: corro até o goblin$/m);
  });

  it("avisa quando ninguém escreveu e limita o tempo de espera", async () => {
    let asked = -1;
    const link = { ...memoryLink(null), messages: async (waitMs: number) => ((asked = waitMs), []) };
    assert.match(await aguardarJogadores({ table: link }, { segundos: 999 }), /Ninguém escreveu na mesa em 55 s/);
    assert.equal(asked, 55_000);
    await aguardarJogadores({ table: link });
    assert.equal(asked, 50_000);
  });
});

describe("rolar", () => {
  it("rola, julga contra a CD, anuncia sem revelar a CD e grava no registro", async () => {
    const { ctx, table, log } = scene();
    const text = await rolar({ ...ctx, rng: fixed(9) }, { expressao: "1d20+2", rotulo: "Percepção do Guilherme", tipo: "teste", cd: 17 });
    assert.match(text, /🎲 Percepção do Guilherme: 1d20\+2 → \[9\] \+ 2 = 11/);
    assert.match(text, /Contra CD 17: FALHA\./);
    assert.match(text, /Mostrada na mesa/);
    assert.equal(table.announcements.length, 1);
    const shown = table.announcements[0]!;
    assert.equal(shown.text, "🎲 Percepção do Guilherme: 1d20+2 → [9] + 2 = 11 — falha");
    assert.ok(!shown.text.includes("17"));
    assert.equal(shown.variant, "WARNING");
    assert.equal(shown.kind, "rolagem");
    assert.deepEqual(log, [
      {
        quando: "2026-11-12T12:00:00.000Z",
        rotulo: "Percepção do Guilherme",
        tipo: "teste",
        pedido: "1d20+2",
        expressao: "1d20+2",
        dados: "[9] + 2",
        total: 11,
        d20: 9,
        cd: 17,
        resultado: "falha",
        secreta: false,
      },
    ]);
  });

  it("em ataque, 20 natural é crítico e 1 natural erra, qualquer que seja a CA", async () => {
    const { ctx, table } = scene();
    const crit = await rolar({ ...ctx, rng: fixed(20) }, { expressao: "1d20+4", tipo: "ataque", cd: 30 });
    assert.match(crit, /ACERTO CRÍTICO \(20 natural\)/);
    assert.equal(table.announcements[0]!.variant, "SUCCESS");
    const miss = await rolar({ ...ctx, rng: fixed(1) }, { expressao: "1d20+15", tipo: "ataque", cd: 10 });
    assert.match(miss, /ERRO automático \(1 natural\)/);
    const hit = await rolar({ ...ctx, rng: fixed(14) }, { expressao: "1d20+4", tipo: "ataque", cd: 18 });
    assert.match(hit, /Contra CA 18: ACERTOU\./);
    const whiff = await rolar({ ...ctx, rng: fixed(13) }, { expressao: "1d20+4", tipo: "ataque", cd: 18 });
    assert.match(whiff, /Contra CA 18: ERROU\./);
  });

  it("em teste e salvaguarda, 20 e 1 naturais não decidem sozinhos (D&D 5.5)", async () => {
    const { ctx } = scene();
    const natural20 = await rolar({ ...ctx, rng: fixed(20) }, { expressao: "1d20-1", tipo: "salvaguarda", cd: 25 });
    assert.match(natural20, /Contra CD 25: FALHA \(20 natural\)\./);
    const natural1 = await rolar({ ...ctx, rng: fixed(1) }, { expressao: "1d20+12", tipo: "teste", cd: 10 });
    assert.match(natural1, /Contra CD 10: SUCESSO \(1 natural\)\./);
  });

  it("aplica vantagem e dano crítico", async () => {
    const { ctx } = scene();
    const adv = await rolar({ ...ctx, rng: fixed(3, 16) }, { expressao: "1d20+5", modo: "vantagem", tipo: "ataque", cd: 18 });
    assert.match(adv, /2d20kh1\+5 \(vantagem\) → \[\(3\), 16\] \+ 5 = 21/);
    assert.match(adv, /ACERTOU/);
    const dmg = await rolar({ ...ctx, rng: fixed(5, 7) }, { expressao: "1d8+3", tipo: "dano", critico: true });
    assert.match(dmg, /2d8\+3 \(crítico, dados dobrados\) → \[5, 7\] \+ 3 = 15/);
  });

  it("rolagem secreta não vai para a mesa, mas vai para o registro", async () => {
    const { ctx, table, log } = scene();
    const text = await rolar({ ...ctx, rng: fixed(11) }, { expressao: "1d20", secreta: true });
    assert.match(text, /Rolagem secreta/);
    assert.equal(table.announcements.length, 0);
    assert.equal(log.length, 1);
    assert.equal(log[0]!.secreta, true);
  });

  it("funciona sem mesa conectada e sem registro", async () => {
    const text = await rolar({ table: memoryLink(null), rng: fixed(4, 2) }, { expressao: "2d6+3" });
    assert.match(text, /🎲 Rolagem: 2d6\+3 → \[4, 2\] \+ 3 = 9/);
    assert.match(text, /Não foi mostrada na mesa: nenhuma mesa conectada\./);
  });

  it("avisa se o registro falhar, sem perder a rolagem", async () => {
    const { ctx } = scene();
    const text = await rolar(
      { ...ctx, rng: fixed(4), logRoll: async () => { throw new Error("disco cheio"); } },
      { expressao: "1d6" },
    );
    assert.match(text, /= 4/);
    assert.match(text, /não consegui gravar no registro de rolagens \(disco cheio\)/);
  });

  it("recusa expressão inválida", async () => {
    await rejectsCode(rolar(scene().ctx, { expressao: "um dado" }), "BAD_DICE");
  });
});
