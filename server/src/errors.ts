/** Erro com código estável, para o Claude e os testes saberem o que deu errado. */
export class MesaError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MesaError";
    this.code = code;
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function errorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "INTERNAL";
}
