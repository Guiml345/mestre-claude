/** Painel da extensão: mostra se o Claude está conectado e o registro de rolagens e avisos. */
import OBR, { type Theme } from "@owlbear-rodeo/sdk";
import type { Announcement, Combat, Inventory, InventoryCharacter, TableConfig } from "../../server/src/protocol";
import {
  CH_ANNOUNCE,
  CH_HOST,
  CH_SAY,
  CH_SAY_REJECT,
  CAMERA_KEY,
  TURN_ALERT_KEY,
  CH_STATUS,
  CH_STATUS_REQUEST,
  COMBAT_KEY,
  CONFIG_KEY,
  INVENTORY_KEY,
  SAY_KEY,
  bridgeUrl,
  clearLog,
  isLogKey,
  isStatusKey,
  loadLog,
  loadStatus,
  parseAnnouncement,
  parseCombat,
  parseConfig,
  parseInventory,
  parseStatus,
  readFlag,
  turnGate,
  writeFlag,
  type BridgeStatus,
  type Say,
} from "./shared";
import { initSheets } from "./fichas";
import "./style.css";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Elemento #${id} não existe na página.`);
  return found as T;
}

const statusEl = element<HTMLSpanElement>("status");
const hintEl = element<HTMLParagraphElement>("hint");
const emptyEl = element<HTMLParagraphElement>("empty");
const logEl = element<HTMLOListElement>("log");
const clearEl = element<HTMLButtonElement>("clear");
const sayForm = element<HTMLFormElement>("say");
const sayText = element<HTMLInputElement>("say-text");
const sayButton = element<HTMLButtonElement>("say-send");
const expandEl = element<HTMLButtonElement>("expand");

const entries = new Map<string, Announcement>();
/** Falas que este painel mandou (para marcar as recusadas). */
const pending = new Set<string>();

const STATUS_TEXT: Record<BridgeStatus["state"], { label: string; hint: string }> = {
  conectado: { label: "Claude conectado", hint: "" },
  procurando: {
    label: "Procurando o Claude…",
    hint: "Abra o Claude Code na pasta do projeto. A extensão se conecta sozinha em alguns segundos.",
  },
  jogador: {
    label: "Aguardando o mestre",
    hint: "O Claude roda no computador do mestre. Quando ele estiver no ar, você joga por aqui.",
  },
};

let ownStatus: BridgeStatus | null = null;
/** Última vez que o navegador ligado ao Claude avisou que está no ar (outro computador). */
let hostSeenAt = 0;
let currentCombat: Combat | null = null;
let myName = "";
let paused = false;

function hostOnline(): boolean {
  return ownStatus?.state === "conectado" || Date.now() - hostSeenAt < 25_000;
}

/** Atualiza o selo de status e libera ou trava a caixa de texto. */
function refresh(): void {
  const online = hostOnline();
  const state = online ? "conectado" : (ownStatus?.state ?? "procurando");
  const text = STATUS_TEXT[state];
  statusEl.dataset.state = state;
  statusEl.textContent = text.label;
  hintEl.textContent = text.hint;
  hintEl.hidden = !text.hint;

  // O mestre da sala pode falar a qualquer momento (pausar, corrigir, encerrar um combate).
  const gate = isGm ? { allowed: true, reason: "" } : turnGate(currentCombat, myName);
  sayText.disabled = sayButton.disabled = !online || !gate.allowed;
  sayText.placeholder = !online ? "Aguardando o Claude conectar…" : !gate.allowed ? gate.reason : paused ? "Mestre em pausa: sua mensagem fica guardada" : "O que você faz?";
  if (online && paused) {
    statusEl.dataset.state = "pausa";
    statusEl.textContent = "Mestre em pausa";
  }
}

function renderStatus(status: BridgeStatus | null): void {
  ownStatus = status;
  refresh();
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function renderLog(): void {
  // Ordem de chat: o mais antigo em cima, o mais novo embaixo, junto da caixa de texto.
  const sorted = [...entries.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // Só rola para o fim se a pessoa já estava lá embaixo (não atrapalha quem está relendo).
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  logEl.replaceChildren(
    ...sorted.map((entry) => {
      const item = document.createElement("li");
      item.dataset.variant = entry.variant;
      item.dataset.kind = entry.kind;
      const time = document.createElement("time");
      time.dateTime = entry.at;
      time.textContent = formatTime(entry.at);
      const text = document.createElement("span");
      // Sempre como texto puro: o conteúdo vem da sala e não é confiável.
      text.textContent = entry.text;
      item.append(time, text);
      return item;
    }),
  );
  emptyEl.hidden = sorted.length > 0;
  clearEl.hidden = sorted.length === 0;
  if (atBottom || forceScroll) logEl.scrollTop = logEl.scrollHeight;
  forceScroll = false;
}

let forceScroll = true;

// Tamanhos do painel: normal e expandido.
const SIZES = { normal: { width: 340, height: 420 }, expandido: { width: 560, height: 760 } };
const EXPAND_KEY = "mestre-claude/expandido";

function loadExpanded(): boolean {
  try {
    return localStorage.getItem(EXPAND_KEY) === "1";
  } catch {
    return false;
  }
}

async function applySize(expanded: boolean): Promise<void> {
  const size = expanded ? SIZES.expandido : SIZES.normal;
  expandEl.textContent = expanded ? "⤡" : "⤢";
  expandEl.title = expandEl.ariaLabel = expanded ? "Reduzir o painel" : "Expandir o painel";
  try {
    localStorage.setItem(EXPAND_KEY, expanded ? "1" : "0");
  } catch {
    // Sem armazenamento: o tamanho só não fica lembrado.
  }
  await Promise.all([OBR.action.setWidth(size.width), OBR.action.setHeight(size.height)]).catch(() => {});
  forceScroll = true;
  renderLog();
}

function reloadLog(roomId: string): void {
  entries.clear();
  for (const entry of loadLog(roomId)) entries.set(entry.id, entry);
  renderLog();
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme.mode === "LIGHT" ? "light" : "dark";
  root.style.setProperty("--text", theme.text.primary);
  root.style.setProperty("--muted", theme.text.secondary);
  root.style.setProperty("--accent", theme.primary.main);
  // Fundo do painel do Owlbear: usado no que fica fixo por cima do conteúdo que rola.
  root.style.setProperty("--panel-bg", theme.background.paper);
}

if (!OBR.isAvailable) {
  // Aberta direto no navegador, fora do Owlbear.
  statusEl.dataset.state = "fora";
  statusEl.textContent = "Fora do Owlbear";
  hintEl.hidden = false;
  hintEl.textContent = `Esta página é a extensão Mestre Claude. Para usar, adicione no seu perfil do Owlbear Rodeo o endereço ${new URL("manifest.json", location.href).href} e ative a extensão na sala. Ponte: ${bridgeUrl()}`;
} else {
  OBR.onReady(async () => {
    const roomId = OBR.room.id;

    void OBR.theme.getTheme().then(applyTheme);
    OBR.theme.onChange(applyTheme);

    renderStatus(loadStatus());
    reloadLog(roomId);

    let expanded = loadExpanded();
    if (expanded) void applySize(true);
    expandEl.addEventListener("click", () => {
      expanded = !expanded;
      void applySize(expanded);
    });

    OBR.broadcast.onMessage(CH_STATUS, (event) => renderStatus(parseStatus(event.data)));
    OBR.broadcast.onMessage(CH_ANNOUNCE, (event) => {
      const entry = parseAnnouncement(event.data);
      if (!entry) return;
      entries.set(entry.id, entry);
      renderLog();
    });
    // A página de segundo plano grava o registro e o status; isto pega mudanças
    // feitas enquanto o painel estava fechado ou que não chegaram pelo canal.
    window.addEventListener("storage", (event) => {
      if (isLogKey(event.key, roomId)) reloadLog(roomId);
      if (isStatusKey(event.key)) renderStatus(loadStatus());
    });

    const playerName = await OBR.player.getName().catch(() => "Jogador");
    sayForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = sayText.value.trim();
      if (!text) return;
      const say: Say = { id: crypto.randomUUID(), text };
      sayText.value = "";
      // Mostra na hora no registro; a página de segundo plano grava e envia ao Claude.
      entries.set(say.id, { id: say.id, text: `${playerName}: ${text}`, variant: "DEFAULT", kind: "jogador", at: new Date().toISOString() });
      forceScroll = true;
      renderLog();
      // "ALL": chega ao navegador ligado ao Claude, seja este ou o do mestre em outro computador.
      pending.add(say.id);
      void OBR.broadcast.sendMessage(CH_SAY, say, { destination: "ALL" }).catch(() => {});
      try {
        localStorage.setItem(SAY_KEY, JSON.stringify(say));
      } catch {
        // Sem armazenamento local: o canal de mensagens acima dá conta.
      }
    });

    clearEl.addEventListener("click", () => {
      clearLog(roomId);
      entries.clear();
      renderLog();
    });

    await OBR.broadcast.sendMessage(CH_STATUS_REQUEST, {}, { destination: "LOCAL" }).catch(() => {});
  });
}

// ------------------------------------------------------------------ combate

const combatEl = element<HTMLDivElement>("combat");

function healthWord(pv: number, max: number): string {
  if (pv <= 0) return "caído";
  if (pv >= max) return "ileso";
  return pv / max > 0.5 ? "ferido" : "muito ferido";
}

/** Ordem de iniciativa. PV em números só para os personagens dos jogadores. */
function renderCombat(combat: Combat | null): void {
  combatEl.hidden = !combat || combat.combatentes.length === 0;
  if (!combat || combatEl.hidden) {
    combatEl.replaceChildren();
    return;
  }
  const title = document.createElement("div");
  title.className = "combat-title";
  title.textContent = `⚔ Combate · Rodada ${combat.rodada}`;
  const list = document.createElement("ol");
  list.className = "combat-list";
  combat.combatentes.forEach((c, index) => {
    const li = document.createElement("li");
    li.dataset.side = c.lado;
    if (index === combat.vez) li.dataset.turn = "true";
    if (c.pv <= 0) li.dataset.down = "true";
    const init = document.createElement("span");
    init.className = "init";
    init.textContent = String(c.iniciativa);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = c.nome + (c.condicoes.length ? ` (${c.condicoes.join(", ")})` : "");
    const hp = document.createElement("span");
    hp.className = "hp";
    const showNumbers = c.lado !== "inimigo";
    hp.textContent = showNumbers ? `${c.pv}/${c.pvMax} PV` : healthWord(c.pv, c.pvMax);
    const bar = document.createElement("span");
    bar.className = "bar";
    bar.style.setProperty("--pct", `${Math.round((Math.max(c.pv, 0) / c.pvMax) * 100)}%`);
    if (!showNumbers) bar.hidden = true;
    li.append(init, name, hp, bar);
    list.append(li);
  });
  combatEl.replaceChildren(title, list);
}

if (OBR.isAvailable) {
  OBR.onReady(() => {
    const onRoom = (meta: Record<string, unknown>) => {
      currentCombat = parseCombat(meta[COMBAT_KEY]);
      paused = parseConfig(meta[CONFIG_KEY]).pausado;
      renderCombat(currentCombat);
      refresh();
    };
    void OBR.player.getName().then((name) => {
      myName = name;
      refresh();
    });
    void OBR.room.getMetadata().then(onRoom);
    OBR.room.onMetadataChange(onRoom);
    OBR.player.onChange((player) => {
      myName = player.name;
      refresh();
    });
    // O navegador ligado ao Claude avisa que está no ar.
    OBR.broadcast.onMessage(CH_HOST, (event) => {
      const online = (event.data as { online?: unknown } | null)?.online === true;
      hostSeenAt = online ? Date.now() : 0;
      refresh();
    });
    // Fala recusada por estar fora da vez.
    OBR.broadcast.onMessage(CH_SAY_REJECT, (event) => {
      const data = event.data as { id?: unknown; reason?: unknown } | null;
      if (typeof data?.id !== "string" || !pending.has(data.id)) return;
      const entry = entries.get(data.id);
      if (entry) entry.text += ` (não enviado: ${typeof data.reason === "string" ? data.reason.slice(0, 80) : "fora da vez"})`;
      renderLog();
    });
    // Pergunta logo quem está no ar, e reavalia de tempos em tempos (o aviso expira).
    void OBR.broadcast.sendMessage(CH_STATUS_REQUEST, {}, { destination: "ALL" }).catch(() => {});
    setInterval(refresh, 5_000);
  });
}

// -------------------------------------------------------------------- opções

const settingsEl = element<HTMLDivElement>("settings");
const gmSettingsEl = element<HTMLDivElement>("gm-settings");
const cameraOptEl = element<HTMLInputElement>("opt-camera");
const turnOptEl = element<HTMLInputElement>("opt-turno");
const pauseOptEl = element<HTMLInputElement>("opt-pausa");
const fogOptEl = element<HTMLInputElement>("opt-nevoa");
const narrationOptEl = element<HTMLSelectElement>("opt-narracao");
const difficultyOptEl = element<HTMLSelectElement>("opt-dificuldade");
const rulesOptEl = element<HTMLInputElement>("opt-regras");

/** Muda uma opção da mesa, partindo do valor mais recente guardado na sala. */
async function setRoomConfig(change: Partial<TableConfig>): Promise<void> {
  const current = parseConfig((await OBR.room.getMetadata())[CONFIG_KEY]);
  await OBR.room.setMetadata({ [CONFIG_KEY]: { ...current, ...change } });
}

if (OBR.isAvailable) {
  OBR.onReady(async () => {
    // Preferências de cada pessoa, guardadas só neste navegador.
    settingsEl.hidden = false;
    cameraOptEl.checked = readFlag(CAMERA_KEY, true);
    cameraOptEl.addEventListener("change", () => writeFlag(CAMERA_KEY, cameraOptEl.checked));
    turnOptEl.checked = readFlag(TURN_ALERT_KEY, true);
    turnOptEl.addEventListener("change", () => writeFlag(TURN_ALERT_KEY, turnOptEl.checked));

    // Opções da mesa: só o mestre da sala vê e muda.
    if ((await OBR.player.getRole()) !== "GM") return;
    gmSettingsEl.hidden = false;
    const apply = (meta: Record<string, unknown>) => {
      const config = parseConfig(meta[CONFIG_KEY]);
      pauseOptEl.checked = config.pausado;
      fogOptEl.checked = config.nevoa;
      narrationOptEl.value = config.narracao;
      difficultyOptEl.value = config.dificuldade;
      rulesOptEl.checked = config.regras;
    };
    apply(await OBR.room.getMetadata());
    OBR.room.onMetadataChange(apply);

    pauseOptEl.addEventListener("change", () => void setRoomConfig({ pausado: pauseOptEl.checked }));
    narrationOptEl.addEventListener("change", () => void setRoomConfig({ narracao: narrationOptEl.value as TableConfig["narracao"] }));
    difficultyOptEl.addEventListener("change", () => void setRoomConfig({ dificuldade: difficultyOptEl.value as TableConfig["dificuldade"] }));
    rulesOptEl.addEventListener("change", () => void setRoomConfig({ regras: rulesOptEl.checked }));
    fogOptEl.addEventListener("change", async () => {
      await setRoomConfig({ nevoa: fogOptEl.checked });
      // Desligada: o mapa todo aparece (ex.: os jogadores conseguiram o mapa do lugar).
      // Ligada de novo: volta a cobrir, mantendo as salas que já tinham sido reveladas.
      await OBR.scene.fog.setFilled(fogOptEl.checked).catch(() => {});
    });
  });
}

// --------------------------------------------------------------------- abas

const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".tabs [data-tab]"));
const TAB_KEY = "mestre-claude/aba";

function showTab(name: string): void {
  for (const tab of tabButtons) {
    const active = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", String(active));
    element<HTMLDivElement>(`tab-${tab.dataset.tab}`).hidden = !active;
  }
  try {
    localStorage.setItem(TAB_KEY, name);
  } catch {
    // Sem armazenamento: só não lembra a aba.
  }
  if (name === "mesa") {
    forceScroll = true;
    renderLog();
  }
}

for (const tab of tabButtons) tab.addEventListener("click", () => showTab(tab.dataset.tab ?? "mesa"));
try {
  const saved = localStorage.getItem(TAB_KEY);
  if (saved && tabButtons.some((b) => b.dataset.tab === saved)) showTab(saved);
} catch {
  // Fica na aba Mesa.
}

// --------------------------------------------------------------- inventário

const inventoryEl = element<HTMLDivElement>("inventory");
const newCharForm = element<HTMLFormElement>("new-char");
const newCharName = element<HTMLInputElement>("new-char-name");
let inventory: Inventory = { personagens: [] };
let isGm = false;
let inventoryDirty = false;

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Quem pode editar: o mestre, o dono do personagem, ou qualquer um se não tiver dono. */
function canEdit(c: InventoryCharacter): boolean {
  return isGm || !c.jogador || c.jogador.trim().toLowerCase() === myName.trim().toLowerCase();
}

/** Lê o inventário mais recente da sala, aplica a mudança e grava (não apaga a edição de outro jogador). */
let mutations: Promise<void> = Promise.resolve();

function mutate(change: (inv: Inventory) => void): Promise<void> {
  // Em fila: cliques rápidos em sequência não apagam um ao outro.
  mutations = mutations
    .catch(() => {})
    .then(async () => {
      const latest = parseInventory((await OBR.room.getMetadata())[INVENTORY_KEY]);
      change(latest);
      await OBR.room.setMetadata({ [INVENTORY_KEY]: parseInventory(latest) });
    });
  return mutations;
}

function editChar(id: string, change: (c: InventoryCharacter) => void): void {
  void mutate((inv) => {
    const c = inv.personagens.find((x) => x.id === id);
    if (c) change(c);
  });
}

function smallButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "icon-button";
  b.textContent = label;
  b.title = title;
  b.ariaLabel = title;
  b.addEventListener("click", onClick);
  return b;
}

/** Quando a pessoa sai de um campo, aplica o que mudou na sala enquanto ela digitava. */
function renderLater(): void {
  if (inventoryDirty) setTimeout(renderInventory, 0);
}

function renderInventory(): void {
  // Não redesenha enquanto alguém digita num campo do inventário.
  if (inventoryEl.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement) {
    inventoryDirty = true;
    return;
  }
  inventoryDirty = false;
  if (inventory.personagens.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Nenhum personagem ainda. Adicione o seu abaixo.";
    inventoryEl.replaceChildren(empty);
    return;
  }
  inventoryEl.replaceChildren(...inventory.personagens.map(renderCharacter));
}

function renderCharacter(c: InventoryCharacter): HTMLElement {
  const editable = canEdit(c);
  const card = document.createElement("article");
  card.className = "char";
  if (!editable) card.dataset.readonly = "true";

  const head = document.createElement("div");
  head.className = "char-head";
  const name = document.createElement("h3");
  name.textContent = c.nome;
  const owner = document.createElement("span");
  owner.className = "hint-inline";
  owner.textContent = c.jogador ? c.jogador : "sem dono";
  head.append(name, owner);
  if (isGm) {
    head.append(
      smallButton("×", `Tirar ${c.nome} do inventário`, () =>
        void mutate((inv) => {
          inv.personagens = inv.personagens.filter((x) => x.id !== c.id);
        }),
      ),
    );
  }

  const coins = document.createElement("div");
  coins.className = "coins";
  for (const coin of ["po", "pp", "pc"] as const) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.value = String(c.moedas[coin]);
    input.disabled = !editable;
    input.ariaLabel = `${coin} de ${c.nome}`;
    input.addEventListener("change", () => {
      const value = Math.max(0, Math.trunc(Number(input.value) || 0));
      editChar(c.id, (x) => {
        x.moedas[coin] = value;
      });
    });
    input.addEventListener("blur", renderLater);
    label.append(input, document.createTextNode(` ${coin}`));
    coins.append(label);
  }

  const list = document.createElement("ul");
  list.className = "items";
  for (const item of c.itens) {
    const li = document.createElement("li");
    const qty = document.createElement("span");
    qty.className = "qty";
    qty.textContent = `${item.qtd}×`;
    const text = document.createElement("span");
    text.className = "item-name";
    text.textContent = item.nome + (item.nota ? ` (${item.nota})` : "");
    li.append(qty, text);
    if (editable) {
      li.append(
        smallButton("−", `Tirar um ${item.nome}`, () =>
          editChar(c.id, (x) => {
            const it = x.itens.find((i) => i.id === item.id);
            if (!it) return;
            it.qtd -= 1;
            if (it.qtd <= 0) x.itens = x.itens.filter((i) => i.id !== item.id);
          }),
        ),
        smallButton("+", `Mais um ${item.nome}`, () =>
          editChar(c.id, (x) => {
            const it = x.itens.find((i) => i.id === item.id);
            if (it) it.qtd += 1;
          }),
        ),
        smallButton("×", `Descartar ${item.nome}`, () =>
          editChar(c.id, (x) => {
            x.itens = x.itens.filter((i) => i.id !== item.id);
          }),
        ),
      );
    }
    list.append(li);
  }
  if (c.itens.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Mochila vazia.";
    list.append(li);
  }

  card.append(head, coins, list);
  if (editable) {
    const form = document.createElement("form");
    form.className = "inline-form";
    form.autocomplete = "off";
    const itemName = document.createElement("input");
    itemName.type = "text";
    itemName.maxLength = 60;
    itemName.placeholder = "Novo item (ex.: Corda 15 m)";
    itemName.ariaLabel = `Novo item de ${c.nome}`;
    itemName.addEventListener("blur", renderLater);
    const add = document.createElement("button");
    add.type = "submit";
    add.textContent = "Pôr";
    form.append(itemName, add);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = itemName.value.trim();
      if (!value) return;
      itemName.value = "";
      editChar(c.id, (x) => {
        const same = x.itens.find((i) => i.nome.trim().toLowerCase() === value.toLowerCase());
        if (same) same.qtd += 1;
        else x.itens.push({ id: uid(), nome: value, qtd: 1 });
      });
    });
    card.append(form);
  }
  return card;
}

initSheets(element<HTMLDivElement>("sheets"), { isGm: () => isGm, myName: () => myName });

if (OBR.isAvailable) {
  OBR.onReady(async () => {
    isGm = (await OBR.player.getRole()) === "GM";
    myName = myName || (await OBR.player.getName());
    const apply = (meta: Record<string, unknown>) => {
      inventory = parseInventory(meta[INVENTORY_KEY]);
      renderInventory();
    };
    apply(await OBR.room.getMetadata());
    OBR.room.onMetadataChange(apply);
    OBR.player.onChange((player) => {
      isGm = player.role === "GM";
      renderInventory();
    });
    newCharForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const nome = newCharName.value.trim();
      if (!nome) return;
      newCharName.value = "";
      void mutate((inv) => {
        if (inv.personagens.some((c) => c.nome.trim().toLowerCase() === nome.toLowerCase())) return;
        inv.personagens.push({ id: uid(), nome, jogador: myName || undefined, moedas: { po: 0, pp: 0, pc: 0 }, itens: [] });
      });
    });
  });
}
