#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Bridge } from "./bridge.js";
import { VERSION, loadConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { createRollLogger } from "./rolllog.js";
import { activeCampaignDir } from "./campaigns.js";
import { INSTRUCTIONS, registerTools } from "./tools.js";

// Atenção: a saída padrão é o canal do protocolo MCP. Todo log vai para stderr.
const log = (message: string) => console.error(`[mesa] ${message}`);

const config = loadConfig();
const bridge = new Bridge({
  port: config.port,
  staticDir: config.staticDir,
  version: VERSION,
  extraOrigins: config.extraOrigins,
  log,
});

const server = new McpServer({ name: "mesa", version: VERSION }, { instructions: INSTRUCTIONS });
const campaignDir = async () => config.campaignDir ?? activeCampaignDir(config.campaignsRoot);
registerTools(server, { table: bridge, logRoll: createRollLogger(campaignDir), campaignsRoot: config.campaignsRoot, campaignDir, iconsDir: config.iconsDir });

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await bridge.close().catch(() => {});
  process.exit(0);
}

// Quando o Claude Code fecha a sessão, ele fecha a entrada padrão: encerra junto,
// senão a ponte ficaria ocupando a porta para sempre.
process.stdin.on("end", () => void shutdown());
process.stdin.on("close", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
server.server.onclose = () => void shutdown();

// Sobe a ponte já na partida, para a extensão conectar antes do primeiro comando.
bridge.ensure().catch((err) => log(`ponte indisponível por enquanto: ${errorMessage(err)}`));

await server.connect(new StdioServerTransport());
