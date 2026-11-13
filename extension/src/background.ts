/**
 * Página de segundo plano da extensão. Fica carregada enquanto a sala está aberta.
 * No navegador do mestre, conecta na ponte do Claude e executa os pedidos dele
 * usando o SDK do Owlbear. Em todos os navegadores, mostra os avisos do mestre.
 */
import OBR, { Command, buildImage, buildLabel, buildPath, isImage, type Image, type Item, type PathCommand } from "@owlbear-rodeo/sdk";
import type { ItemUpdate, RawItem, TableState, WireMessage } from "../../server/src/protocol";
import {
  CH_ANNOUNCE,
  CH_CAMERA,
  CH_HOST,
  CH_SAY,
  CH_SAY_REJECT,
  CAMERA_KEY,
  HOST_KEY,
  TURN_ALERT_KEY,
  CH_STATUS,
  CH_STATUS_REQUEST,
  EXT_ID,
  COMBAT_KEY,
  CONFIG_KEY,
  INVENTORY_KEY,
  SAY_KEY,
  VERSION,
  appendLog,
  bridgeUrl,
  parseAnnouncement,
  parseCombat,
  parseConfig,
  parseInventory,
  parseSay,
  readFlag,
  turnGate,
  writeFlag,
  saveStatus,
  type BridgeState,
  type BridgeStatus,
} from "./shared";

const BRIDGE_URL = bridgeUrl();
const RETRY_MS = 3_000;
const NOTIFICATION_MAX = 240;

class TableError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let socket: WebSocket | null = null;
/**
 * Na sala podem estar ativas duas cópias da extensão (a servida pelo computador do
 * mestre e a do GitHub Pages). Quando a outra cópia, neste mesmo navegador, está
 * ligada ao Claude, esta fica quieta para não repetir avisos, câmera e alertas.
 */
let otherInstanceIsHost = false;

function quiet(): boolean {
  return otherInstanceIsHost && status.state !== "conectado";
}
let connecting = false;
let status: BridgeStatus = { state: "procurando", url: BRIDGE_URL };
const shown = new Set<string>();

// ------------------------------------------------------------------- status

function publishStatus(): void {
  saveStatus(status);
  void OBR.broadcast.sendMessage(CH_STATUS, status, { destination: "LOCAL" }).catch(() => {});
}

function setStatus(state: BridgeState): void {
  if (status.state === state) return;
  const wasOnline = status.state === "conectado";
  status = { state, url: BRIDGE_URL };
  publishStatus();
  if (state === "conectado") writeFlag(HOST_KEY, true);
  // Só quem esteve ou está ligado ao Claude avisa os outros; um jogador comum não fala nada.
  if (wasOnline || state === "conectado") announceHost();
  // Selo no ícone da extensão: dá para ver que o Claude está ligado sem abrir o painel.
  void OBR.action.setBadgeBackgroundColor("#2e7d32").catch(() => {});
  void OBR.action.setBadgeText(state === "conectado" ? "on" : undefined).catch(() => {});
}

// ------------------------------------------------------------------ pedidos

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const raw = err as { message?: unknown; error?: { message?: unknown } };
    if (typeof raw.error?.message === "string") return raw.error.message;
    if (typeof raw.message === "string") return raw.message;
    try {
      return JSON.stringify(err);
    } catch {
      return "erro desconhecido";
    }
  }
  return String(err);
}

async function requireScene(): Promise<void> {
  if (!(await OBR.scene.isReady())) {
    throw new TableError("NO_SCENE", "Nenhuma cena aberta no Owlbear Rodeo. Abra uma cena e tente de novo.");
  }
}

async function getState(): Promise<TableState> {
  const sceneReady = await OBR.scene.isReady();
  const [name, role, party] = await Promise.all([OBR.player.getName(), OBR.player.getRole(), OBR.party.getPlayers()]);

  let grid: TableState["grid"] = null;
  if (sceneReady) {
    const [dpi, scale, type, measurement] = await Promise.all([
      OBR.scene.grid.getDpi(),
      OBR.scene.grid.getScale(),
      OBR.scene.grid.getType(),
      OBR.scene.grid.getMeasurement(),
    ]);
    grid = {
      dpi,
      type,
      measurement,
      scale: {
        raw: scale.raw,
        multiplier: scale.parsed.multiplier,
        unit: scale.parsed.unit,
        digits: scale.parsed.digits,
      },
    };
  }

  return {
    extensionVersion: VERSION,
    roomId: OBR.room.id,
    sceneReady,
    player: { id: OBR.player.id, name, role },
    party: party.map((player) => ({ id: player.id, name: player.name, role: player.role })),
    grid,
  };
}

function serialize(item: Item): RawItem {
  const raw: RawItem = {
    id: item.id,
    type: item.type,
    name: item.name,
    layer: item.layer,
    position: { x: item.position.x, y: item.position.y },
    rotation: item.rotation,
    scale: { x: item.scale.x, y: item.scale.y },
    visible: item.visible,
    locked: item.locked,
  };
  if (item.attachedTo) raw.attachedTo = item.attachedTo;
  if (isImage(item)) {
    raw.text = item.text?.plainText ?? "";
    raw.image = { width: item.image.width, height: item.image.height, url: item.image.url };
    raw.grid = { dpi: item.grid.dpi, offset: { x: item.grid.offset.x, y: item.grid.offset.y } };
  }
  return raw;
}

async function getItems(params: unknown): Promise<RawItem[]> {
  await requireScene();
  const layers = (params as { layers?: unknown } | undefined)?.layers;
  const items = await OBR.scene.items.getItems();
  const wanted = Array.isArray(layers) ? items.filter((item) => layers.includes(item.layer)) : items;
  return wanted.map(serialize);
}

function isFinitePoint(point: unknown): point is { x: number; y: number } {
  if (!point || typeof point !== "object") return false;
  const { x, y } = point as { x?: unknown; y?: unknown };
  return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y);
}

async function updateItems(params: unknown): Promise<{ updated: number }> {
  await requireScene();
  const updates = (params as { updates?: unknown } | undefined)?.updates;
  if (!Array.isArray(updates)) throw new TableError("BAD_REQUEST", "updateItems precisa de uma lista `updates`.");

  const byId = new Map<string, ItemUpdate>();
  for (const update of updates as ItemUpdate[]) {
    if (update && typeof update.id === "string") byId.set(update.id, update);
  }

  let updated = 0;
  await OBR.scene.items.updateItems([...byId.keys()], (drafts) => {
    for (const draft of drafts) {
      const update = byId.get(draft.id);
      if (!update) continue;
      // Uma posição inválida faria o token sumir do mapa, então é ignorada.
      if (isFinitePoint(update.position)) draft.position = { x: update.position.x, y: update.position.y };
      if (typeof update.visible === "boolean") draft.visible = update.visible;
      if (typeof update.locked === "boolean") draft.locked = update.locked;
      if (typeof update.text === "string" && draft.type === "IMAGE") {
        const image = draft as unknown as Image;
        image.text.plainText = update.text;
        image.text.richText = [{ type: "paragraph", children: [{ text: update.text }] }];
      }
      updated++;
    }
  });
  return { updated };
}

async function cloneItems(params: unknown): Promise<{ ids: string[] }> {
  await requireScene();
  const raw = params as { sourceId?: unknown; copies?: unknown } | undefined;
  if (typeof raw?.sourceId !== "string" || !Array.isArray(raw.copies)) {
    throw new TableError("BAD_REQUEST", "cloneItems precisa de `sourceId` e `copies`.");
  }
  const [source] = await OBR.scene.items.getItems([raw.sourceId]);
  if (!source || !isImage(source)) throw new TableError("TOKEN_NOT_FOUND", "O token modelo não está mais na cena.");

  const items = (raw.copies as Array<{ position?: unknown; text?: unknown; visible?: unknown }>)
    .slice(0, 10)
    .filter((copy) => isFinitePoint(copy.position))
    .map((copy) => {
      const label = typeof copy.text === "string" ? copy.text.slice(0, 60) : "";
      const position = copy.position as { x: number; y: number };
      return buildImage({ ...source.image }, { dpi: source.grid.dpi, offset: { ...source.grid.offset } })
        .name(source.name)
        .layer(source.layer)
        .position({ x: position.x, y: position.y })
        .scale({ ...source.scale })
        .rotation(source.rotation)
        .visible(typeof copy.visible === "boolean" ? copy.visible : source.visible)
        .locked(false)
        .text({ ...source.text, plainText: label, richText: [{ type: "paragraph", children: [{ text: label }] }] })
        .textItemType(source.textItemType)
        .build();
    });
  if (items.length === 0) throw new TableError("BAD_REQUEST", "Nenhuma posição válida para criar tokens.");
  await OBR.scene.items.addItems(items);
  return { ids: items.map((item) => item.id) };
}

/** Endereços de onde a extensão aceita criar tokens (o catálogo publicado com ela). */
const IMAGE_HOSTS = ["https://guiml345.github.io/"];

/** Cria tokens a partir de uma imagem publicada (ex.: o catálogo de tokens), um por posição. */
async function addImages(params: unknown): Promise<{ ids: string[] }> {
  await requireScene();
  const raw = params as { url?: unknown; size?: unknown; tokens?: unknown; layer?: unknown } | undefined;
  const url = typeof raw?.url === "string" ? raw.url : "";
  if (!IMAGE_HOSTS.some((host) => url.startsWith(host))) {
    throw new TableError("BAD_REQUEST", "Só crio tokens com imagens do catálogo publicado.");
  }
  const size = typeof raw?.size === "number" && raw.size > 0 ? raw.size : 256;
  const layer = raw?.layer === "PROP" ? "PROP" : "CHARACTER";
  const list = (Array.isArray(raw?.tokens) ? raw.tokens : []) as Array<{ position?: unknown; text?: unknown; visible?: unknown; name?: unknown }>;
  const items = list
    .slice(0, 10)
    .filter((t) => isFinitePoint(t.position))
    .map((t) => {
      const position = t.position as { x: number; y: number };
      const label = typeof t.text === "string" ? t.text.slice(0, 60) : "";
      return buildImage({ width: size, height: size, mime: "image/png", url }, { dpi: size, offset: { x: size / 2, y: size / 2 } })
        .name(typeof t.name === "string" ? t.name.slice(0, 60) : label || "Token")
        .layer(layer)
        .position({ x: position.x, y: position.y })
        .visible(typeof t.visible === "boolean" ? t.visible : true)
        .plainText(label)
        .build();
    });
  if (items.length === 0) throw new TableError("BAD_REQUEST", "Nenhuma posição válida para criar tokens.");
  await OBR.scene.items.addItems(items);
  return { ids: items.map((item) => item.id) };
}

async function deleteItems(params: unknown): Promise<{ deleted: number }> {
  await requireScene();
  const ids = (params as { ids?: unknown } | undefined)?.ids;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
    throw new TableError("BAD_REQUEST", "deleteItems precisa de uma lista `ids`.");
  }
  await OBR.scene.items.deleteItems(ids.slice(0, 20) as string[]);
  return { deleted: Math.min(ids.length, 20) };
}

async function getCombat(): Promise<unknown> {
  return parseCombat((await OBR.room.getMetadata())[COMBAT_KEY]);
}

async function setCombat(params: unknown): Promise<{ saved: true }> {
  const raw = (params as { combat?: unknown } | undefined)?.combat;
  const combat = raw === null ? undefined : parseCombat(raw);
  if (raw !== null && !combat) throw new TableError("BAD_REQUEST", "Combate inválido.");
  await OBR.room.setMetadata({ [COMBAT_KEY]: combat });
  return { saved: true };
}

// ------------------------------------------------------------------- névoa

/** Marca as formas de névoa criadas pelo Mestre Claude (as do mestre humano ficam intocadas). */
const FOG_TAG = `${EXT_ID}/nevoa`;

/** Estado da névoa: preenchimento, formas, e o item cru de cada uma (para diagnóstico). */
async function fogState(): Promise<unknown> {
  await requireScene();
  const filled = await OBR.scene.fog.getFilled();
  const items = await OBR.scene.items.getItems((item) => item.layer === "FOG");
  return {
    filled,
    areas: items.slice(0, 60).map((item) => ({
      id: item.id,
      name: item.name,
      visible: item.visible,
      ours: Boolean(item.metadata[FOG_TAG]),
      raw: item,
    })),
  };
}

async function fogSetFilled(params: unknown): Promise<{ filled: boolean }> {
  await requireScene();
  const filled = Boolean((params as { filled?: unknown } | undefined)?.filled);
  await OBR.scene.fog.setFilled(filled);
  return { filled };
}

/** Cria retângulos de névoa (em pixels da cena). `cut` faz a forma recortar a névoa, revelando a área. */
async function fogAddRects(params: unknown): Promise<{ ids: string[] }> {
  await requireScene();
  const raw = params as { rects?: unknown; cut?: unknown; name?: unknown } | undefined;
  if (!Array.isArray(raw?.rects)) throw new TableError("BAD_REQUEST", "fogAddRects precisa de `rects`.");
  const name = typeof raw.name === "string" ? raw.name.slice(0, 60) : "Névoa";
  const rects = (raw.rects as Array<{ x?: unknown; y?: unknown; w?: unknown; h?: unknown }>)
    .slice(0, 20)
    .filter((r) => [r.x, r.y, r.w, r.h].every((v) => typeof v === "number" && Number.isFinite(v)) && (r.w as number) > 0 && (r.h as number) > 0) as Array<{ x: number; y: number; w: number; h: number }>;
  if (rects.length === 0) throw new TableError("BAD_REQUEST", "Nenhum retângulo válido.");
  const commands: PathCommand[] = [];
  for (const r of rects) {
    commands.push([Command.MOVE, r.x, r.y], [Command.LINE, r.x + r.w, r.y], [Command.LINE, r.x + r.w, r.y + r.h], [Command.LINE, r.x, r.y + r.h], [Command.CLOSE]);
  }
  const item = buildPath()
    .commands(commands)
    .fillRule("nonzero")
    .layer("FOG")
    .name(name)
    .fillColor("#222222")
    .fillOpacity(1)
    .strokeWidth(0)
    .visible(!raw.cut)
    .metadata({ [FOG_TAG]: { area: name } })
    .build();
  await OBR.scene.items.addItems([item]);
  return { ids: [item.id] };
}

/** Recorta (revela) ou volta a cobrir formas de névoa criadas pelo Mestre Claude. */
async function fogSetCut(params: unknown): Promise<{ updated: number }> {
  await requireScene();
  const raw = params as { ids?: unknown; cut?: unknown } | undefined;
  if (!Array.isArray(raw?.ids)) throw new TableError("BAD_REQUEST", "fogSetCut precisa de `ids`.");
  const ids = (raw.ids as unknown[]).filter((id): id is string => typeof id === "string");
  let updated = 0;
  await OBR.scene.items.updateItems(ids, (drafts) => {
    for (const draft of drafts) {
      if (draft.layer !== "FOG" || !draft.metadata[FOG_TAG]) continue;
      draft.visible = !raw.cut;
      updated++;
    }
  });
  return { updated };
}

async function fogDelete(params: unknown): Promise<{ deleted: number }> {
  await requireScene();
  const ids = (params as { ids?: unknown } | undefined)?.ids;
  const wanted = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : null;
  const ours = await OBR.scene.items.getItems((item) => item.layer === "FOG" && Boolean(item.metadata[FOG_TAG]) && (!wanted || wanted.includes(item.id)));
  await OBR.scene.items.deleteItems(ours.map((item) => item.id));
  return { deleted: ours.length };
}

async function announce(params: unknown): Promise<{ delivered: true }> {
  const announcement = parseAnnouncement(params);
  if (!announcement) throw new TableError("BAD_REQUEST", "Aviso inválido.");
  present(announcement);
  // "ALL" leva o aviso aos outros jogadores (e aos outros painéis deste navegador).
  await OBR.broadcast.sendMessage(CH_ANNOUNCE, announcement, { destination: "ALL" });
  return { delivered: true };
}

const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
  ping: async () => ({ pong: true }),
  getState,
  getItems,
  updateItems,
  announce,
  cloneItems,
  addImages,
  deleteItems,
  getCombat,
  setCombat,
  getConfig: async () => parseConfig((await OBR.room.getMetadata())[CONFIG_KEY]),
  getInventory: async () => parseInventory((await OBR.room.getMetadata())[INVENTORY_KEY]),
  setInventory: async (params: unknown) => {
    const inventory = parseInventory((params as { inventory?: unknown } | undefined)?.inventory);
    await OBR.room.setMetadata({ [INVENTORY_KEY]: inventory });
    return { saved: true };
  },
  setConfig: async (params: unknown) => {
    const current = parseConfig((await OBR.room.getMetadata())[CONFIG_KEY]);
    const next = parseConfig({ ...current, ...((params && typeof params === "object" ? params : {}) as object) });
    await OBR.room.setMetadata({ [CONFIG_KEY]: next });
    return next;
  },
  focus,
  setMarkers,
  fogState,
  fogSetFilled,
  fogAddRects,
  fogSetCut,
  fogDelete,
};

// ------------------------------------------------------------------- avisos

/** Mostra um aviso na tela do Owlbear e guarda no registro. Ignora repetidos. */
function present(data: unknown): void {
  const announcement = parseAnnouncement(data);
  if (quiet() || !announcement || shown.has(announcement.id)) return;
  if (shown.size > 500) shown.clear();
  shown.add(announcement.id);
  appendLog(OBR.room.id, announcement);
  // Fala de jogador só entra no registro; não precisa de aviso na tela.
  if (announcement.kind === "jogador") return;

  const text =
    announcement.text.length > NOTIFICATION_MAX
      ? `${announcement.text.slice(0, NOTIFICATION_MAX - 1)}…`
      : announcement.text;
  const visibleFor = Math.min(6_000 + text.length * 45, 15_000);
  void OBR.notification
    .show(text, announcement.variant)
    .then((id) => setTimeout(() => void OBR.notification.close(id).catch(() => {}), visibleFor))
    .catch(() => {});
}


// ------------------------------------------------------- marcas de condição

/** Marca as etiquetas de condição criadas pelo Mestre Claude. */
const MARKER_TAG = `${EXT_ID}/condicao`;

/**
 * Troca as etiquetas de condição presas a um token pelas da lista (vazia = tira todas).
 * A etiqueta fica presa ao token: anda com ele e some se ele for removido.
 */
async function setMarkers(params: unknown): Promise<{ markers: number }> {
  await requireScene();
  const raw = params as { tokenId?: unknown; conditions?: unknown } | undefined;
  if (typeof raw?.tokenId !== "string") throw new TableError("BAD_REQUEST", "setMarkers precisa de `tokenId`.");
  const tokenId = raw.tokenId;
  const conditions = (Array.isArray(raw.conditions) ? raw.conditions : [])
    .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    .map((c) => c.trim().slice(0, 30))
    .slice(0, 6);

  const old = await OBR.scene.items.getItems((item) => item.attachedTo === tokenId && Boolean(item.metadata[MARKER_TAG]));
  if (old.length) await OBR.scene.items.deleteItems(old.map((item) => item.id));
  if (conditions.length === 0) return { markers: 0 };

  const [token] = await OBR.scene.items.getItems([tokenId]);
  if (!token) throw new TableError("TOKEN_NOT_FOUND", "O token não está mais na cena.");
  const bounds = await OBR.scene.items.getItemBounds([tokenId]);
  const label = buildLabel()
    .name("Condições")
    .plainText(conditions.join(" · "))
    .fontSize(14)
    .fontWeight(600)
    .backgroundColor("#7a1f1f")
    .backgroundOpacity(0.9)
    .pointerDirection("DOWN")
    .position({ x: bounds.center.x, y: bounds.min.y })
    .attachedTo(tokenId)
    .layer("ATTACHMENT")
    .locked(true)
    .disableHit(true)
    .visible(token.visible)
    .metadata({ [MARKER_TAG]: { conditions } })
    .build();
  await OBR.scene.items.addItems([label]);
  return { markers: 1 };
}

// ---------------------------------------------------------- fala do jogador

const said = new Set<string>();

/** Nome de quem mandou, pela lista de jogadores do Owlbear (não pelo que a mensagem diz). */
/** O mestre da sala pode falar a qualquer momento, mesmo fora da vez. */
async function authorIsGm(connectionId: string | null): Promise<boolean> {
  const mine = await OBR.player.getConnectionId().catch(() => "");
  if (!connectionId || connectionId === mine) return (await OBR.player.getRole().catch(() => "PLAYER")) === "GM";
  const players = await OBR.party.getPlayers().catch(() => []);
  return players.find((p) => p.connectionId === connectionId)?.role === "GM";
}

async function authorOf(connectionId: string | null): Promise<string> {
  const mine = await OBR.player.getConnectionId().catch(() => "");
  if (!connectionId || connectionId === mine) return OBR.player.getName().catch(() => "Jogador");
  const players = await OBR.party.getPlayers().catch(() => []);
  return players.find((p) => p.connectionId === connectionId)?.name ?? "Jogador";
}

/**
 * Leva ao Claude o que um jogador digitou no painel. Só o navegador ligado ao
 * Claude faz isso; ele confere se é a vez de quem escreveu.
 */
async function forwardSay(data: unknown, connectionId: string | null): Promise<void> {
  const ws = socket;
  if (!ws || status.state !== "conectado") return;
  const say = parseSay(data);
  if (!say || said.has(say.id)) return;
  if (said.size > 500) said.clear();
  said.add(say.id);

  const author = await authorOf(connectionId);
  const combat = parseCombat((await OBR.room.getMetadata().catch(() => ({})) as Record<string, unknown>)[COMBAT_KEY]);
  const gate = (await authorIsGm(connectionId)) ? { allowed: true, reason: "" } : turnGate(combat, author);
  if (!gate.allowed) {
    void OBR.broadcast.sendMessage(CH_SAY_REJECT, { id: say.id, reason: gate.reason }, { destination: "ALL" }).catch(() => {});
    return;
  }

  send(ws, { type: "event", name: "message", data: { id: say.id, text: say.text, author } });
  const entry = { id: say.id, text: `${author}: ${say.text}`, variant: "DEFAULT", kind: "jogador", at: new Date().toISOString() };
  present(entry);
  void OBR.broadcast.sendMessage(CH_ANNOUNCE, entry, { destination: "ALL" }).catch(() => {});
}

// ------------------------------------------------------------------ câmera

const cameraSeen = new Set<string>();

/** Leva a visão deste navegador até a área, se a pessoa deixou "Câmera segue a ação" ligada. */
function applyCamera(data: unknown): void {
  const raw = data as { id?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null;
  if (quiet() || !raw || typeof raw.id !== "string" || cameraSeen.has(raw.id)) return;
  const [x, y, w, h] = [raw.x, raw.y, raw.w, raw.h];
  if (![x, y, w, h].every((v) => typeof v === "number" && Number.isFinite(v)) || (w as number) <= 0 || (h as number) <= 0) return;
  cameraSeen.add(raw.id);
  if (cameraSeen.size > 200) cameraSeen.clear();
  if (!readFlag(CAMERA_KEY, true)) return;
  const min = { x: x as number, y: y as number };
  const max = { x: min.x + (w as number), y: min.y + (h as number) };
  // Só desliza até o centro da área, mantendo o zoom que a pessoa escolheu.
  const center = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2 };
  void Promise.all([OBR.viewport.getScale(), OBR.viewport.getWidth(), OBR.viewport.getHeight()])
    .then(([scale, width, height]) =>
      OBR.viewport.animateTo({ scale, position: { x: width / 2 - center.x * scale, y: height / 2 - center.y * scale } }),
    )
    .catch(() => {});
}

async function focus(params: unknown): Promise<{ sent: true }> {
  const raw = params as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | undefined;
  const area = { id: crypto.randomUUID(), x: raw?.x, y: raw?.y, w: raw?.w, h: raw?.h };
  applyCamera(area);
  await OBR.broadcast.sendMessage(CH_CAMERA, area, { destination: "REMOTE" });
  return { sent: true };
}

// ------------------------------------------------------------ anfitrião

/** Avisa os outros navegadores se o Claude está no ar por este aqui. */
function announceHost(): void {
  const online = status.state === "conectado";
  void OBR.broadcast.sendMessage(CH_HOST, { online }, { destination: "ALL" }).catch(() => {});
}

// -------------------------------------------------------------------- ponte

function send(ws: WebSocket, message: WireMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

async function sendState(): Promise<void> {
  const ws = socket;
  if (!ws || status.state !== "conectado") return;
  try {
    send(ws, { type: "event", name: "state", data: await getState() });
  } catch {
    // A sala pode estar fechando; o próximo pedido busca o estado de novo.
  }
}

async function handleMessage(ws: WebSocket, raw: unknown): Promise<void> {
  let message: WireMessage;
  try {
    message = JSON.parse(String(raw)) as WireMessage;
  } catch {
    return;
  }
  if (!message || typeof message !== "object") return;

  if (message.type === "welcome") {
    setStatus("conectado");
    return;
  }
  if (message.type !== "request") return;

  const { id, method, params } = message;
  try {
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
    if (!handler) throw new TableError("BAD_REQUEST", `Método desconhecido: ${method}`);
    send(ws, { type: "response", id, ok: true, result: await handler(params) });
  } catch (err) {
    send(ws, {
      type: "response",
      id,
      ok: false,
      error: { code: err instanceof TableError ? err.code : "TABLE_ERROR", message: describeError(err) },
    });
  }
}

function connect(): void {
  connecting = true;
  let ws: WebSocket;
  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch {
    setTimeout(connect, RETRY_MS);
    return;
  }
  socket = ws;

  ws.addEventListener("open", () => {
    void getState()
      .catch(() => null)
      .then((state) => send(ws, { type: "hello", role: "table", protocol: 1, state }));
  });
  ws.addEventListener("message", (event) => void handleMessage(ws, event.data));
  ws.addEventListener("close", () => {
    if (socket === ws) socket = null;
    setStatus("procurando");
    // O Claude pode não estar aberto ainda: continua tentando.
    // O Claude pode não estar aberto ainda: continua tentando, a não ser que outra
    // cópia da extensão neste navegador já esteja ligada a ele.
    setTimeout(() => {
      if (!otherInstanceIsHost) connect();
    }, RETRY_MS);
  });
}

// ------------------------------------------------------------------ partida

OBR.onReady(async () => {
  OBR.broadcast.onMessage(CH_ANNOUNCE, (event) => present(event.data));
  OBR.broadcast.onMessage(CH_STATUS_REQUEST, () => {
    publishStatus();
    if (status.state === "conectado") announceHost();
  });
  // Falas vêm do painel deste navegador e dos painéis dos outros jogadores.
  OBR.broadcast.onMessage(CH_SAY, (event) => void forwardSay(event.data, event.connectionId));
  window.addEventListener("storage", (event) => {
    if (event.key !== SAY_KEY || !event.newValue) return;
    try {
      void forwardSay(JSON.parse(event.newValue), null);
    } catch {
      // Valor estranho no armazenamento: ignora.
    }
  });
  OBR.broadcast.onMessage(CH_CAMERA, (event) => applyCamera(event.data));
  OBR.broadcast.onMessage(CH_HOST, (event) => {
    if (status.state === "conectado") return;
    void OBR.player.getConnectionId().then((mine) => {
      if (event.connectionId === mine) otherInstanceIsHost = (event.data as { online?: unknown } | null)?.online === true;
    });
  });
  void OBR.room.getMetadata().then((meta) => checkMyTurn(meta)).catch(() => {});
  OBR.room.onMetadataChange((meta) => void checkMyTurn(meta));
  // Enquanto estiver no ar, lembra os outros de tempos em tempos (quem entrou depois fica sabendo).
  setInterval(() => {
    if (status.state === "conectado") announceHost();
  }, 10_000);

  // Conecta se for o mestre, ou se este navegador já esteve ligado ao Claude antes
  // (é o computador que roda o Claude, mesmo jogando sem ser mestre). Os outros
  // jogadores não tentam: não têm o Claude rodando na máquina deles.
  const role = await OBR.player.getRole();
  if (role === "GM" || readFlag(HOST_KEY, false)) {
    publishStatus();
    connect();
  } else {
    setStatus("jogador");
  }

  OBR.player.onChange((player) => {
    if (player.role === "GM" && !connecting) {
      setStatus("procurando");
      connect();
    }
    void sendState();
  });
  OBR.scene.onReadyChange(() => void sendState());
  OBR.party.onChange(() => void sendState());
});

// ------------------------------------------------------------ aviso de vez

let lastTurnKey: string | null = null;

/** Dois bipes curtos. */
function beep(): void {
  try {
    const audio = new AudioContext();
    for (const [start, freq] of [[0, 880], [0.18, 1175]] as const) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.12, audio.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + start + 0.15);
      osc.connect(gain).connect(audio.destination);
      osc.start(audio.currentTime + start);
      osc.stop(audio.currentTime + start + 0.16);
    }
    setTimeout(() => void audio.close().catch(() => {}), 1_000);
  } catch {
    // Sem som (o navegador pode bloquear): fica só o aviso na tela.
  }
}

/** Quando a vez passa para um personagem desta pessoa: som, aviso e painel aberto na aba Mesa. */
async function checkMyTurn(meta: Record<string, unknown>): Promise<void> {
  if (quiet()) return;
  const combat = parseCombat(meta[COMBAT_KEY]);
  const current = combat?.combatentes[combat.vez];
  const key = combat && current ? `${combat.rodada}:${combat.vez}:${current.id}` : "";
  const first = lastTurnKey === null;
  if (key === lastTurnKey) return;
  lastTurnKey = key;
  // Ao abrir a sala não avisa: só quando a vez muda depois.
  if (first || !combat || !current?.jogador || current.pv <= 0 && current.lado !== "jogador") return;
  const me = await OBR.player.getName().catch(() => "");
  if (current.jogador.trim().toLowerCase() !== me.trim().toLowerCase()) return;
  if (!readFlag(TURN_ALERT_KEY, true)) return;
  beep();
  void OBR.notification.show(`Sua vez: ${current.nome}!`, "INFO").catch(() => {});
  try {
    localStorage.setItem("mestre-claude/aba", "mesa");
  } catch {
    // Só não troca a aba.
  }
  void OBR.action.open().catch(() => {});
}
