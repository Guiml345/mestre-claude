import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { catalogoTokens } from "./actions.js";
import { loadCatalog, resolveIcon, searchCatalog } from "./catalog.js";
import { FakeTable, mapItem, memoryLink, token } from "./testing.js";

const iconsDir = fileURLToPath(new URL("../../icons", import.meta.url));

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
});
