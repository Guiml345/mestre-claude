import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { catalogoTokens } from "./actions.js";
import { findRole, loadCatalog, loadRoles, resolveIcon, searchCatalog } from "./catalog.js";
import { normalize } from "./grid.js";
import { FakeTable, mapItem, memoryLink, token } from "./testing.js";

const iconsDir = fileURLToPath(new URL("../../icons", import.meta.url));
const rolesFile = fileURLToPath(new URL("../papeis.json", import.meta.url));

describe("catálogo de tokens", () => {
  it("lê os ícones e busca por nome em inglês", async () => {
    const list = await loadCatalog(iconsDir);
    assert.ok(list.length > 4000);
    assert.equal(searchCatalog(list, "goblin")[0]!.name, "goblin");
    assert.ok(searchCatalog(list, "wolf head").every((i) => i.name.includes("wolf") && i.name.includes("head")));
    assert.deepEqual(searchCatalog(list, "xyzzy"), []);
    assert.equal(resolveIcon(list, "lorc/wolf-head").icon?.author, "lorc");
  });

  it("cria tokens numa casa e em volta, numerando os rótulos", async () => {
    const table = new FakeTable([mapItem("m", "Mapa", 20, 14), token("a", "Lobo", 2, 2)]);
    const ctx = { table: memoryLink(table), iconsDir };
    const text = await catalogoTokens(ctx, { acao: "criar", icone: "wolf head", quantidade: 3, para: { coluna: 8, linha: 5 }, rotulo: "Lobo" });
    assert.match(text, /Criei 3 token\(s\) com o ícone lorc\/wolf-head/);
    const made = table.items.filter((i) => i.id.startsWith("img-"));
    assert.deepEqual(made.map((i) => i.text), ["Lobo 2", "Lobo 3", "Lobo 4"]);
    assert.ok(made.some((i) => Math.floor(i.position.x / 150) === 8 && Math.floor(i.position.y / 150) === 5));
    assert.match(await catalogoTokens(ctx, { acao: "buscar", icone: "dragon" }), /dragon/);
  });

  it("todos os papéis prontos apontam para ícones que existem", async () => {
    const list = await loadCatalog(iconsDir);
    const roles = await loadRoles(rolesFile);
    assert.ok(roles.length > 60);
    for (const r of roles) {
      for (const icon of [r.icone, ...r.alternativas]) {
        const [author, name] = icon.split("/");
        assert.ok(list.some((i) => i.author === author && i.name === name), `${r.nome}: ${icon} não existe`);
      }
    }
    // Nenhum nome ou sinônimo aparece em dois papéis.
    const seen = new Map<string, string>();
    for (const r of roles) {
      for (const n of [r.nome, ...r.sinonimos]) {
        const key = normalize(n);
        assert.ok(!seen.has(key) || seen.get(key) === r.nome, `"${n}" está em ${seen.get(key)} e ${r.nome}`);
        seen.set(key, r.nome);
      }
    }
  });

  it("acha papel por nome ou sinônimo, sem acento", async () => {
    const roles = await loadRoles(rolesFile);
    assert.equal(findRole(roles, "Taverneira")?.icone, "delapouite/cook");
    assert.equal(findRole(roles, "clerigo")?.nome, "clérigo");
    assert.equal(findRole(roles, "PADRE")?.nome, "clérigo");
    assert.equal(findRole(roles, "lobo atroz")?.icone, "lorc/direwolf");
    assert.equal(findRole(roles, "wolf head"), null);
  });

  it("cria token pelo papel em português, com o rótulo do papel", async () => {
    const table = new FakeTable([mapItem("m", "Mapa", 20, 14)]);
    const ctx = { table: memoryLink(table), iconsDir, rolesFile };
    const text = await catalogoTokens(ctx, { acao: "criar", icone: "soldado", quantidade: 2, para: { coluna: 3, linha: 3 } });
    assert.match(text, /delapouite\/guards \(papel "guarda"\)/);
    assert.deepEqual(table.items.filter((i) => i.id.startsWith("img-")).map((i) => i.text), ["Guarda", "Guarda 2"]);
    assert.match(await catalogoTokens(ctx, { acao: "papeis" }), /• monstro: .*goblin.*troll/);
    assert.match(await catalogoTokens(ctx, { acao: "buscar", icone: "goblin" }), /Papel pronto "goblin": caro-asercion\/goblin/);
  });
});
