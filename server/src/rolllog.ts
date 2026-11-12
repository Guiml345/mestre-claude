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

/** Grava cada rolagem em campanha/rolagens.jsonl, uma por linha, para conferência depois. */
export function createRollLogger(campaignDir: string): (entry: RollLogEntry) => Promise<void> {
  const file = path.join(campaignDir, "rolagens.jsonl");
  return async (entry) => {
    await mkdir(campaignDir, { recursive: true });
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  };
}
