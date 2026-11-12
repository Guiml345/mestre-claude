import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cryptoRng, formatExpression, parseDice, roll, type Rng } from "./dice.js";
import { MesaError } from "./errors.js";

/** Dado viciado: devolve os valores na ordem dada. */
function fixed(...values: number[]): Rng {
  let index = 0;
  return () => {
    if (index >= values.length) throw new Error("acabaram os valores do dado de teste");
    return values[index++]!;
  };
}

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof MesaError && err.code === code);
}

describe("parseDice", () => {
  it("lê dados, modificadores e sinais", () => {
    assert.deepEqual(parseDice("1d20+5"), [
      { kind: "dice", sign: 1, count: 1, sides: 20 },
      { kind: "const", sign: 1, value: 5 },
    ]);
    assert.equal(formatExpression(parseDice("1d8+1d6-1")), "1d8+1d6-1");
    assert.equal(formatExpression(parseDice("-1d4+10")), "-1d4+10");
  });

  it("aceita formas abreviadas, maiúsculas, espaços e sinal de menos tipográfico", () => {
    assert.equal(formatExpression(parseDice("d20")), "1d20");
    assert.equal(formatExpression(parseDice("D%")), "1d100");
    assert.equal(formatExpression(parseDice("  2D6 + 3 ")), "2d6+3");
    assert.equal(formatExpression(parseDice("1d20 − 2")), "1d20-2");
  });

  it("lê manter e descartar dados", () => {
    assert.equal(formatExpression(parseDice("4d6kh3")), "4d6kh3");
    assert.equal(formatExpression(parseDice("4d6k3")), "4d6kh3");
    assert.equal(formatExpression(parseDice("2d20kl1+4")), "2d20kl1+4");
    assert.equal(formatExpression(parseDice("4d6dl1")), "4d6dl1");
  });

  it("recusa expressões erradas em vez de adivinhar", () => {
    for (const bad of ["", "   ", "abc", "1d20 5", "1 d20", "1d20++5", "1d20+", "2x6", "1d20d4", "d", "1d20k", "+"]) {
      throwsCode(() => parseDice(bad), "BAD_DICE");
    }
  });

  it("impõe limites", () => {
    throwsCode(() => parseDice("0d6"), "BAD_DICE");
    throwsCode(() => parseDice("101d6"), "BAD_DICE");
    throwsCode(() => parseDice("1d1"), "BAD_DICE");
    throwsCode(() => parseDice("1d1001"), "BAD_DICE");
    throwsCode(() => parseDice("1d6+100001"), "BAD_DICE");
    throwsCode(() => parseDice("2d6kh3"), "BAD_DICE");
    throwsCode(() => parseDice("2d6dl2"), "BAD_DICE");
    throwsCode(() => parseDice(Array.from({ length: 21 }, () => "1d4").join("+")), "BAD_DICE");
    assert.equal(parseDice(Array.from({ length: 20 }, () => "1d4").join("+")).length, 20);
  });
});

describe("roll", () => {
  it("soma dados e modificador", () => {
    const result = roll("1d20+5", { rng: fixed(13) });
    assert.equal(result.total, 18);
    assert.equal(result.d20, 13);
    assert.equal(result.breakdown, "[13] + 5");
    assert.equal(result.expression, "1d20+5");
  });

  it("subtrai termos negativos", () => {
    const result = roll("2d6-1d4-1", { rng: fixed(6, 5, 3) });
    assert.equal(result.total, 6 + 5 - 3 - 1);
    assert.equal(result.breakdown, "[6, 5] - [3] - 1");
    assert.equal(result.d20, null);
  });

  it("vantagem fica com o maior d20", () => {
    const result = roll("1d20+5", { mode: "vantagem", rng: fixed(4, 17) });
    assert.equal(result.expression, "2d20kh1+5");
    assert.equal(result.total, 22);
    assert.equal(result.d20, 17);
    assert.equal(result.breakdown, "[(4), 17] + 5");
  });

  it("desvantagem fica com o menor d20", () => {
    const result = roll("1d20+5", { mode: "desvantagem", rng: fixed(4, 17) });
    assert.equal(result.expression, "2d20kl1+5");
    assert.equal(result.total, 9);
    assert.equal(result.d20, 4);
    assert.equal(result.breakdown, "[4, (17)] + 5");
  });

  it("vantagem exige um único d20", () => {
    throwsCode(() => roll("2d6+3", { mode: "vantagem", rng: fixed(1, 1) }), "BAD_DICE");
    throwsCode(() => roll("2d20", { mode: "desvantagem", rng: fixed(1, 1) }), "BAD_DICE");
  });

  it("crítico rola cada dado duas vezes e não dobra o modificador", () => {
    const result = roll("1d8+3", { critical: true, rng: fixed(5, 7) });
    assert.equal(result.expression, "2d8+3");
    assert.equal(result.total, 15);
    const sneak = roll("1d8+2d6+3", { critical: true, rng: fixed(1, 2, 3, 4, 5, 6) });
    assert.equal(sneak.expression, "2d8+4d6+3");
    assert.equal(sneak.total, 1 + 2 + 3 + 4 + 5 + 6 + 3);
  });

  it("mantém os maiores e descarta os menores", () => {
    const keep = roll("4d6kh3", { rng: fixed(1, 6, 3, 6) });
    assert.equal(keep.total, 15);
    assert.equal(keep.breakdown, "[(1), 6, 3, 6]");
    const drop = roll("4d6dl1", { rng: fixed(1, 6, 3, 6) });
    assert.equal(drop.total, 15);
    const low = roll("3d6kl1", { rng: fixed(4, 2, 5) });
    assert.equal(low.total, 2);
    const dropHigh = roll("3d6dh1", { rng: fixed(4, 2, 5) });
    assert.equal(dropHigh.total, 6);
  });

  it("só informa o d20 natural quando há exatamente um valendo", () => {
    assert.equal(roll("2d20", { rng: fixed(20, 1) }).d20, null);
    assert.equal(roll("1d20+1d20", { rng: fixed(20, 1) }).d20, null);
    assert.equal(roll("2d20kh1", { rng: fixed(20, 1) }).d20, 20);
    assert.equal(roll("2d6+3", { rng: fixed(1, 2) }).d20, null);
  });

  it("o dado de verdade fica dentro da faixa e usa todas as faces", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 3000; i++) {
      const value = cryptoRng(6);
      assert.ok(Number.isInteger(value) && value >= 1 && value <= 6);
      seen.add(value);
    }
    assert.equal(seen.size, 6);
    const result = roll("3d6+2");
    assert.ok(result.total >= 5 && result.total <= 20);
  });

  it("recusa um gerador que devolve valor impossível", () => {
    throwsCode(() => roll("1d6", { rng: () => 7 }), "INTERNAL");
    throwsCode(() => roll("1d6", { rng: () => 0 }), "INTERNAL");
  });
});
