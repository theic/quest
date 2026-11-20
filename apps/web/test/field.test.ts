import { describe, expect, it } from "vitest";
import {
  Brush,
  FLOW_MAX,
  MAX_SEGMENTS,
  NECK,
  PINCH,
  PIXEL_BUDGET,
  Slosh,
  TANK_TEXEL,
  canvasSize,
  canvasTop,
  decodeDistance,
  encodeDistance,
  encodeFlow,
  geodesic,
  glyphDistance,
  heroBody,
  landings,
  layoutFor,
  nearestInside,
  necks,
  pageToField,
  port,
  riverAt,
  riverSegments,
  segmentsIn,
  shapesIn,
  tankFlow,
  tankGrid,
  toField,
  wetRows,
  waveSteps,
} from "../public/field-model.js";

const FRAME = 1 / 60;

/** The largest change in per-frame movement: how hard a path lurches from one frame to the next. */
const lurch = (xs: readonly number[]) => {
  let worst = 0;
  for (let i = 2; i < xs.length; i++) worst = Math.max(worst, Math.abs((xs[i] ?? 0) - 2 * (xs[i - 1] ?? 0) + (xs[i - 2] ?? 0)));
  return worst;
};

describe("where the ink sits", () => {
  it("measures in the hero's height from its centre, y up", () => {
    expect(toField(720, 450, 1440, 900)).toEqual([0, 0]);
    expect(toField(1440, 0, 1440, 900)).toEqual([0.8, 0.5]);
  });

  it("puts the ink to the right of the copy on a wide screen, where the prototype had it", () => {
    const { centre, below, edge } = layoutFor("side", 1440, 900, { right: 720, bottom: 640 });

    expect(below).toBe(0);
    expect(edge).toBe(0.5);
    expect(centre[0]).toBeCloseTo(0.4, 5); // (720 + 1440) / 2 = 1080 px, 360 px right of centre
    expect(centre[1]).toBe(0);
  });

  it("keeps the ink on screen however far the copy reaches", () => {
    const [x] = layoutFor("side", 900, 880, { right: 880, bottom: 600 }).centre;

    expect(x).toBeCloseTo((0.82 * 900 - 450) / 880, 5);
  });

  it("puts the ink under the copy when the page stacks", () => {
    const { centre, below, edge } = layoutFor("below", 390, 930, { right: 360, bottom: 600 });

    expect(below).toBe(1);
    expect(edge).toBeCloseTo(600 / 930, 5);
    expect(centre[0]).toBe(0);
    expect(centre[1]).toBeLessThan(-0.1);
  });
});

describe("how many pixels it costs", () => {
  it("draws a phone at 1.5x, however sharp its screen", () => {
    expect(canvasSize(390, 930, 3)).toEqual([585, 1395]);
  });

  it("never draws more than the budget, on any screen", () => {
    for (const [w, h, dpr] of [[1440, 900, 1], [1440, 900, 2], [2560, 1120, 1.5], [3840, 1120, 2]] as const) {
      const [cw, ch] = canvasSize(w, h, dpr);
      expect(cw * ch).toBeLessThanOrEqual(PIXEL_BUDGET * 1.01);
      expect(cw / ch).toBeCloseTo(w / h, 2);
    }
  });

  it("draws fewer pixels at a lower quality", () => {
    const [full] = canvasSize(390, 930, 3, 1);
    const [half] = canvasSize(390, 930, 3, 0.5);

    expect(half).toBe(Math.round(full / 2));
  });
});

describe("the brush the pointer moves", () => {
  it("eases after the pointer instead of jumping to it, and arrives", () => {
    const brush = new Brush();
    brush.point(0, 0);
    brush.step(1);
    brush.point(0.2, 0);
    brush.step(1 + FRAME);

    const [x1] = brush.position ?? [];
    expect(x1).toBeGreaterThan(0);
    expect(x1).toBeLessThan(0.1);
    for (let t = 1 + 2 * FRAME; t < 1.5; t += FRAME) brush.step(t);
    expect(brush.position?.[0]).toBeCloseTo(0.2, 3);
  });

  it("moves smoothly however unevenly the pointer's events arrive", () => {
    // A pointer at a steady 0.6 per second whose events come in bursts: two quick ones, then a gap.
    const brush = new Brush();
    const xs: number[] = [];
    const raw: number[] = [];
    let last = 0;
    for (let frame = 0; frame < 90; frame++) {
      const t = 1 + frame * FRAME;
      if (frame % 6 < 2) {
        last = 0.6 * (t - 1);
        brush.point(last, 0);
      }
      brush.step(t);
      xs.push(brush.position?.[0] ?? 0);
      raw.push(last);
    }

    // Drawn straight at the pointer, the path would lurch at every burst; the brush's barely does.
    expect(lurch(xs.slice(10))).toBeLessThan(0.15 * lurch(raw.slice(10)));
  });

  it("paints every bit of its path, one segment a frame, end to end", () => {
    const brush = new Brush();
    let end: number[] | null = null;
    for (let frame = 0; frame < 40; frame++) {
      brush.point(0.3 * Math.cos(frame / 8), 0.3 * Math.sin(frame / 8));
      brush.step(1 + frame * FRAME);
      const segment = brush.paint()?.segment ?? [];
      if (end) {
        expect(segment[0]).toBeCloseTo(end[0] ?? NaN, 9);
        expect(segment[1]).toBeCloseTo(end[1] ?? NaN, 9);
      }
      end = segment.slice(2);
      expect(end).toEqual(brush.position);
    }
  });

  it("drags the liquid the way it moves, and nothing at rest", () => {
    const brush = new Brush();
    for (let frame = 0; frame < 20; frame++) {
      brush.point(frame * 0.01, 0);
      brush.step(1 + frame * FRAME);
    }
    const moving = brush.paint();
    expect(moving?.velocity[0]).toBeCloseTo(brush.speed, 9);
    expect(moving?.velocity[1]).toBeCloseTo(0, 9);
    expect(moving?.weight).toBeGreaterThan(0.5);

    for (let t = 2.2; t < 3; t += FRAME) brush.step(t);
    expect(brush.paint()?.weight).toBe(0);
  });

  it("comes back, or follows a jump, without painting a streak across the ink", () => {
    const brush = new Brush();
    for (let frame = 0; frame < 20; frame++) {
      brush.point(frame * 0.01, 0);
      brush.step(1 + frame * FRAME);
      brush.paint();
    }
    brush.leave();
    brush.point(-0.5, 0.3);
    brush.step(1 + 21 * FRAME);
    expect(brush.position).toEqual([-0.5, 0.3]);
    expect(brush.paint()?.segment).toEqual([-0.5, 0.3, -0.5, 0.3]);

    brush.point(0.4, -0.3);
    brush.step(1 + 22 * FRAME);
    expect(brush.paint()?.segment).toEqual([0.4, -0.3, 0.4, -0.3]);
  });

  it("drops a press into the liquid once", () => {
    const brush = new Brush();
    expect(brush.takePress()).toBeNull();
    brush.press(0.3, -0.1);

    expect(brush.takePress()).toEqual([0.3, -0.1]);
    expect(brush.takePress()).toBeNull();
  });
});

describe("the page below the hero", () => {
  const frame = { width: 1440, unit: 900, top: 0 };

  it("is measured from the hero's centre in hero heights, so the hero's ink is where it always was", () => {
    expect(pageToField(720, 450, frame)).toEqual([0, 0]);
    expect(pageToField(1440, 0, frame)).toEqual(toField(1440, 0, 1440, 900));
    expect(pageToField(720, 1350, frame)).toEqual([0, -1]);
  });

  it("is drawn on a canvas that scrolls with it, the screen in its middle, never past the page's ends", () => {
    // A 900 px screen, a 1260 px canvas, a 5000 px page.
    expect(canvasTop(2000, 1260, 900, 5000)).toBe(1820);
    expect(canvasTop(50, 1260, 900, 5000)).toBe(0);
    expect(canvasTop(4100, 1260, 900, 5000)).toBe(3740);
    expect(canvasTop(0, 1260, 900, 1000)).toBe(0);

    for (let scroll = 0; scroll <= 5000 - 900; scroll += 37) {
      const top = canvasTop(scroll, 1260, 900, 5000);
      expect(top).toBeLessThanOrEqual(scroll);
      expect(top + 1260).toBeGreaterThanOrEqual(scroll + 900);
    }
  });
});

describe("the river down the page", () => {
  // Out of the hero's ink, through its foot, across to the middle and down past a stop.
  const anchors = [
    { x: 0.4, y: 0, half: 0.16 },
    { x: 0.4, y: -0.5, half: 0.035 },
    { x: 0, y: -1.2, half: 0.05 },
    { x: 0, y: -1.6, half: 0.05 },
  ];
  const river = riverSegments(anchors);

  it("runs through every anchor, at the width the page gave it there", () => {
    expect(river).toHaveLength(3);
    for (const a of anchors) {
      const at = riverAt(river, a.y);
      expect(at?.x).toBeCloseTo(a.x, 9);
      expect(at?.half).toBeCloseTo(a.half, 9);
    }
  });

  it("bends in an S between two anchors and never kinks: level at each, steepest halfway", () => {
    expect(riverAt(river, -0.5)?.slope).toBeCloseTo(0, 9);
    expect(riverAt(river, -1.2)?.slope).toBeCloseTo(0, 9);
    expect(riverAt(river, -0.85)?.slope).toBeCloseTo((1.5 * -0.4) / 0.7, 9);
    expect(riverAt(river, -0.85)?.x).toBeCloseTo(0.2, 9);

    let last = Infinity;
    for (let y = -0.5; y >= -1.2; y -= 0.01) {
      const x = riverAt(river, y)?.x ?? NaN;
      expect(x).toBeLessThanOrEqual(last + 1e-12);
      last = x;
    }
  });

  it("runs narrower between anchors than at them, so it beads at each one", () => {
    expect(riverAt(river, -1.4)?.half).toBeCloseTo(0.05 * (1 - PINCH), 9);
  });

  it("starts at its first anchor and ends at its last", () => {
    expect(riverAt(river, 0.1)).toBeNull();
    expect(riverAt(river, -1.7)).toBeNull();
  });

  it("is drawn on a screen with the pieces that reach it, glow and all, and no more than the shader holds", () => {
    expect(segmentsIn(river, -0.7, -1.1, 0)).toEqual([river[1]]);
    expect(segmentsIn(river, -0.7, -1.3, 0)).toEqual([river[1], river[2]]);
    expect(segmentsIn(river, -1.7, -2, 0)).toEqual([]);
    expect(segmentsIn(river, -1.7, -2, 0.1)).toEqual([river[2]]);
    expect(segmentsIn(river, 3, 2, 0)).toEqual([]);

    const long = riverSegments(Array.from({ length: 20 }, (_, i) => ({ x: 0, y: -i * 0.1, half: 0.05 })));
    expect(segmentsIn(long, 0, -1.9, 0)).toHaveLength(MAX_SEGMENTS);
  });

  it("draws a shape once what melts and glows round it reaches the screen, and not before", () => {
    const ring = { x: 0, y: -2, hx: 0.15, hy: 0.15, soft: 0.02 };

    expect(shapesIn([ring], -1, -1.84)).toEqual([ring]);
    expect(shapesIn([ring], -1, -1.8)).toEqual([]);
    expect(shapesIn([ring], -2.1, -3)).toEqual([ring]);
    expect(shapesIn([ring], -2.2, -3)).toEqual([]);
  });
});

describe("the shapes the river runs into", () => {
  const ring = { x: 0, y: -2, radius: 0.15, band: 0.02 };

  it("leaves a shape to carry the ink from the way in to the way out", () => {
    const anchors = [
      { x: 0, y: -1.5, half: 0.05 },
      { ...port(ring, 0, -1.5), half: 0.02, into: ring },
      { ...port(ring, -0.4, -2.6), half: 0.02, outOf: ring },
      { x: -0.4, y: -2.6, half: 0.05 },
    ];
    const river = riverSegments(anchors);

    expect(river.map((s) => [s.a, s.b])).toEqual([
      [anchors[0], anchors[1]],
      [anchors[2], anchors[3]],
    ]);
    expect(riverAt(river, -2)).toBeNull();
  });

  it("meets a ring on its band, facing the way the river comes from or goes on to", () => {
    expect(port(ring, 0, -1.5).x).toBeCloseTo(0, 9);
    expect(port(ring, 0, -1.5).y).toBeCloseTo(-1.85, 9);
    const out = port(ring, -0.4, -2.4);
    expect(Math.hypot(out.x - ring.x, out.y - ring.y)).toBeCloseTo(ring.radius, 9);
    expect(out.x).toBeLessThan(0);
    expect(out.y).toBeLessThan(ring.y);
  });

  it("joins rings side by side or one above another with necks, band to band, but not across or past one", () => {
    const row = [0, 0.4, 0.8].map((x) => ({ x, y: 0, radius: 0.15, band: 0.02 }));
    const joined = necks(row, 0.2);

    expect(joined).toHaveLength(2);
    expect(joined.every((n) => n.kind === NECK)).toBe(true);
    expect(joined[0]?.a.x).toBeCloseTo(0.15, 9);
    expect(joined[0]?.b.x).toBeCloseTo(0.25, 9);
    expect(joined[0]?.a.half).toBe(0.02);

    const diagonal = [
      { x: 0, y: 0, radius: 0.15, band: 0.02 },
      { x: 0.4, y: -0.4, radius: 0.15, band: 0.02 },
    ];
    expect(necks(diagonal, 1)).toEqual([]);
    expect(necks(row, 0.05)).toEqual([]);
    expect(necks(row, 1)).toHaveLength(2);
  });

  it("reaches out to a ring the river runs past, and not to one too far off", () => {
    const river = riverSegments([
      { x: 0, y: 0, half: 0.02 },
      { x: 0, y: -1, half: 0.02 },
    ]);
    const near = { x: 0.22, y: -0.5, radius: 0.15, band: 0.02 };
    const far = { x: 0.8, y: -0.5, radius: 0.15, band: 0.02 };
    const [landing, ...rest] = landings(river, [near, far], 0.05);

    expect(rest).toEqual([]);
    expect(landing?.kind).toBe(NECK);
    expect(landing?.a.x).toBeCloseTo(0, 9);
    expect(landing?.a.y).toBeCloseTo(-0.5, 9);
    expect(landing?.b.x).toBeCloseTo(0.07, 9);
  });
});

describe("the letters the ink fills", () => {
  // A 10 px square in a 30 px field.
  const width = 30;
  const alpha = new Uint8Array(width * width);
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) alpha[y * width + x] = 255;
  const sd = glyphDistance(alpha, width, width);
  const at = (x: number, y: number) => sd[y * width + x] ?? NaN;

  it("knows how far each pixel is from their edge: negative inside, positive out, crossing at the edge", () => {
    expect(at(15, 15)).toBeCloseTo(-4.5, 0);
    expect(at(5, 15)).toBeCloseTo(5, 0);
    expect(at(10, 15)).toBeLessThan(0);
    expect(at(9, 15)).toBeGreaterThan(0);
    expect(at(10, 15) + at(9, 15)).toBeCloseTo(0, 6);
  });

  it("keeps the distance in 8 bits, finest at the edge, and gives it back", () => {
    const range = 16;
    const bytes = encodeDistance(Float32Array.from([-20, -2, -0.3, 0, 0.3, 2, 20]), 7, 1, range);
    expect([...bytes]).toEqual([...bytes].toSorted((a, b) => b - a));
    expect(bytes[3]).toBe(128);
    for (const [i, d] of [[1, -2], [2, -0.3], [4, 0.3], [5, 2]] as const) expect(decodeDistance((bytes[i] ?? 0) / 255, range)).toBeCloseTo(d, 1);
    expect(decodeDistance((bytes[0] ?? 0) / 255, range)).toBeCloseTo(-range, 6);
  });

  it("finds where the river can enter them: the nearest point well inside", () => {
    expect(nearestInside(sd, width, width, 15, 0, 1.9)).toEqual({ x: 15, y: 11 });
    expect(nearestInside(sd, width, width, 15, 0, 50)).toBeNull();
  });
});

describe("the slosh when the page scrolls", () => {
  /** Scrolls at `speed` (field units a second) for `seconds`, then holds; the page's acceleration at each frame. */
  const scroll = (slosh: Slosh, from: number, speed: number, seconds: number, hold: number) => {
    const out: number[] = [];
    let at = from;
    let t = 1;
    for (let i = 0; i * FRAME < seconds + hold; i++) {
      if (i * FRAME < seconds) at += speed * FRAME;
      out.push(slosh.step(at, t));
      t += FRAME;
    }
    return out;
  };

  it("is still while the page is", () => {
    expect(scroll(new Slosh(), 2, 0, 0, 1).every((a) => a === 0)).toBe(true);
  });

  it("feels the page set off down, then stop, and nothing at a steady pace", () => {
    const felt = scroll(new Slosh(), 0, 0.8, 1, 1);
    const stop = 60;

    expect(Math.max(...felt.slice(0, 10))).toBeGreaterThan(1);
    expect(Math.abs(felt[stop - 2] ?? 1)).toBeLessThan(0.05);
    expect(Math.min(...felt.slice(stop, stop + 10))).toBeLessThan(-1);
    expect(Math.abs(felt.at(-1) ?? 1)).toBeLessThan(0.01);
  });

  it("feels the other way when the page goes up", () => {
    expect(Math.min(...scroll(new Slosh(), 3, -0.8, 0.5, 0).slice(0, 10))).toBeLessThan(-1);
  });

  it("moves along at once after a jump, rather than slamming the liquid", () => {
    const slosh = new Slosh();
    slosh.step(0, 1);

    expect(slosh.step(4, 1 + FRAME)).toBe(0);
    expect(slosh.step(4, 1 + 2 * FRAME)).toBe(0);
  });
});

describe("the tank", () => {
  it("holds the liquid beside the copy and above its foot, leaving the header clear", () => {
    const side = layoutFor("side", 1440, 900, { right: 720, bottom: 640 });
    const body = heroBody(side, 1440, 900, 790);

    expect(body.x - body.hx).toBeCloseTo((0.53 - 0.5) * 1.6, 9);
    expect(body.x + body.hx).toBeGreaterThan(0.8);
    expect((0.5 - body.y - body.hy) * 900).toBeGreaterThanOrEqual(95);
    expect(body.y - body.hy).toBeCloseTo(0.5 - 790 / 900, 9);
  });

  it("holds it under the copy when the page stacks, across the whole width", () => {
    const below = layoutFor("below", 390, 930, { right: 360, bottom: 600 });
    const body = heroBody(below, 390, 930, 850);

    expect(body.x - body.hx).toBeLessThan(-390 / 930 / 2);
    expect(body.x + body.hx).toBeGreaterThan(390 / 930 / 2);
    expect(body.y + body.hy).toBeLessThan(0.5 - 600 / 930);
    expect(body.y - body.hy).toBeCloseTo(0.5 - 850 / 930, 9);
  });

  it("keeps the edge's waver within a sixth of the width on a tall hero, and restrained on desktop", () => {
    const tall = heroBody(layoutFor("below", 390, 1720, { right: 360, bottom: 480 }), 390, 1720, 1320);
    const wide = heroBody(layoutFor("side", 1440, 900, { right: 720, bottom: 640 }), 1440, 900, 790);

    expect(tall.wobble * 1720).toBeCloseTo(390 / 6, 6);
    expect(wide.wobble).toBeLessThanOrEqual(0.14);
  });

  it("lays three grids over the whole page that share one rect, finer by twos", () => {
    const grid = tankGrid(1440, 4963, 4096);

    expect(grid.texel).toBe(TANK_TEXEL);
    expect(grid.width).toBeGreaterThanOrEqual(1440);
    expect(grid.height).toBeGreaterThanOrEqual(4963);
    expect(grid.width).toBe(grid.cols * 4 * grid.texel);
    expect(grid.height - 4963).toBeLessThan(4 * grid.texel);
  });

  it("coarsens on a page too long for the GPU", () => {
    const grid = tankGrid(390, 30000, 4096);

    expect(grid.rows * 4).toBeLessThanOrEqual(4096);
    expect(grid.height).toBeGreaterThanOrEqual(30000);
  });

  // A grid 9 wide: an L-shaped channel two cells wide, from a hero along the top down to a pool at
  // the bottom; a dead end off it; walls everywhere else.
  const cols = 9;
  const rows = 12;
  const at = (x: number, y: number) => y * cols + x;
  const depth = new Float32Array(cols * rows).fill(-20);
  const hero = new Uint8Array(cols * rows);
  const pool = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) for (const x of [3, 4]) depth[at(x, y)] = x === 3 ? 6 : 6;
  for (let x = 0; x < cols; x++) for (const y of [10, 11]) {
    depth[at(x, y)] = 12;
    hero[at(x, y)] = 1;
  }
  for (const y of [0, 1]) for (const x of [3, 4]) pool[at(x, y)] = 1;
  for (let x = 5; x < 8; x++) depth[at(x, 5)] = 5;
  const open = Uint8Array.from(depth, (d) => (d > 0 ? 1 : 0));

  it("measures how far the liquid has to run, round its walls", () => {
    const far = geodesic(open, cols, rows, [at(3, 0)]);

    expect(far[at(3, 0)]).toBe(0);
    expect(far[at(3, 9)]).toBe(9);
    expect(far[at(4, 9)]).toBeCloseTo(8 + Math.SQRT2, 9);
    expect(far[at(0, 0)]).toBe(Infinity);
    expect(far[at(7, 5)]).toBeCloseTo(5 + 2 * Math.SQRT2, 9);
  });

  it("runs from the hero down to the pool, and never into a wall", () => {
    const flow = tankFlow({ depth, cols, rows, cell: 12, hero: { cells: hero, centre: [4, 10.5], spin: 0 }, pool: { cells: pool, centre: [3.5, 0.5], spin: 0 } });
    const v = (x: number, y: number) => [flow[2 * at(x, y)] ?? NaN, flow[2 * at(x, y) + 1] ?? NaN];

    for (let y = 3; y < 9; y++) expect(v(3, y)[1]).toBeLessThan(0);
    for (const x of [0, 1, 2, 6, 7, 8]) expect(v(x, 3)).toEqual([0, 0]);
    expect(Math.abs(v(3, 6)[0] ?? 1)).toBeLessThan(Math.abs(v(3, 6)[1] ?? 0));
  });

  it("runs slower down a branch it only passes, and never faster than the most it holds", () => {
    const flow = tankFlow({ depth, cols, rows, cell: 12, hero: { cells: hero, centre: [4, 10.5], spin: 0 }, pool: { cells: pool, centre: [3.5, 0.5], spin: 0 } });
    const speed = (x: number, y: number) => Math.hypot(flow[2 * at(x, y)] ?? 0, flow[2 * at(x, y) + 1] ?? 0);

    expect(speed(7, 5)).toBeLessThan(speed(3, 7));
    for (let i = 0; i < cols * rows; i++) expect(Math.hypot(flow[2 * i] ?? 0, flow[2 * i + 1] ?? 0)).toBeLessThanOrEqual(FLOW_MAX + 1e-3);
  });

  it("runs fastest down the middle of a channel and slows to its banks", () => {
    // A channel five wide, deepest down its middle.
    const wide = 7;
    const tall = 10;
    const d = new Float32Array(wide * tall).fill(-20);
    const top = new Uint8Array(wide * tall);
    const end = new Uint8Array(wide * tall);
    for (let y = 0; y < tall; y++) for (let x = 1; x < 6; x++) d[y * wide + x] = [6, 18, 30, 18, 6][x - 1] ?? 0;
    for (let x = 1; x < 6; x++) {
      top[(tall - 1) * wide + x] = 1;
      end[x] = 1;
    }
    const flow = tankFlow({ depth: d, cols: wide, rows: tall, cell: 12, hero: { cells: top, centre: [3, 9], spin: 0 }, pool: { cells: end, centre: [3, 0], spin: 0 } });
    const down = (x: number) => -(flow[2 * (5 * wide + x) + 1] ?? 0);

    expect(down(3)).toBeGreaterThan(down(2));
    expect(down(2)).toBeGreaterThan(down(1));
    expect(down(1)).toBeGreaterThan(0);
  });

  it("keeps the flow in 8 bits a part, still at the middle value", () => {
    const bytes = encodeFlow(Float32Array.from([0, 0, FLOW_MAX, -FLOW_MAX, 1e3, 0]));

    expect([...bytes.slice(0, 4)]).toEqual([128, 128, 0, 255]);
    expect([...bytes.slice(4, 8)]).toEqual([255, 0, 0, 255]);
    expect(bytes[8]).toBe(255);
  });

  it("knows which rows have liquid near them, so a screen with none draws nothing", () => {
    const wet = wetRows(depth.map((d, i) => (i >= at(0, 4) ? -20 : d)), cols, rows, 1);

    expect([...wet]).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("wave timing and resume", () => {
  it("keeps both wave axes and face velocities within the stability bound, including slow frames", () => {
    for (const dt of [1 / 144, 1 / 120, 1 / 60, 1 / 30, 0.05]) {
      for (const speed of [25, 50, 70, 100]) {
        const steps = waveSteps(dt, speed, 32);
        expect(dt / steps * (Math.SQRT2 * speed * 2 + 64)).toBeLessThanOrEqual(0.45);
      }
    }
    expect(waveSteps(0.05, 100, 32)).toBeGreaterThan(10);
  });

  it("resumes scrolling without carrying an impulse from before the pause", () => {
    const slosh = new Slosh();
    slosh.step(0, 1);
    expect(slosh.step(0.1, 1 + FRAME)).toBeGreaterThan(0);
    slosh.reset();
    expect(slosh.step(0.5, 20)).toBe(0);
    expect(slosh.step(0.5, 20 + FRAME)).toBe(0);
  });

  it("discards pending taps and strokes when the page pauses or becomes hidden", () => {
    const brush = new Brush();
    brush.point(0, 0);
    brush.step(1);
    brush.point(0.1, 0);
    brush.press(0.1, 0);
    brush.reset();
    expect(brush.takePress()).toBeNull();
    expect(brush.paint()).toBeNull();
    brush.point(-0.3, 0.2);
    brush.step(20);
    expect(brush.speed).toBe(0);
    expect(brush.paint()?.segment).toEqual([-0.3, 0.2, -0.3, 0.2]);
  });
});
