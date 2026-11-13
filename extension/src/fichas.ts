/**
 * Aba Fichas do painel: mostra a ficha de cada personagem e deixa o dono (ou o mestre)
 * editar tudo, inclusive trocar as magias preparadas e marcar espaços gastos.
 * As fichas ficam nos dados da sala; o Claude sincroniza com os arquivos JSON da campanha.
 */
import OBR from "@owlbear-rodeo/sdk";
import type { Ficha } from "../../server/src/protocol";
import {
  ATRIBUTOS,
  NOMES_ATRIBUTOS,
  checkSheet,
  classCantrips,
  modifier,
  parseSheet,
  preparableSpells,
  signed,
  spellLimits,
  type ClassTables,
  type SpellData,
} from "../../server/src/regras";
import { SHEETS_KEY, parseSheets } from "./shared";

interface Context {
  isGm: () => boolean;
  myName: () => string;
}

let ctx: Context;
let root: HTMLElement;
let fichas: Ficha[] = [];
let selected = "";
/** Escolha em andamento na lista de magias (sobrevive aos redesenhos); null = lista fechada. */
let picking: Set<string> | null = null;
let dirty = false;
let data: { spells: SpellData[]; byId: Map<string, SpellData>; tables: ClassTables } | null = null;
let dataError = "";

async function loadData(): Promise<void> {
  if (data || dataError) return;
  try {
    const [m, c] = await Promise.all([fetch("dados/magias.json").then((r) => r.json()), fetch("dados/classes.json").then((r) => r.json())]);
    const spells = m.magias as SpellData[];
    data = { spells, byId: new Map(spells.map((s) => [s.id, s])), tables: c as ClassTables };
  } catch (err) {
    dataError = `Não consegui carregar as magias (${(err as Error).message}).`;
  }
  render();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function canEdit(f: Ficha): boolean {
  const me = ctx.myName().trim().toLowerCase();
  return ctx.isGm() || !f.jogador || f.jogador.trim().toLowerCase() === me;
}

// ------------------------------------------------------------------ gravação

let queue: Promise<void> = Promise.resolve();

/** Lê a versão mais nova da sala, aplica a mudança na ficha e grava com novo carimbo. */
function edit(id: string, change: (f: Ficha) => void): void {
  queue = queue
    .catch(() => {})
    .then(async () => {
      const latest = parseSheets((await OBR.room.getMetadata())[SHEETS_KEY]);
      const f = latest.personagens.find((x) => x.id === id);
      if (!f) return;
      change(f);
      f.atualizadoEm = new Date().toISOString();
      await OBR.room.setMetadata({ [SHEETS_KEY]: latest });
    })
    .catch(async (err) => {
      await OBR.notification.show(`Não salvei a ficha: ${(err as Error).message}`, "ERROR").catch(() => {});
    });
}

// ------------------------------------------------------------------ desenho

function numberInput(value: number, label: string, editable: boolean, onChange: (n: number) => void, min = -99, max = 999): HTMLInputElement {
  const input = el("input", { type: "number", value: String(value), disabled: !editable, className: "num" });
  input.min = String(min);
  input.max = String(max);
  input.ariaLabel = label;
  input.addEventListener("change", () => {
    const n = Math.trunc(Number(input.value));
    if (Number.isFinite(n)) onChange(Math.min(Math.max(n, min), max));
  });
  input.addEventListener("blur", () => dirty && setTimeout(render, 0));
  return input;
}

function textInput(value: string, label: string, editable: boolean, onChange: (s: string) => void, max = 60): HTMLInputElement {
  const input = el("input", { type: "text", value, disabled: !editable, maxLength: max });
  input.ariaLabel = label;
  input.addEventListener("change", () => onChange(input.value.trim()));
  input.addEventListener("blur", () => dirty && setTimeout(render, 0));
  return input;
}

function spellDetails(s: SpellData, extra?: Node): HTMLDetailsElement {
  const tags = [s.nivel === 0 ? "truque" : `${s.nivel}º nível`, s.escola, s.concentracao ? "concentração" : "", s.ritual ? "ritual" : ""].filter(Boolean).join(" · ");
  const summary = el("summary", {}, ...(extra ? [extra] : []), el("span", { className: "spell-name" }, s.nome), el("span", { className: "hint-inline" }, ` ${tags}`));
  const body = el(
    "div",
    { className: "spell-body" },
    el("p", { className: "spell-meta" }, `Tempo: ${s.tempo} · Alcance: ${s.alcance} · Componentes: ${s.componentes} · Duração: ${s.duracao}`),
    ...s.texto.split("\n").map((p) => el("p", {}, p)),
  );
  return el("details", { className: "spell" }, summary, body);
}

function section(title: string, ...children: Array<Node | string>): HTMLElement {
  return el("section", { className: "sheet-section" }, el("h3", {}, title), ...children);
}

function renderSheet(f: Ficha): HTMLElement {
  const editable = canEdit(f);
  const set = (change: (x: Ficha) => void) => edit(f.id, change);
  const card = el("article", { className: "sheet" });
  if (!editable) card.dataset.readonly = "true";

  const classe = data?.tables.classes[f.classe]?.nome ?? f.classe;
  card.append(
    el("div", { className: "sheet-head" }, el("h2", {}, f.nome), el("span", { className: "hint-inline" }, f.jogador ? f.jogador : "sem dono")),
    el("p", { className: "sheet-sub" }, `${f.especie} · ${classe}${f.subclasse ? ` (${f.subclasse})` : ""} ${f.nivel}${f.antecedente ? ` · ${f.antecedente}` : ""}`),
  );

  if (f.pendencias?.length) {
    card.append(el("div", { className: "sheet-pending" }, el("strong", {}, "Falta decidir"), el("ul", {}, ...f.pendencias.map((p) => el("li", {}, p)))));
  }
  if (data) {
    const problems = checkSheet(f, data.spells, data.tables);
    if (problems.length) card.append(el("div", { className: "sheet-problems" }, el("strong", {}, "Fora da regra"), el("ul", {}, ...problems.map((p) => el("li", {}, p)))));
  }

  // PV, CA, iniciativa, deslocamento.
  const vitals = el(
    "div",
    { className: "vitals" },
    el("label", {}, "PV ", numberInput(f.pv.atual, "PV atuais", editable, (n) => set((x) => { x.pv.atual = n; }), -99, 999), " / ", numberInput(f.pv.max, "PV máximos", editable, (n) => set((x) => { x.pv.max = Math.max(n, 1); }), 1, 999)),
    el("label", {}, "Temp ", numberInput(f.pv.temp, "PV temporários", editable, (n) => set((x) => { x.pv.temp = Math.max(n, 0); }), 0, 999)),
    el("label", {}, "CA ", numberInput(f.ca, "Classe de armadura", editable, (n) => set((x) => { x.ca = n; }), 0, 40)),
    el("label", {}, "Inic. ", numberInput(f.iniciativa, "Iniciativa", editable, (n) => set((x) => { x.iniciativa = n; }), -10, 20)),
    el("label", {}, "Desl. ", textInput(f.deslocamento, "Deslocamento", editable, (s) => set((x) => { x.deslocamento = s || x.deslocamento; }), 20)),
  );
  card.append(vitals);

  // Atributos e salvaguardas.
  const attrs = el("div", { className: "attrs" });
  for (const a of ATRIBUTOS) {
    const score = f.atributos[a];
    const save = modifier(score) + (f.salvaguardas.includes(a) ? f.proficiencia : 0);
    attrs.append(
      el(
        "div",
        { className: "attr" },
        el("span", { className: "attr-name" }, NOMES_ATRIBUTOS[a]),
        numberInput(score, NOMES_ATRIBUTOS[a], editable, (n) => set((x) => { x.atributos[a] = n; }), 1, 30),
        el("span", { className: "attr-mod" }, signed(modifier(score))),
        el("span", { className: `attr-save${f.salvaguardas.includes(a) ? " prof" : ""}`, title: "Salvaguarda" }, `salv. ${signed(save)}`),
      ),
    );
  }
  card.append(attrs);
  card.append(el("p", { className: "hint-inline" }, `Proficiência ${signed(f.proficiencia)}${f.sentidos ? ` · ${f.sentidos}` : ""}${f.caNota ? ` · CA: ${f.caNota}` : ""}`));

  if (f.pericias.length) card.append(section("Perícias", el("p", {}, f.pericias.map((p) => `${p.nome} ${signed(p.bonus)}`).join(" · "))));
  if (f.ataques.length) {
    card.append(section("Ataques", el("ul", { className: "plain" }, ...f.ataques.map((a) => el("li", {}, el("strong", {}, a.nome), ` ${signed(a.bonus)} · ${a.dano}${a.nota ? ` · ${a.nota}` : ""}`)))));
  }
  if (f.caracteristicas.length) {
    card.append(section("Características", ...f.caracteristicas.map((c) => el("details", { className: "feature" }, el("summary", {}, c.nome), el("p", {}, c.texto)))));
  }
  if (f.magia && data) card.append(renderMagic(f, editable));

  // Notas.
  const notes = el("textarea", { value: f.notas ?? "", disabled: !editable, rows: 3, maxLength: 2000, placeholder: "Anotações do personagem" });
  notes.addEventListener("change", () => set((x) => { x.notas = notes.value.trim() || undefined; }));
  notes.addEventListener("blur", () => dirty && setTimeout(render, 0));
  card.append(section("Notas", notes));

  if (editable) card.append(renderRawEditor(f));
  return card;
}

function renderMagic(f: Ficha, editable: boolean): HTMLElement {
  const d = data!;
  const m = f.magia!;
  const limits = spellLimits(d.tables, f.classe, f.nivel);
  const box = section(`Magia · CD ${m.cd} · ataque ${signed(m.ataque)}`);
  if (!limits) return box;
  const name = (id: string) => d.byId.get(id);

  // Espaços: bolinhas; clicar marca ou desmarca um espaço gasto.
  const slots = el("div", { className: "slots" });
  limits.espacos.forEach((total, i) => {
    if (!total) return;
    const used = m.gastos[i] ?? 0;
    const row = el("div", { className: "slot-row" }, el("span", {}, `${i + 1}º`));
    for (let k = 0; k < total; k++) {
      const spent = k < used;
      const b = el("button", { type: "button", className: `slot${spent ? " spent" : ""}`, disabled: !editable, title: spent ? "Gasto (clique para recuperar)" : "Livre (clique para gastar)" });
      b.ariaLabel = `Espaço de ${i + 1}º nível ${spent ? "gasto" : "livre"}`;
      b.addEventListener("click", () =>
        edit(f.id, (x) => {
          const g = x.magia!.gastos;
          while (g.length <= i) g.push(0);
          g[i] = spent ? Math.max(0, (g[i] ?? 0) - 1) : Math.min(total, (g[i] ?? 0) + 1);
        }),
      );
      row.append(b);
    }
    slots.append(row);
  });
  box.append(slots);

  const list = (title: string, items: SpellData[]) =>
    items.length ? [el("h4", {}, title), ...items.map((s) => spellDetails(s))] : [];
  const sempre = [...new Set([...limits.sempre, ...m.sempre])].map(name).filter((s): s is SpellData => Boolean(s));
  box.append(
    ...list(`Truques (${m.truques.length})`, m.truques.map(name).filter((s): s is SpellData => Boolean(s))),
    ...list("Sempre preparadas", sempre),
    ...list("Extras", (m.extras ?? []).map((e) => name(e.id)).filter((s): s is SpellData => Boolean(s))),
  );
  box.append(el("h4", {}, `Preparadas (${m.preparadas.length}/${limits.preparadas})`));
  const prepared = m.preparadas.map(name).filter((s): s is SpellData => Boolean(s));
  box.append(...(prepared.length ? prepared.map((s) => spellDetails(s)) : [el("p", { className: "empty" }, "Nenhuma magia preparada.")]));

  if (editable) {
    const toggle = el("button", { type: "button", className: "wide" }, picking ? "Fechar sem salvar" : "Trocar magias preparadas");
    toggle.addEventListener("click", () => {
      picking = picking ? null : new Set(m.preparadas);
      render();
    });
    box.append(toggle);
    if (picking) box.append(renderPicker(f, limits.preparadas, new Set(sempre.map((s) => s.id))));
  }
  if (m.grimorio?.length) box.append(el("details", { className: "feature" }, el("summary", {}, `Grimório (${m.grimorio.length})`), el("p", {}, m.grimorio.map((id) => name(id)?.nome ?? id).join(", "))));
  const cantrips = classCantrips(d.spells, f.classe);
  if (cantrips.length) box.append(el("details", { className: "feature" }, el("summary", {}, `Truques da classe (${cantrips.length})`), ...cantrips.map((s) => spellDetails(s))));
  return box;
}

/** Lista de magias que a classe pode preparar no nível, com marcação até o limite. */
function renderPicker(f: Ficha, max: number, always: Set<string>): HTMLElement {
  const d = data!;
  const m = f.magia!;
  let options = preparableSpells(d.spells, d.tables, f.classe, f.nivel);
  // Mago só prepara o que está no grimório.
  if (f.classe === "mago" && m.grimorio?.length) options = options.filter((s) => m.grimorio!.includes(s.id));
  const chosen = picking ?? new Set(m.preparadas);
  const wrap = el("div", { className: "picker" });
  const counter = el("p", { className: "picker-count" });
  const boxes: HTMLInputElement[] = [];
  const refresh = () => {
    counter.textContent = `${chosen.size} de ${max} escolhidas${f.classe === "mago" ? " (do grimório)" : ""}. Troque no fim de um descanso longo.`;
    for (const b of boxes) if (!b.checked && !always.has(b.value)) b.disabled = chosen.size >= max;
  };
  let level = -1;
  for (const s of options) {
    if (s.nivel !== level) {
      level = s.nivel;
      wrap.append(el("h4", {}, `${level}º nível`));
    }
    const box = el("input", { type: "checkbox", value: s.id, checked: chosen.has(s.id) || always.has(s.id), disabled: always.has(s.id) });
    box.ariaLabel = `Preparar ${s.nome}`;
    box.addEventListener("change", () => {
      if (box.checked) chosen.add(s.id);
      else chosen.delete(s.id);
      refresh();
    });
    boxes.push(box);
    // A caixinha fica fora do título da magia: clicar nela marca, clicar no nome abre a descrição.
    wrap.append(el("div", { className: "pick-row" }, box, spellDetails(s)));
  }
  const save = el("button", { type: "button", className: "wide primary" }, "Salvar magias preparadas");
  save.addEventListener("click", () => {
    const list = [...chosen].filter((id) => !always.has(id));
    picking = null;
    edit(f.id, (x) => {
      x.magia!.preparadas = list;
      x.pendencias = x.pendencias?.filter((p) => !/magias? preparad|escolher .*magias?/i.test(p));
    });
  });
  wrap.prepend(counter);
  wrap.append(save);
  refresh();
  return wrap;
}

/** Edição de qualquer campo: a ficha inteira em JSON. */
function renderRawEditor(f: Ficha): HTMLElement {
  const area = el("textarea", { rows: 14, spellcheck: false, className: "raw" });
  const status = el("span", { className: "hint-inline" });
  const save = el("button", { type: "button" }, "Salvar JSON");
  const details = el("details", { className: "feature" }, el("summary", {}, "Editar a ficha inteira (JSON)"), area, el("div", { className: "row" }, save, status));
  details.addEventListener("toggle", () => {
    if (details.open) area.value = JSON.stringify({ ...f, id: undefined, atualizadoEm: undefined }, null, 2);
  });
  area.addEventListener("blur", () => dirty && setTimeout(render, 0));
  save.addEventListener("click", () => {
    let parsed: Ficha | null = null;
    try {
      parsed = parseSheet({ ...JSON.parse(area.value), id: f.id });
    } catch (err) {
      status.textContent = `JSON inválido: ${(err as Error).message}`;
      return;
    }
    if (!parsed) {
      status.textContent = "Falta nome ou classe.";
      return;
    }
    const next = parsed;
    edit(f.id, (x) => Object.assign(x, next, { id: f.id }));
    status.textContent = "Salvo.";
  });
  return details;
}

function render(): void {
  // Não redesenha enquanto alguém digita na ficha.
  const active = document.activeElement;
  if (root.contains(active) && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && active.type !== "checkbox") {
    dirty = true;
    return;
  }
  dirty = false;
  if (!fichas.length) {
    root.replaceChildren(el("p", { className: "empty" }, "Nenhuma ficha ainda. O Claude publica as fichas da campanha aqui."));
    return;
  }
  const me = ctx.myName().trim().toLowerCase();
  if (!fichas.some((f) => f.id === selected)) {
    selected = (fichas.find((f) => f.jogador?.trim().toLowerCase() === me) ?? fichas[0]!).id;
  }
  const chips = el(
    "div",
    { className: "chips" },
    ...fichas.map((f) => {
      const b = el("button", { type: "button", className: `chip${f.id === selected ? " active" : ""}` }, f.nome);
      b.addEventListener("click", () => {
        selected = f.id;
        picking = null;
        render();
      });
      return b;
    }),
  );
  const f = fichas.find((x) => x.id === selected)!;
  const scroll = root.scrollTop;
  root.replaceChildren(chips, ...(dataError ? [el("p", { className: "hint" }, dataError)] : []), renderSheet(f));
  root.scrollTop = scroll;
}

export function initSheets(target: HTMLElement, context: Context): void {
  root = target;
  ctx = context;
  render();
  void loadData();
  if (!OBR.isAvailable) return;
  OBR.onReady(async () => {
    const apply = (meta: Record<string, unknown>) => {
      fichas = parseSheets(meta[SHEETS_KEY]).personagens;
      render();
    };
    apply(await OBR.room.getMetadata());
    OBR.room.onMetadataChange(apply);
    // O Owlbear avisa mudança do jogador a toda hora (seleção, câmera); só redesenha se mudar quem ele é.
    let who = "";
    OBR.player.onChange((p) => {
      const now = `${p.role}|${p.name}`;
      if (now !== who) {
        who = now;
        render();
      }
    });
  });
}

