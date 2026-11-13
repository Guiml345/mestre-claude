import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MesaError } from "./errors.js";
import {
  adjacentCell,
  cellDistance,
  describeGrid,
  footprint,
  formatDistance,
  isAdjacent,
  normalize,
  positionForCell,
  requireSquare,
  resolveToken,
} from "./grid.js";
import type { GridInfo, RawItem } from "./protocol.js";
import { SQUARE_GRID, mapItem, token } from "./testing.js";

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof MesaError && err.code === code);
}

const cell = (item: RawItem, grid: GridInfo = SQUARE_GRID) => {
  const fp = footprint(item, grid);
  return [fp.col, fp.row, fp.w, fp.h];
};

describe("footprint", () => {
  it("token de uma casa com âncora no centro", () => {
    assert.deepEqual(cell(token("a", "Goblin", 3, 2)), [3, 2, 1, 1]);
    assert.deepEqual(cell(token("a", "Goblin", 0, 0)), [0, 0, 1, 1]);
    assert.deepEqual(cell(token("a", "Goblin", -2, -1)), [-2, -1, 1, 1]);
  });

  it("mapa com âncora no canto", () => {
    assert.deepEqual(cell(mapItem("m", "Vila", 20, 14)), [0, 0, 20, 14]);
  });

  it("criatura grande (2×2) fica com o canto superior esquerdo na casa certa", () => {
    const ogre = token("o", "Ogro", 0, 0, {
      image: { width: 600, height: 600, url: "" },
      grid: { dpi: 300, offset: { x: 300, y: 300 } },
      position: { x: 5 * 150, y: 3 * 150 },
    });
    assert.deepEqual(cell(ogre), [4, 2, 2, 2]);
  });

  it("escala aumenta o tamanho; espelhar não muda a casa", () => {
    const big = token("a", "Urso", 0, 0, { scale: { x: 2, y: 2 }, position: { x: 300, y: 300 } });
    assert.deepEqual(cell(big), [1, 1, 2, 2]);
    assert.deepEqual(cell(token("a", "Goblin", 3, 2, { scale: { x: -1, y: 1 } })), [3, 2, 1, 1]);
  });

  it("token minúsculo ainda ocupa uma casa", () => {
    assert.deepEqual(cell(token("a", "Rato", 4, 4, { scale: { x: 0.5, y: 0.5 } })), [4, 4, 1, 1]);
  });

  it("token fora do encaixe cai na casa mais próxima", () => {
    const loose = token("a", "Goblin", 3, 2);
    loose.position = { x: loose.position.x + 40, y: loose.position.y - 60 };
    assert.deepEqual(cell(loose), [3, 2, 1, 1]);
  });

  it("item que não é imagem usa a posição como centro", () => {
    const shape: RawItem = { ...token("s", "Marca", 2, 2), image: undefined, grid: undefined };
    assert.deepEqual(cell(shape), [2, 2, 1, 1]);
  });
});

describe("positionForCell", () => {
  it("leva qualquer token para a casa pedida", () => {
    const samples: RawItem[] = [
      token("a", "Goblin", 3, 2),
      token("b", "Urso", 0, 0, { scale: { x: 2, y: 2 }, position: { x: 300, y: 300 } }),
      token("c", "Canto", 0, 0, { grid: { dpi: 300, offset: { x: 0, y: 0 } }, position: { x: 450, y: 150 } }),
      token("d", "Espelhado", 7, 7, { scale: { x: -1, y: 1 } }),
      token("e", "Solto", 1, 1, { position: { x: 233, y: 187 } }),
    ];
    for (const item of samples) {
      for (const [col, row] of [[0, 0], [12, 7], [-3, 5]] as const) {
        const moved = { ...item, position: positionForCell(item, SQUARE_GRID, col, row) };
        const fp = footprint(moved, SQUARE_GRID);
        assert.deepEqual([fp.col, fp.row], [col, row], `${item.text} para (${col}, ${row})`);
        // E encaixado exatamente na grade, não só arredondado para ela.
        assert.equal(fp.centerX, col * 150 + (fp.w * 150) / 2);
        assert.equal(fp.centerY, row * 150 + (fp.h * 150) / 2);
      }
    }
  });
});

describe("resolveToken", () => {
  const items: RawItem[] = [
    mapItem("map-0001", "Goblin", 20, 14),
    token("aaaaaaaa-1111", "Dragão", 1, 1, { name: "Skull" }),
    token("bbbbbbbb-2222", "Goblin 1", 2, 2, { name: "Goblin" }),
    token("cccccccc-3333", "Goblin 2", 3, 3, { name: "Goblin" }),
    token("dddddddd-4444", "", 4, 4, { name: "Shield" }),
  ];

  it("acha pelo rótulo sem ligar para acento e caixa", () => {
    assert.equal(resolveToken(items, "dragao").id, "aaaaaaaa-1111");
    assert.equal(resolveToken(items, "  DRAGÃO ").id, "aaaaaaaa-1111");
    assert.equal(resolveToken(items, "goblin 2").id, "cccccccc-3333");
  });

  it("acha pelo nome da imagem, pelo id e pelo começo do id", () => {
    assert.equal(resolveToken(items, "shield").id, "dddddddd-4444");
    assert.equal(resolveToken(items, "skull").id, "aaaaaaaa-1111");
    assert.equal(resolveToken(items, "cccccccc-3333").id, "cccccccc-3333");
    assert.equal(resolveToken(items, "bbbbbbbb").id, "bbbbbbbb-2222");
    assert.equal(resolveToken(items, "map-0001").id, "map-0001");
  });

  it("acha por pedaço do nome quando só um bate", () => {
    assert.equal(resolveToken(items, "drag").id, "aaaaaaaa-1111");
  });

  it("avisa quando há mais de um candidato, listando casas e ids", () => {
    assert.throws(
      () => resolveToken(items, "goblin", SQUARE_GRID),
      (err: unknown) =>
        err instanceof MesaError &&
        err.code === "TOKEN_AMBIGUOUS" &&
        err.message.includes("bbbbbbbb") &&
        err.message.includes("cccccccc") &&
        err.message.includes("(2, 2)") &&
        !err.message.includes("map-0001"),
    );
  });

  it("avisa quando não acha, listando o que existe", () => {
    assert.throws(
      () => resolveToken(items, "orc"),
      (err: unknown) => err instanceof MesaError && err.code === "TOKEN_NOT_FOUND" && err.message.includes("Dragão"),
    );
    throwsCode(() => resolveToken(items, "   "), "TOKEN_NOT_FOUND");
    throwsCode(() => resolveToken([], "orc"), "TOKEN_NOT_FOUND");
  });

  it("normalize tira acentos e espaços sobrando", () => {
    assert.equal(normalize("  Dragão   Ancião "), "dragao anciao");
  });
});

describe("adjacentCell", () => {
  it("escolhe a casa vizinha mais próxima de quem se move", () => {
    const mover = token("m", "Goblin", 0, 0);
    const target = token("t", "Guilherme", 5, 0);
    assert.deepEqual(adjacentCell(mover, target, [mover, target], SQUARE_GRID), { col: 4, row: 0, already: false });
  });

  it("desvia de casas ocupadas", () => {
    const mover = token("m", "Goblin", 0, 0);
    const target = token("t", "Guilherme", 5, 0);
    const blocker = token("b", "Leo", 4, 0);
    const result = adjacentCell(mover, target, [mover, target, blocker], SQUARE_GRID);
    assert.equal(result.already, false);
    assert.equal(result.col, 4);
    assert.ok(result.row === -1 || result.row === 1);
  });

  it("não move quem já está ao lado, inclusive na diagonal", () => {
    const mover = token("m", "Goblin", 4, 1);
    const target = token("t", "Guilherme", 5, 0);
    assert.deepEqual(adjacentCell(mover, target, [mover, target], SQUARE_GRID), { col: 4, row: 1, already: true });
  });

  it("tira de cima quem está na mesma casa do alvo", () => {
    const mover = token("m", "Goblin", 5, 0);
    const target = token("t", "Guilherme", 5, 0);
    const result = adjacentCell(mover, target, [mover, target], SQUARE_GRID);
    assert.equal(result.already, false);
    assert.ok(isAdjacent(footprint({ ...mover, position: positionForCell(mover, SQUARE_GRID, result.col, result.row) }, SQUARE_GRID), footprint(target, SQUARE_GRID)));
  });

  it("respeita o tamanho de criaturas grandes", () => {
    const ogre = token("o", "Ogro", 0, 0, { scale: { x: 2, y: 2 }, position: { x: 150, y: 150 } });
    const target = token("t", "Guilherme", 6, 0);
    const result = adjacentCell(ogre, target, [ogre, target], SQUARE_GRID);
    assert.deepEqual(result, { col: 4, row: 0, already: false });
  });

  it("dá erro quando o alvo está cercado", () => {
    const mover = token("m", "Goblin", 0, 0);
    const target = token("t", "Guilherme", 5, 5);
    const ring: RawItem[] = [];
    for (let c = 4; c <= 6; c++) for (let r = 4; r <= 6; r++) if (c !== 5 || r !== 5) ring.push(token(`r${c}${r}`, "Muro", c, r));
    throwsCode(() => adjacentCell(mover, target, [mover, target, ...ring], SQUARE_GRID), "NO_SPACE");
  });

  it("anexos e objetos não bloqueiam casas", () => {
    const mover = token("m", "Goblin", 0, 0);
    const target = token("t", "Guilherme", 5, 0);
    const prop = token("p", "Barril", 4, 0, { layer: "PROP" });
    const ring = token("a", "Anel", 4, 0, { layer: "ATTACHMENT", attachedTo: "t" });
    assert.deepEqual(adjacentCell(mover, target, [mover, target, prop, ring], SQUARE_GRID), { col: 4, row: 0, already: false });
  });
});

describe("distâncias", () => {
  it("segue a regra de medição da sala", () => {
    assert.equal(cellDistance(3, -4, "CHEBYSHEV"), 4);
    assert.equal(cellDistance(3, -4, "MANHATTAN"), 7);
    assert.equal(cellDistance(3, -4, "EUCLIDEAN"), 5);
    assert.equal(cellDistance(3, 3, "ALTERNATING"), 4);
    assert.equal(cellDistance(4, 4, "ALTERNATING"), 6);
    assert.equal(cellDistance(5, 2, "ALTERNATING"), 6);
    assert.equal(cellDistance(0, 0, "CHEBYSHEV"), 0);
    assert.equal(cellDistance(2, 1, "QUALQUER"), 2);
  });

  it("escreve a distância em casas e na unidade da grade", () => {
    assert.equal(formatDistance(3, SQUARE_GRID), "3 casas (15ft)");
    assert.equal(formatDistance(1, SQUARE_GRID), "1 casa (5ft)");
    const metric: GridInfo = { ...SQUARE_GRID, scale: { raw: "1.5m", multiplier: 1.5, unit: "m", digits: 1 } };
    assert.equal(formatDistance(3, metric), "3 casas (4,5m)");
    const noScale: GridInfo = { ...SQUARE_GRID, scale: { raw: "", multiplier: Number.NaN, unit: "", digits: 0 } };
    assert.equal(formatDistance(2, noScale), "2 casas");
  });

  it("descreve a grade e recusa grade não quadrada para mover", () => {
    assert.equal(describeGrid(SQUARE_GRID), "grade quadrada, 1 casa = 5ft (150 px), diagonal conta 1 casa");
    requireSquare(SQUARE_GRID);
    throwsCode(() => requireSquare({ ...SQUARE_GRID, type: "HEX_VERTICAL" }), "GRID_UNSUPPORTED");
  });
});

describe("mapa girado", () => {
  it("considera a rotação ao calcular a área do mapa e dos tokens", async () => {
    const { footprint } = await import("./grid.js");
    const { SQUARE_GRID } = await import("./testing.js");
    // Mapa de 4×6 casas (imagem 400×600, 100 px por casa), âncora no canto, girado 270°.
    const map = {
      id: "m", type: "IMAGE", name: "Prisão", layer: "MAP", position: { x: 0, y: 0 }, rotation: 270, scale: { x: 1, y: 1 },
      visible: true, locked: true, image: { width: 400, height: 600, url: "" }, grid: { dpi: 100, offset: { x: 0, y: 0 } },
    };
    const fp = footprint(map, SQUARE_GRID);
    assert.deepEqual([fp.col, fp.row, fp.w, fp.h], [0, -4, 6, 4]);
    // 90°: vai para a esquerda da âncora.
    assert.deepEqual(((f) => [f.col, f.row, f.w, f.h])(footprint({ ...map, rotation: 90 }, SQUARE_GRID)), [-6, 0, 6, 4]);
    // Token redondo girado continua na mesma casa.
    const tok = { ...map, layer: "CHARACTER", rotation: 45, image: { width: 100, height: 100, url: "" }, grid: { dpi: 100, offset: { x: 50, y: 50 } }, position: { x: 225, y: 375 } };
    const t = footprint(tok, SQUARE_GRID);
    assert.deepEqual([t.col, t.row], [1, 2]);
  });
});
