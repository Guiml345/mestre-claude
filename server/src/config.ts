import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_NAME = "mestre-claude";
export const VERSION = "0.1.0";
export const DEFAULT_PORT = 7420;
/** Onde a extensão fica publicada (GitHub Pages da conta do projeto). */
export const DEFAULT_ORIGINS = ["https://guiml345.github.io"];

/** Raiz do projeto: este arquivo roda de server/dist, então sobe dois níveis. */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface Config {
  port: number;
  /** Pasta com a extensão compilada, servida pela ponte. */
  staticDir: string;
  /** Força a pasta do registro de rolagens (usado nos testes); null = campanha ativa. */
  campaignDir: string | null;
  /** Pasta com uma subpasta por campanha (campanhas/<nome>/). */
  campaignsRoot: string;
  /** Origens extras (além de localhost) que podem se conectar como mesa. */
  extraOrigins: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number.parseInt(env.MESA_RPG_PORT ?? "", 10);
  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    staticDir: path.join(PROJECT_ROOT, "extension", "dist"),
    campaignDir: env.MESA_RPG_CAMPANHA
      ? path.resolve(env.MESA_RPG_CAMPANHA)
      : null,
    campaignsRoot: path.join(PROJECT_ROOT, "campanhas"),
    // A extensão publicada no GitHub Pages também pode se conectar como mesa.
    extraOrigins: [...DEFAULT_ORIGINS, ...(env.MESA_RPG_ORIGENS ?? "").split(",")]
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}
