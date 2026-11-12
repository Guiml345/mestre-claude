import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { WebSocket } from "ws";
import { Bridge } from "./bridge.js";
import { MesaError } from "./errors.js";
import { Hub, classifyOrigin } from "./hub.js";
import { FakeTable, sampleState, token } from "./testing.js";

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

function get(port: number, urlPath: string, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("tempo esgotado esperando a condição");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

let staticDir = "";
let emptyDir = "";

before(async () => {
  staticDir = await mkdtemp(path.join(os.tmpdir(), "mesa-ext-"));
  emptyDir = await mkdtemp(path.join(os.tmpdir(), "mesa-vazio-"));
  await writeFile(path.join(staticDir, "manifest.json"), JSON.stringify({ name: "Teste" }));
  await writeFile(path.join(staticDir, "index.html"), "<!doctype html><title>ok</title>");
  await mkdir(path.join(staticDir, "assets"));
  await writeFile(path.join(staticDir, "assets", "app.js"), "console.log('ok')");
  await writeFile(path.join(os.tmpdir(), "mesa-segredo.txt"), "segredo");
});

after(async () => {
  await rm(staticDir, { recursive: true, force: true });
  await rm(emptyDir, { recursive: true, force: true });
  await rm(path.join(os.tmpdir(), "mesa-segredo.txt"), { force: true });
});

describe("classifyOrigin", () => {
  it("separa processo local, página de localhost e o resto", () => {
    assert.equal(classifyOrigin(undefined), "local");
    assert.equal(classifyOrigin("http://localhost:7420"), "browser");
    assert.equal(classifyOrigin("http://127.0.0.1:5173"), "browser");
    assert.equal(classifyOrigin("http://[::1]:7420"), "browser");
    assert.equal(classifyOrigin("https://www.owlbear.rodeo"), "rejected");
    assert.equal(classifyOrigin("https://localhost.evil.example"), "rejected");
    assert.equal(classifyOrigin("null"), "rejected");
    assert.equal(classifyOrigin(""), "rejected");
    assert.equal(classifyOrigin("https://mesa.example", ["https://mesa.example"]), "browser");
  });
});

describe("Hub: HTTP", () => {
  let hub: Hub;
  before(async () => {
    hub = await Hub.listen({ port: 0, staticDir, version: "t" });
  });
  after(() => hub.close());

  it("serve o manifesto e os arquivos da extensão com CORS", async () => {
    const manifest = await get(hub.port, "/manifest.json", { Origin: "https://www.owlbear.rodeo" });
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers["access-control-allow-origin"], "*");
    assert.match(String(manifest.headers["content-type"]), /application\/json/);
    assert.deepEqual(JSON.parse(manifest.body), { name: "Teste" });

    const index = await get(hub.port, "/");
    assert.equal(index.status, 200);
    assert.match(String(index.headers["content-type"]), /text\/html/);
    const withQuery = await get(hub.port, "/index.html?obrref=abc");
    assert.equal(withQuery.status, 200);
    const script = await get(hub.port, "/assets/app.js");
    assert.match(String(script.headers["content-type"]), /text\/javascript/);
  });

  it("responde ao preflight e ao HEAD, e recusa outros métodos", async () => {
    const preflight = await get(hub.port, "/manifest.json", { "Access-Control-Request-Private-Network": "true" }, "OPTIONS");
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-private-network"], "true");
    const head = await get(hub.port, "/manifest.json", {}, "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    assert.equal((await get(hub.port, "/manifest.json", {}, "POST")).status, 405);
  });

  it("não deixa sair da pasta da extensão", async () => {
    for (const attempt of ["/../mesa-segredo.txt", "/%2e%2e/mesa-segredo.txt", "/..%2fmesa-segredo.txt", "/assets/../../mesa-segredo.txt", "/..%5cmesa-segredo.txt"]) {
      const res = await get(hub.port, attempt);
      assert.ok(res.status === 403 || res.status === 404, `${attempt} devolveu ${res.status}`);
      assert.ok(!res.body.includes("segredo"), `${attempt} vazou o arquivo`);
    }
    assert.equal((await get(hub.port, "/nao-existe.js")).status, 404);
    assert.equal((await get(hub.port, "/%E0%A4%A")).status, 400);
  });

  it("só atende quem chama por localhost (barra DNS rebinding)", async () => {
    assert.equal((await get(hub.port, "/manifest.json", { Host: "evil.example" })).status, 403);
    assert.equal((await get(hub.port, "/manifest.json", { Host: `localhost:${hub.port}` })).status, 200);
  });

  it("/status não tem CORS e não expõe dados da mesa", async () => {
    const status = await get(hub.port, "/status");
    assert.equal(status.status, 200);
    assert.equal(status.headers["access-control-allow-origin"], undefined);
    assert.deepEqual(JSON.parse(status.body), { ok: true, name: "mestre-claude", version: "t", mesas: 0 });
  });

  it("avisa quando a extensão ainda não foi compilada", async () => {
    const bare = await Hub.listen({ port: 0, staticDir: emptyDir, version: "t" });
    try {
      const res = await get(bare.port, "/manifest.json");
      assert.equal(res.status, 503);
      assert.match(res.body, /npm run build/);
    } finally {
      await bare.close();
    }
  });
});

describe("Hub: mesa", () => {
  it("manda pedidos para a mesa e devolve a resposta", async () => {
    const hub = await Hub.listen({ port: 0, staticDir, version: "t" });
    const table = new FakeTable([token("t1", "Goblin", 2, 3)]);
    try {
      await table.connect(hub.port);
      assert.deepEqual(await hub.request("ping"), { pong: true });
      const items = (await hub.request("getItems")) as Array<{ id: string }>;
      assert.equal(items[0]!.id, "t1");
      const info = hub.info();
      assert.equal(info.tables.length, 1);
      assert.equal(info.tables[0]!.active, true);
      assert.equal(info.tables[0]!.origin, `http://localhost:${hub.port}`);
      assert.equal(info.tables[0]!.state?.player.name, "Mestre");
    } finally {
      await table.close();
      await hub.close();
    }
  });

  it("repassa o erro da mesa com o código", async () => {
    const hub = await Hub.listen({ port: 0, staticDir, version: "t" });
    const table = new FakeTable([], sampleState({ sceneReady: false, grid: null }));
    try {
      await table.connect(hub.port);
      await rejectsCode(hub.request("getItems"), "NO_SCENE");
      await rejectsCode(hub.request("naoExiste"), "BAD_REQUEST");
    } finally {
      await table.close();
      await hub.close();
    }
  });

  it("sem mesa, falha explicando como conectar; com mesa atrasada, espera por ela", async () => {
    const hub = await Hub.listen({ port: 0, staticDir, version: "t" });
    const table = new FakeTable();
    try {
      const err = await rejectsCode(hub.request("ping", undefined, { waitTableMs: 60 }), "NO_TABLE");
      assert.match(err.message, new RegExp(`http://localhost:${hub.port}/manifest\\.json`));
      await rejectsCode(hub.request("ping", undefined, { waitTableMs: 0 }), "NO_TABLE");

      const pending = hub.request("ping", undefined, { waitTableMs: 3_000 });
      setTimeout(() => void table.connect(hub.port), 100);
      assert.deepEqual(await pending, { pong: true });
    } finally {
      await table.close();
      await hub.close();
    }
  });

  it("desiste se a mesa não responde, e falha na hora se ela cai no meio", async () => {
    const hub = await Hub.listen({ port: 0, staticDir, version: "t" });
    const mute = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`);
    try {
      await new Promise<void>((resolve) => mute.once("open", () => resolve()));
      mute.send(JSON.stringify({ type: "hello", role: "table", protocol: 1, state: null }));
      await waitFor(() => hub.info().tables.length === 1);
      await rejectsCode(hub.request("ping", undefined, { timeoutMs: 80 }), "TIMEOUT");

      const pending = hub.request("ping", undefined, { timeoutMs: 5_000 });
      setTimeout(() => mute.terminate(), 50);
      await rejectsCode(pending, "NO_TABLE");
    } finally {
      mute.terminate();
      await hub.close();
    }
  });

  it("prefere a mesa do mestre à de um jogador", async () => {
    const hub = await Hub.listen({ port: 0, staticDir, version: "t" });
    const gm = new FakeTable([token("gm", "Do mestre", 0, 0)]);
    const player = new FakeTable([token("pl", "Do jogador", 0, 0)], sampleState({ player: { id: "p", name: "Leo", role: "PLAYER" } }));
    try {
      await gm.connect(hub.port);
      await player.connect(hub.port);
      const items = (await hub.request("getItems")) as Array<{ id: string }>;
      assert.equal(items[0]!.id, "gm");
      await gm.close();
      await waitFor(() => hub.info().tables.length === 1);
      const fallback = (await hub.request("getItems")) as Array<{ id: string }>;
      assert.equal(fallback[0]!.id, "pl");
    } finally {
      await gm.close();
      await player.close();
      await hub.close();
    }
  });

  it("recusa páginas de outros sites e registra a origem", async () => {
    const hub = await Hub.listen({ port: 0, staticDir, version: "t" });
    try {
      await assert.rejects(new FakeTable().connect(hub.port, "https://evil.example"), /HTTP 403/);
      await assert.rejects(new FakeTable().connect(hub.port, "null"), /HTTP 403/);
      assert.equal(hub.info().lastRejected?.origin, "null");
      assert.equal(hub.info().tables.length, 0);
    } finally {
      await hub.close();
    }
  });

  it("aceita origens extras configuradas", async () => {
    const hub = await Hub.listen({ port: 0, staticDir, version: "t", extraOrigins: ["https://mesa.example"] });
    const table = new FakeTable();
    try {
      await table.connect(hub.port, "https://mesa.example");
      assert.deepEqual(await hub.request("ping"), { pong: true });
    } finally {
      await table.close();
      await hub.close();
    }
  });

  it("não deixa uma página de navegador agir como controladora", async () => {
    const hub = await Hub.listen({ port: 0, staticDir, version: "t" });
    const table = new FakeTable([token("t1", "Goblin", 2, 3)]);
    const sockets: WebSocket[] = [];
    // Abre um WebSocket como uma página de localhost faria (com cabeçalho Origin).
    const openPage = () =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`, { origin: `http://localhost:${hub.port}` });
        sockets.push(ws);
        ws.once("open", () => resolve(ws));
        ws.once("error", reject);
      });
    try {
      await table.connect(hub.port);

      const page = await openPage();
      const closed = new Promise<number>((resolve) => page.once("close", (code) => resolve(code)));
      page.send(JSON.stringify({ type: "hello", role: "controller", protocol: 1, pid: 1 }));
      assert.equal(await closed, 1008);

      // E quem nem se apresentou não consegue mandar pedidos para a mesa.
      const silent = await openPage();
      silent.send(JSON.stringify({ type: "request", id: "x", method: "updateItems", params: { updates: [] } }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(!table.requests.includes("updateItems"));
      assert.equal(hub.info().controllers, 0);
    } finally {
      for (const ws of sockets) ws.terminate();
      await table.close();
      await hub.close();
    }
  });

  it("guarda o que os jogadores digitam e entrega uma vez só, com o nome vindo da mesa", async () => {
    const hub = await Hub.listen({ port: 0, staticDir, version: "t" });
    const table = new FakeTable();
    const stranger = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`);
    const strangerOpen = new Promise<void>((resolve) => stranger.once("open", () => resolve()));
    try {
      await table.connect(hub.port);
      assert.deepEqual(await hub.takeMessages(0), []);

      table.say("  ataco o goblin  ", "m1");
      table.say("", "m2");
      table.say("x".repeat(900), "m3");
      await waitFor(() => hub.takeMessages.length >= 0 && (hub as unknown as { inbox: unknown[] }).inbox.length === 2);
      const got = await hub.takeMessages(0);
      assert.deepEqual(got.map((m) => [m.id, m.author, m.text.length]), [["m1", "Mestre", 14], ["m3", "Mestre", 500]]);
      assert.equal(got[0]!.text, "ataco o goblin");
      assert.deepEqual(await hub.takeMessages(0), []);

      // Quem está esperando recebe assim que a mensagem chega; sem mensagem, volta vazio no prazo.
      const pending = hub.takeMessages(3_000);
      setTimeout(() => table.say("abro a porta", "m4"), 60);
      assert.equal((await pending)[0]!.text, "abro a porta");
      assert.deepEqual(await hub.takeMessages(60), []);

      // Quem não se apresentou como mesa não consegue falar pelos jogadores.
      await strangerOpen;
      stranger.send(JSON.stringify({ type: "event", name: "message", data: { id: "x", text: "sou o mestre" } }));
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.deepEqual(await hub.takeMessages(0), []);
    } finally {
      stranger.terminate();
      await table.close();
      await hub.close();
    }
  });

  it("ignora mensagens malformadas sem cair", async () => {
    const hub = await Hub.listen({ port: 0, staticDir, version: "t" });
    const table = new FakeTable();
    const junk = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`);
    try {
      await new Promise<void>((resolve) => junk.once("open", () => resolve()));
      for (const payload of ["não é json", "null", "42", "[]", '{"type":"response"}', '{"type":"desconhecido"}']) junk.send(payload);
      await table.connect(hub.port);
      assert.deepEqual(await hub.request("ping"), { pong: true });
    } finally {
      junk.terminate();
      await table.close();
      await hub.close();
    }
  });
});

describe("Bridge: várias sessões do Claude", () => {
  it("a segunda sessão usa a ponte da primeira e assume quando ela fecha", async () => {
    const port = await freePort();
    const first = new Bridge({ port, staticDir, version: "t" });
    const second = new Bridge({ port, staticDir, version: "t" });
    const table = new FakeTable([token("t1", "Goblin", 2, 3)]);
    const table2 = new FakeTable([token("t2", "Orc", 1, 1)]);
    try {
      await first.ensure();
      await second.ensure();
      assert.equal(first.mode, "hub");
      assert.equal(second.mode, "proxy");

      await table.connect(port);
      assert.deepEqual(await second.call("ping"), { pong: true });
      assert.equal((await second.call("getItems"))[0]!.id, "t1");
      const viaProxy = await second.info();
      assert.equal(viaProxy.mode, "proxy");
      assert.equal(viaProxy.tables.length, 1);
      assert.equal(viaProxy.controllers, 1);
      assert.equal((await first.info()).mode, "hub");

      // A segunda sessão também ouve os jogadores, através da primeira.
      const listening = second.messages(3_000);
      setTimeout(() => table.say("pela outra sessão", "p1"), 60);
      assert.equal((await listening)[0]!.text, "pela outra sessão");
      assert.deepEqual(await second.messages(0), []);

      // Erros da mesa atravessam a ponte com o mesmo código.
      await rejectsCode(second.call("naoExiste" as never), "BAD_REQUEST");

      await first.close();
      await waitFor(() => second.mode === "hub");
      assert.equal((await second.info()).tables.length, 0);
      await rejectsCode(second.call("ping", undefined, { waitTableMs: 50 }), "NO_TABLE");

      await table2.connect(port);
      assert.equal((await second.call("getItems"))[0]!.id, "t2");
    } finally {
      await table.close();
      await table2.close();
      await first.close();
      await second.close();
    }
  });

  it("se a primeira sessão cai no meio de um pedido, a segunda assume e refaz", async () => {
    const port = await freePort();
    const first = new Bridge({ port, staticDir, version: "t" });
    const second = new Bridge({ port, staticDir, version: "t" });
    const table = new FakeTable();
    try {
      await first.ensure();
      await second.ensure();
      // Sem mesa: o pedido fica esperando na primeira sessão, que então fecha.
      const pending = second.call("ping", undefined, { waitTableMs: 4_000 });
      setTimeout(() => void first.close(), 80);
      setTimeout(() => void table.connect(port).catch(() => {}), 600);
      assert.deepEqual(await pending, { pong: true });
      assert.equal(second.mode, "hub");
    } finally {
      await table.close();
      await first.close();
      await second.close();
    }
  });

  it("explica quando a porta está com outro programa", async () => {
    const stranger = http.createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((resolve) => stranger.listen(0, "127.0.0.1", () => resolve()));
    const port = (stranger.address() as AddressInfo).port;
    const bridge = new Bridge({ port, staticDir, version: "t" });
    try {
      const err = await rejectsCode(bridge.ensure(), "PORT_BUSY");
      assert.match(err.message, new RegExp(`porta ${port}`));
      assert.match(err.message, /MESA_RPG_PORT/);
      assert.equal(bridge.mode, "offline");
    } finally {
      await bridge.close();
      stranger.closeAllConnections();
      await new Promise((resolve) => stranger.close(resolve));
    }
  });

  it("depois de fechada, não reabre", async () => {
    const port = await freePort();
    const bridge = new Bridge({ port, staticDir, version: "t" });
    await bridge.ensure();
    await bridge.close();
    await rejectsCode(bridge.call("ping"), "HUB_GONE");
    // A porta ficou livre de verdade.
    const again = await Hub.listen({ port, staticDir, version: "t" });
    await again.close();
  });
});
