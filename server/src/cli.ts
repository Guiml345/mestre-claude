#!/usr/bin/env node
/**
 * Linha de comando para testar a mesa sem o Claude.
 * Uso: npm run mesa -- <comando>
 */
import { readFile, writeFile } from "node:fs/promises";
import {
  aguardarJogadores,
  anunciar,
  criarToken,
  removerToken,
  verMapa,
  nevoa,
  catalogoTokens,
  campanha,
  inventario,
  focarCamera,
  iniciarCombate,
  proximoTurno,
  alterarCombatente,
  verCombate,
  encerrarCombate,
  editarToken,
  listarTokens,
  moverToken,
  rolar,
  statusMesa,
  salvarCena,
  restaurarCena,
  type ActionContext,
} from "./actions.js";
import { Bridge } from "./bridge.js";
import { PROJECT_ROOT, VERSION, loadConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { createRollLogger } from "./rolllog.js";
import { activeCampaignDir } from "./campaigns.js";
import { loadRoles } from "./catalog.js";
import { contactSheet } from "./folha.js";
import path from "node:path";

const USAGE = `Mestre Claude ${VERSION} - comandos de teste

  npm run mesa -- servir                         mantém a ponte no ar (Ctrl+C para sair)
  npm run mesa -- status                         mostra se a mesa está conectada
  npm run mesa -- tokens [todas]                 lista os tokens da cena
  npm run mesa -- mover <token> <coluna> <linha> move para uma casa
  npm run mesa -- deslocar <token> <dcol> <dlin> move em casas a partir de onde está
  npm run mesa -- junto <token> <alvo>           move para o lado de outro token
  npm run mesa -- rotular <token> <rótulo>       muda o rótulo do token
  npm run mesa -- rolar <expressão> [rótulo]     rola dados
  npm run mesa -- anunciar <mensagem>            mostra um aviso na mesa
  npm run mesa -- aguardar [segundos]            espera um jogador digitar no painel
  npm run mesa -- escutar [minutos]              espera até alguém digitar (padrão 120 min) e sai
  npm run mesa -- criar <modelo> [qtd] [rótulo]  cria cópias de um token perto dele
  npm run mesa -- remover <token>                tira um token da cena
  npm run mesa -- salvar [nome=<cena>] [motivo]  grava a cena na campanha ativa
  npm run mesa -- restaurar [nome=<cena>] [listar|previa|anterior|sobras|forcar]  volta uma cena salva
  npm run mesa -- mapa <arquivo.jpg> [token raio] salva o mapa com a grade numerada
  npm run mesa -- folha <saida.png> papeis|<autor/nome>...  monta uma folha para conferir ícones`;

function integer(text: string | undefined, name: string): number {
  const value = Number.parseInt(text ?? "", 10);
  if (!Number.isInteger(value)) throw new Error(`Faltou um número inteiro em <${name}>.`);
  return value;
}

function required(text: string | undefined, name: string): string {
  if (!text) throw new Error(`Faltou <${name}>.`);
  return text;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "ajuda" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }

  const config = loadConfig();

  if (command === "folha") {
    // npm run mesa -- folha <saida.png> papeis | <autor/nome> [<autor/nome>...]
    // Não precisa da mesa: só monta a imagem para conferir os ícones.
    const out = required(rest[0], "arquivo de saída .png");
    const tokensDir = path.join(PROJECT_ROOT, "extension", "public", "tokens");
    let icons = rest.slice(1);
    let labels: string[] | undefined;
    if (icons[0] === "papeis") {
      const roles = await loadRoles(config.rolesFile);
      icons = roles.map((r) => r.icone);
      labels = roles.map((r) => r.nome);
    }
    if (icons.length === 0) throw new Error("Diga os ícones (autor/nome) ou `papeis`.");
    const { image, missing } = await contactSheet(tokensDir, icons, labels);
    await writeFile(out, image);
    console.log(`Folha com ${icons.length - missing.length} ícone(s) salva em ${out}.`);
    if (missing.length) console.log(`Sem imagem (rode npm run build:tokens ou confira o nome): ${missing.join(", ")}`);
    return;
  }

  const bridge = new Bridge({
    port: config.port,
    staticDir: config.staticDir,
    version: VERSION,
    extraOrigins: config.extraOrigins,
    log: (message) => console.error(`[mesa] ${message}`),
  });
  // A extensão tenta reconectar a cada poucos segundos, então a linha de comando espera um pouco por ela.
  const campaignDir = async () => config.campaignDir ?? activeCampaignDir(config.campaignsRoot);
  const ctx: ActionContext = { table: bridge, logRoll: createRollLogger(campaignDir), campaignsRoot: config.campaignsRoot, campaignDir, iconsDir: config.iconsDir, rolesFile: config.rolesFile, dataDir: config.dataDir, waitTableMs: 10_000 };

  try {
    await bridge.ensure();
    switch (command) {
      case "servir":
        if (bridge.mode !== "hub") {
          console.log("Já existe uma ponte no ar em outra sessão; não há o que servir.");
          return;
        }
        console.log(`Ponte no ar. Manifesto: http://localhost:${config.port}/manifest.json  (Ctrl+C para sair)`);
        await new Promise<never>(() => {});
        return;
      case "status":
        await bridge.call("ping", undefined, { waitTableMs: ctx.waitTableMs }).catch(() => {});
        console.log(await statusMesa(ctx));
        return;
      case "tokens":
        console.log(await listarTokens(ctx, { camadas: rest[0] === "todas" ? "todas" : "tokens" }));
        return;
      case "mover":
        console.log(
          await moverToken(ctx, {
            token: required(rest[0], "token"),
            para: { coluna: integer(rest[1], "coluna"), linha: integer(rest[2], "linha") },
          }),
        );
        return;
      case "deslocar":
        console.log(
          await moverToken(ctx, {
            token: required(rest[0], "token"),
            deslocar: { colunas: integer(rest[1], "dcol"), linhas: integer(rest[2], "dlin") },
          }),
        );
        return;
      case "junto":
        console.log(await moverToken(ctx, { token: required(rest[0], "token"), junto_de: required(rest[1], "alvo") }));
        return;
      case "rotular":
        console.log(await editarToken(ctx, { token: required(rest[0], "token"), rotulo: rest.slice(1).join(" ") }));
        return;
      case "rolar":
        console.log(
          await rolar(ctx, { expressao: required(rest[0], "expressão"), rotulo: rest.slice(1).join(" ") || undefined }),
        );
        return;
      case "escutar": {
        // Fica esperando até alguém digitar no painel; então imprime e sai.
        // Rodado em segundo plano, a saída do processo acorda o Claude.
        const limitMinutes = rest[0] ? integer(rest[0], "minutos") : 120;
        const deadline = Date.now() + limitMinutes * 60_000;
        // Um escutador novo substitui o antigo: assim nunca ficam dois ligados.
        const listenerId = `escutar-${process.pid}-${Date.now()}`;
        while (Date.now() < deadline) {
          // Em pausa: deixa as falas guardadas na ponte e só confere de novo depois.
          const config = await bridge.call("getConfig", undefined, { waitTableMs: 0, timeoutMs: 4_000 }).catch(() => null);
          if (config?.pausado) {
            await new Promise((resolve) => setTimeout(resolve, 5_000));
            continue;
          }
          const messages = await bridge.messages(55_000, listenerId);
          if (messages === null) {
            console.log("Outro escutador assumiu. Este parou.");
            return;
          }
          if (messages.length > 0) {
            console.log(await aguardarJogadores({ ...ctx, table: { ...bridge, info: () => bridge.info(), call: bridge.call.bind(bridge), messages: async () => messages } }, { segundos: 0 }));
            return;
          }
        }
        console.log(`Ninguém escreveu na mesa em ${limitMinutes} min.`);
        return;
      }
      case "mapa": {
        // npm run mesa -- mapa <arquivo.jpg> [token-central raio]
        const out = required(rest[0], "arquivo de saída");
        const { text, view } = await verMapa(ctx, rest[1] ? { centro: rest[1], raio: rest[2] ? integer(rest[2], "raio") : undefined } : {});
        await writeFile(out, view.image);
        console.log(`${text}\nImagem salva em ${out} (${Math.round(view.pxPerCell)} px por casa).`);
        return;
      }
      case "combate": {
        // npm run mesa -- combate ver|proximo|encerrar|iniciar <arquivo.json>|adicionar <arquivo.json>
        const sub = rest[0] ?? "ver";
        if (sub === "proximo") console.log(await proximoTurno(ctx));
        else if (sub === "encerrar") console.log(await encerrarCombate(ctx));
        else if (sub === "iniciar" || sub === "adicionar") {
          const list = JSON.parse(await readFile(required(rest[1], "arquivo.json"), "utf8"));
          console.log(await iniciarCombate(ctx, { combatentes: list, adicionar: sub === "adicionar" }));
        } else console.log(await verCombate(ctx));
        return;
      }
      case "campanha": {
        // npm run mesa -- campanha listar|ver|ativar <nome>|criar <nome>|vincular [nome]|desvincular [nome]
        const acao = (rest[0] ?? "ver") as "listar" | "ver" | "ativar" | "criar" | "vincular" | "desvincular";
        console.log(await campanha(ctx, { acao, nome: rest.slice(1).join(" ") || undefined }));
        return;
      }
      case "catalogo": {
        // npm run mesa -- catalogo buscar <palavra> | catalogo criar <icone> <qtd> <col> <lin> [rótulo]
        if (rest[0] === "criar") {
          console.log(await catalogoTokens(ctx, { acao: "criar", icone: required(rest[1], "ícone"), quantidade: integer(rest[2], "qtd"), para: { coluna: integer(rest[3], "col"), linha: integer(rest[4], "lin") }, rotulo: rest.slice(5).join(" ") || undefined }));
        } else {
          console.log(await catalogoTokens(ctx, { acao: "buscar", icone: required(rest.slice(1).join(" "), "palavra") }));
        }
        return;
      }
      case "camera": {
        // npm run mesa -- camera <token> | camera col,lin,larg,alt
        const alvo = required(rest[0], "token ou área");
        const nums = alvo.split(",").map((n) => Number.parseInt(n, 10));
        console.log(
          await focarCamera(ctx, nums.length === 4 && nums.every(Number.isInteger)
            ? { area: { coluna: nums[0]!, linha: nums[1]!, largura: nums[2]!, altura: nums[3]! } }
            : { token: alvo }),
        );
        return;
      }
      case "nevoa": {
        // npm run mesa -- nevoa estado|cobrir|descobrir|limpar
        // npm run mesa -- nevoa revelar "<nome>" [col,lin,larg,alt ...]
        // npm run mesa -- nevoa esconder "<nome>"
        // npm run mesa -- nevoa bruto   (mostra os itens de névoa crus, para diagnóstico)
        const acao = required(rest[0], "ação");
        if (acao === "bruto") {
          console.log(JSON.stringify(await bridge.call("fogState"), null, 2));
          return;
        }
        const retangulos = rest.slice(2).map((spec) => {
          const [coluna, linha, largura, altura] = spec.split(",").map((n) => integer(n, "col,lin,larg,alt"));
          return { coluna: coluna!, linha: linha!, largura: largura!, altura: altura! };
        });
        console.log(await nevoa(ctx, { acao: acao as never, area: rest[1], retangulos: retangulos.length ? retangulos : undefined }));
        return;
      }
      case "pv":
        // npm run mesa -- pv <nome> <delta>
        console.log(await alterarCombatente(ctx, { nome: required(rest[0], "nome"), pv_delta: integer(rest[1], "delta") }));
        return;
      case "condicao":
        // npm run mesa -- condicao <nome> <+Condição|-Condição>
        console.log(await alterarCombatente(ctx, { nome: required(rest[0], "nome"), ...(required(rest[1], "condição").startsWith("-") ? { remover_condicao: rest[1]!.slice(1) } : { adicionar_condicao: rest[1]!.replace(/^[+]/, "") }) }));
        return;
      case "criar":
        console.log(
          await criarToken(ctx, {
            copiar_de: required(rest[0], "modelo"),
            quantidade: rest[1] ? integer(rest[1], "quantidade") : 1,
            rotulo: rest.slice(2).join(" ") || undefined,
          }),
        );
        return;
      case "remover":
        console.log(await removerToken(ctx, { token: required(rest[0], "token") }));
        return;
      case "salvar": {
        // npm run mesa -- salvar [nome=<cena>] [motivo...]
        const nome = rest.find((a) => a.startsWith("nome="))?.slice(5);
        const motivo = rest.filter((a) => !a.startsWith("nome=")).join(" ");
        console.log(await salvarCena(ctx, { nome, motivo: motivo || undefined }));
        return;
      }
      case "restaurar":
        // npm run mesa -- restaurar [nome=<cena>] [listar] [previa] [anterior] [sobras] [forcar]
        console.log(await restaurarCena(ctx, { nome: rest.find((a) => a.startsWith("nome="))?.slice(5), listar: rest.includes("listar"), previa: rest.includes("previa"), anterior: rest.includes("anterior"), remover_sobras: rest.includes("sobras"), forcar: rest.includes("forcar") }));
        return;
      case "aguardar":
        console.log(await aguardarJogadores(ctx, { segundos: rest[0] ? integer(rest[0], "segundos") : 50 }));
        return;
      case "anunciar":
        console.log(await anunciar(ctx, { mensagem: required(rest.join(" "), "mensagem") }));
        return;
      default:
        throw new Error(`Comando desconhecido: ${command}\n\n${USAGE}`);
    }
  } finally {
    await bridge.close();
  }
}

main().catch((err) => {
  console.error(errorMessage(err));
  process.exitCode = 1;
});
