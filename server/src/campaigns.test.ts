import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { campanha, statusMesa } from "./actions.js";
import { activeCampaignDir, campaignForRoom, slugify } from "./campaigns.js";
import { MesaError } from "./errors.js";
import { createRollLogger } from "./rolllog.js";
import { FakeTable, memoryLink, sampleState } from "./testing.js";

describe("campanhas", () => {
  it("cria, lista, ativa e grava as rolagens na pasta da campanha ativa", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "campanhas-"));
    try {
      await mkdir(path.join(root, "_modelo", "fichas"), { recursive: true });
      await writeFile(path.join(root, "_modelo", "resumo.md"), "# {{NOME}}\n");
      await writeFile(path.join(root, "_modelo", "fichas", "MODELO.md"), "ficha");
      const ctx = { table: memoryLink(null), campaignsRoot: root };

      assert.equal(slugify("Vila do Queijo Mofado!"), "vila-do-queijo-mofado");
      assert.match(await campanha(ctx, { acao: "listar" }), /Nenhuma campanha/);
      assert.equal(await activeCampaignDir(root), path.join(root, "teste"));

      assert.match(await campanha(ctx, { acao: "criar", nome: "Vila do Queijo Mofado" }), /vila-do-queijo-mofado/);
      assert.equal(await readFile(path.join(root, "vila-do-queijo-mofado", "resumo.md"), "utf8"), "# Vila do Queijo Mofado\n");
      await assert.rejects(campanha(ctx, { acao: "criar", nome: "vila do queijo mofado" }), MesaError);
      await campanha(ctx, { acao: "criar", nome: "Principal" });

      assert.match(await campanha(ctx, { acao: "ativar", nome: "queijo" }), /Campanha ativa agora: "vila-do-queijo-mofado"/);
      assert.match(await campanha(ctx, { acao: "ver" }), /"vila-do-queijo-mofado" \(ativa\).*resumo\.md; fichas: MODELO\.md/);
      await assert.rejects(campanha(ctx, { acao: "ativar", nome: "orc" }), MesaError);

      const log = createRollLogger(() => activeCampaignDir(root));
      await log({ quando: "x", rotulo: null, tipo: "outro", pedido: "1d6", expressao: "1d6", dados: "[3]", total: 3, d20: null, cd: null, resultado: null, secreta: false });
      await campanha(ctx, { acao: "ativar", nome: "principal" });
      await log({ quando: "y", rotulo: null, tipo: "outro", pedido: "1d6", expressao: "1d6", dados: "[5]", total: 5, d20: null, cd: null, resultado: null, secreta: false });
      assert.match(await readFile(path.join(root, "vila-do-queijo-mofado", "rolagens.jsonl"), "utf8"), /"total":3/);
      assert.match(await readFile(path.join(root, "principal", "rolagens.jsonl"), "utf8"), /"total":5/);
      assert.match(await campanha(ctx, { acao: "listar" }), /"principal" \(ativa\)/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("vincula uma campanha à sala do Owlbear e avisa quando a ativa é outra", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "campanhas-"));
    try {
      const table = new FakeTable([], sampleState({ roomId: "sala-A" }));
      const ctx = { table: memoryLink(table), campaignsRoot: root };
      await campanha(ctx, { acao: "criar", nome: "Queijo" });
      await campanha(ctx, { acao: "criar", nome: "Dragões" });

      assert.match(await campanha(ctx, { acao: "ver" }), /não está vinculada a nenhuma campanha/);
      assert.match(await campanha(ctx, { acao: "vincular", nome: "queijo" }), /"queijo" vinculada a esta sala do Owlbear e ativada/);
      assert.equal(JSON.parse(await readFile(path.join(root, "queijo", "sala.json"), "utf8")).sala, "sala-A");
      assert.match(await campanha(ctx, { acao: "listar" }), /"queijo" \(ativa\).*vinculada a uma sala do Owlbear.*\(É A DESTA SALA\)/);
      assert.match(await statusMesa(ctx), /Campanha: Esta sala do Owlbear é da campanha "queijo", que está ativa/);

      // Ativar outra campanha nesta sala dá aviso.
      assert.match(await campanha(ctx, { acao: "ativar", nome: "dragoes" }), /Atenção: esta sala do Owlbear é da campanha "queijo", mas a ativa é "dragoes"/);

      // Vincular a sala a outra campanha tira o vínculo da anterior.
      assert.match(await campanha(ctx, { acao: "vincular" }), /"dragoes" vinculada.*Antes a sala era de: queijo/);
      assert.equal(await campaignForRoom(root, "sala-A").then((c) => c?.slug), "dragoes");
      assert.match(await campanha(ctx, { acao: "desvincular" }), /não está mais vinculada/);
      assert.equal(await campaignForRoom(root, "sala-A"), null);

      // Sem mesa não dá para vincular.
      await assert.rejects(campanha({ table: memoryLink(null), campaignsRoot: root }, { acao: "vincular" }), MesaError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
