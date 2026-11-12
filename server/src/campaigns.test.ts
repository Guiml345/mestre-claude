import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { campanha } from "./actions.js";
import { activeCampaignDir, slugify } from "./campaigns.js";
import { MesaError } from "./errors.js";
import { createRollLogger } from "./rolllog.js";
import { memoryLink } from "./testing.js";

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
});
