import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface RollLogEntry {
  quando: string;
  rotulo: string | null;
  tipo: string;
  pedido: string;
  expressao: string;
  dados: string;
  total: number;
  d20: number | null;
  cd: number | null;
  resultado: string | null;
  secreta: boolean;
}

/**
 * Grava cada rolagem em <pasta da campanha>/rolagens.jsonl, uma por linha.
 * A pasta é decidida a cada rolagem, para valer a campanha ativa no momento.
 */
export function createRollLogger(campaignDir: string | (() => Promise<string>)): (entry: RollLogEntry) => Promise<void> {
  return async (entry) => {
    const dir = typeof campaignDir === "string" ? campaignDir : await campaignDir();
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, "rolagens.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  };
}
