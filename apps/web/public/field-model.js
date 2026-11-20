// The arithmetic behind the page's ink, apart from the page so it can be tested: where the
// liquid sits in the hero in each layout, the river that carries it down the page, the shapes it
// runs into and the necks between them, the distance field of the letters it fills, the tank all
// of it makes and the way the liquid flows through it, how many pixels it is drawn with, how the
// page's scroll sloshes it, and the brush the pointer moves through it.
//
// Field units: 1 is the hero's height, the origin is the hero's centre, y points up, so all
// of the page below the hero is under y = -0.5. The shader, the pointer and the layout all speak
// them, so the pointer lands where it is drawn and the ink stays put on the page as it scrolls.

/** Pixels drawn per frame at most. The ink is soft, so a large screen gets a scaled-up canvas. */
export const PIXEL_BUDGET = 1_200_000;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * A point on the hero, in CSS pixels from its top left, in field units.
 * @returns {[number, number]}
 */
export function toField(x, y, width, height) {
  return [(x - width / 2) / height, (height / 2 - y) / height];
}

/**
 * Where the ink sits and how far the shade reaches, from where the copy actually ended up.
 * `side`: the copy on the left, the ink to its right; the shade darkens toward the copy's right
 * edge. `below`: the copy on top, the ink under it; the shade darkens down to the copy's bottom.
 * `copy.right` and `copy.bottom` are the text's extent in CSS pixels from the hero's top left.
 */
export function layoutFor(mode, width, height, copy) {
  if (mode === "below") {
    const edge = clamp(copy.bottom / height, 0.2, 0.9);
    return { centre: toField(width / 2, copy.bottom + (height - copy.bottom) * 0.4, width, height), below: 1, edge };
  }
  const edge = clamp(copy.right / width, 0.2, 0.9);
  const x = clamp((copy.right + width) / 2, 0.6 * width, 0.82 * width);
  return { centre: toField(x, height / 2, width, height), below: 0, edge };
}

/**
 * The canvas's size in device pixels: sharp up to 1.5x, never over the budget, times `quality`.
 * @returns {[number, number]}
 */
export function canvasSize(width, height, dpr, quality = 1) {
  let density = Math.min(dpr, 1.5) * quality;
  const pixels = width * height * density * density;
  if (pixels > PIXEL_BUDGET) density *= Math.sqrt(PIXEL_BUDGET / pixels);
  return [Math.max(1, Math.round(width * density)), Math.max(1, Math.round(height * density))];
}

/**
 * Where the canvas goes on the page for this scroll, in CSS pixels from the page's top. It is
 * `canvas` tall, taller than the `screen`, and part of the page, so the browser scrolls it with
 * the text; it is put with the screen in its middle, so a scroll can run on a way before it needs
 * drawing again, and never past either end of the page (`room` tall).
 */
export function canvasTop(scroll, canvas, screen, room) {
  return Math.round(clamp(scroll - (canvas - screen) / 2, 0, Math.max(room - canvas, 0)));
}

/**
 * A point on the page, in CSS pixels from the page's top left, in field units. `frame` is the
 * page's width, the hero's height (`unit`) and the hero's top.
 * @returns {[number, number]}
 */
export function pageToField(x, y, frame) {
  return [(x - frame.width / 2) / frame.unit, (frame.top + frame.unit / 2 - y) / frame.unit];
}

/** The most pieces of river and necks, and ink shapes, drawn at once: the length of the shader's arrays. */
export const MAX_SEGMENTS = 10;
export const MAX_SHAPES = 6;

/** A piece of river bends in an S from one anchor down to the next; a neck runs straight from one shape to another. */
export const RIVER = 0;
export const NECK = 1;

/** How much narrower the river runs between two anchors than at them, so it beads at each one. */
export const PINCH = 0.35;

/** How much narrower a neck runs in its middle than where it meets its shapes. */
export const WAIST = 0.45;

/**
 * The river's course through `anchors` (each {x, y, half}, top first): a piece from each anchor to
 * the next, except from the way into a shape (`into`) to the way out of it (`outOf`), where the
 * shape carries the ink instead.
 */
export function riverSegments(anchors) {
  const out = [];
  for (let i = 0; i + 1 < anchors.length; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (a.into && a.into === b.outOf) continue;
    out.push({ kind: RIVER, a, b });
  }
  return out;
}

/**
 * A piece of river at height `y`: its middle, its half width and its slope (x per y), or null off
 * the piece. It eases from one anchor to the next, so it bends in an S and never kinks, and it
 * narrows between them; the shader draws the same curve.
 */
export function curveAt({ a, b }, y) {
  if (y > a.y || y < b.y) return null;
  const span = Math.max(a.y - b.y, 1e-4);
  const u = (a.y - y) / span;
  const s = u * u * (3 - 2 * u);
  return {
    x: a.x + (b.x - a.x) * s,
    half: (a.half + (b.half - a.half) * s) * (1 - PINCH * Math.sin(Math.PI * u)),
    slope: ((b.x - a.x) * 6 * u * (1 - u)) / span,
  };
}

/** The river at height `y`, on the first of its pieces there; null where it doesn't run. */
export function riverAt(segments, y) {
  for (const segment of segments) {
    const at = segment.kind === RIVER ? curveAt(segment, y) : null;
    if (at) return at;
  }
  return null;
}

/** The point on a ring's middle line ({x, y, radius}) that faces (x, y). */
export function port(ring, x, y) {
  const dx = x - ring.x;
  const dy = y - ring.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: ring.x + (dx / length) * ring.radius, y: ring.y + (dy / length) * ring.radius };
}

/** How far (x, y) lies from the line from a to b. */
function offLine(x, y, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const h = clamp(((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(x - a.x - dx * h, y - a.y - dy * h);
}

/**
 * Necks between rings ({x, y, radius, band}) that sit side by side or one above the other with no
 * more than `reach` between their bands and no ring between them: each from one ring's band to the
 * other's, facing.
 */
export function necks(rings, reach) {
  const out = [];
  for (let i = 0; i < rings.length; i++) {
    for (let j = i + 1; j < rings.length; j++) {
      const a = rings[i];
      const b = rings[j];
      if (!a || !b) continue;
      const lined = Math.abs(a.y - b.y) < a.radius / 2 || Math.abs(a.x - b.x) < a.radius / 2;
      const gap = Math.hypot(b.x - a.x, b.y - a.y) - a.radius - a.band - b.radius - b.band;
      const between = rings.some((c) => c !== a && c !== b && offLine(c.x, c.y, a, b) < c.radius);
      if (lined && gap <= reach && !between) out.push({ kind: NECK, a: { ...port(a, b.x, b.y), half: a.band }, b: { ...port(b, a.x, a.y), half: b.band } });
    }
  }
  return out;
}

/**
 * Necks from the river to the rings it runs past rather than through, where no more than `reach`
 * lies between its bank and a ring's band: level, from the river's middle to the ring's band.
 */
export function landings(segments, rings, reach) {
  return rings.flatMap((ring) => {
    const at = riverAt(segments, ring.y);
    if (!at || Math.abs(ring.x - at.x) - ring.radius - ring.band - at.half > reach) return [];
    return [{ kind: NECK, a: { x: at.x, y: ring.y, half: at.half }, b: { ...port(ring, at.x, ring.y), half: ring.band } }];
  });
}

/**
 * The pieces and necks that reach into the band from `top` to `bottom` (field y), with `margin`
 * to spare for the ink that melts and glows around them, at most MAX_SEGMENTS.
 */
export function segmentsIn(segments, top, bottom, margin) {
  return segments
    .filter((s) => {
      const reach = Math.max(s.a.half, s.b.half) + margin;
      return Math.min(s.a.y, s.b.y) - reach <= top && Math.max(s.a.y, s.b.y) + reach >= bottom;
    })
    .slice(0, MAX_SEGMENTS);
}

/** The shapes ({x, y, hx, hy, soft}) that reach into the band from `top` to `bottom`, with what melts and glows past their box (`soft`), at most MAX_SHAPES. */
export function shapesIn(shapes, top, bottom) {
  return shapes.filter((s) => s.y - s.hy - s.soft <= top && s.y + s.hy + s.soft >= bottom).slice(0, MAX_SHAPES);
}

const FAR = 1e20;

/** One row or column of the squared distance transform, in place (Felzenszwalb and Huttenlocher). */
function transform1d(grid, offset, stride, length, f, v, z) {
  for (let q = 0; q < length; q++) f[q] = grid[offset + q * stride];
  v[0] = 0;
  z[0] = -FAR;
  z[1] = FAR;
  for (let q = 1, k = 0; q < length; q++) {
    let s;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q * q - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = FAR;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    grid[offset + q * stride] = f[r] + (q - r) * (q - r);
  }
}

function transform2d(grid, width, height) {
  const size = Math.max(width, height);
  const f = new Float64Array(size);
  const v = new Uint32Array(size);
  const z = new Float64Array(size + 1);
  for (let x = 0; x < width; x++) transform1d(grid, x, width, height, f, v, z);
  for (let y = 0; y < height; y++) transform1d(grid, y * width, 1, width, f, v, z);
}

/**
 * How far each pixel of `alpha` (0 to 255, row by row from the top) lies from the edge of what is
 * drawn there, in pixels: negative inside, positive outside. A partly covered pixel at the edge
 * places the edge within it by how covered it is, so letters keep their smooth outline.
 */
export function glyphDistance(alpha, width, height) {
  const size = width * height;
  const outer = new Float64Array(size);
  const inner = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const a = (alpha[i] ?? 0) / 255;
    if (a >= 1) {
      inner[i] = FAR;
    } else if (a <= 0) {
      outer[i] = FAR;
    } else {
      const d = 0.5 - a;
      outer[i] = d > 0 ? d * d : 0;
      inner[i] = d < 0 ? d * d : 0;
    }
  }
  transform2d(outer, width, height);
  transform2d(inner, width, height);
  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) out[i] = Math.sqrt(outer[i]) - Math.sqrt(inner[i]);
  // Distances to pixel centres ripple a little along a curve; a light blur irons the ripple out
  // and leaves the edge where it was.
  soften(out, height, width, 1, width);
  soften(out, width, height, width, 1);
  return out;
}

/** A [1 2 1] blur along `lines` lines of `count` values `step` apart, each line `stride` on from the last. */
function soften(values, lines, count, step, stride) {
  for (let line = 0; line < lines; line++) {
    let before = values[line * stride] ?? 0;
    for (let q = 0; q < count; q++) {
      const at = line * stride + q * step;
      const here = values[at] ?? 0;
      const after = q + 1 < count ? (values[at + step] ?? 0) : here;
      values[at] = (before + 2 * here + after) / 4;
      before = here;
    }
  }
}

/** Within this many pixels of the edge a distance field's steps stay finer than a tenth of a pixel. */
export const DISTANCE_KNEE = 4;

/**
 * A distance field for the GPU in 8 bits, bottom row first: ±`range` pixels around the middle
 * value, on a log scale, so the steps are finest at the edge, where the outline and its light are
 * drawn, and the distance still runs straight through it. The shader turns it back (decodeDistance).
 */
export function encodeDistance(sd, width, height, range) {
  const full = Math.log1p(range / DISTANCE_KNEE);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = sd[y * width + x] ?? 0;
      const e = (Math.sign(d) * Math.log1p(Math.min(Math.abs(d), range) / DISTANCE_KNEE)) / full;
      out[(height - 1 - y) * width + x] = Math.round(255 * (0.5 - e / 2));
    }
  }
  return out;
}

/** What encodeDistance wrote, back in pixels: `value` is 0 to 1. */
export function decodeDistance(value, range) {
  const e = 1 - 2 * value;
  return Math.sign(e) * DISTANCE_KNEE * Math.expm1(Math.abs(e) * Math.log1p(range / DISTANCE_KNEE));
}

/** The pixel at least `depth` inside a distance field nearest (x, y), all in its pixels from the top left; null if there is none. */
export function nearestInside(sd, width, height, x, y, depth) {
  let best = null;
  let bestSq = Infinity;
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      if ((sd[j * width + i] ?? 0) > -depth) continue;
      const sq = (i - x) ** 2 + (j - y) ** 2;
      if (sq < bestSq) {
        bestSq = sq;
        best = { x: i, y: j };
      }
    }
  }
  return best;
}

/**
 * The hero's body of liquid, the widest part of the tank, as a box in field units ({x, y, hx, hy,
 * round, wobble}): beside the copy (`side`), from a little past its right edge to past the hero's
 * right, below the header, or under it (`below`), across the whole width. It reaches down to `floor` (CSS px
 * from the hero's top), clear of the line along the hero's foot, and lets the river out of its
 * bottom. Its edge wavers inward by up to `wobble`: less on a body too shallow to give much up,
 * and on a hero much taller than wide (a phone's, where the stacked copy, phone and steps make it
 * long) no more than a sixth of its width, so the liquid still reaches what lies in it.
 */
export function heroBody(layout, width, height, floor) {
  const aspect = width / height;
  const past = 0.08;
  const bottom = 0.5 - floor / height;
  const left = layout.below ? -aspect / 2 - past : (Math.min(layout.edge + 0.03, 0.85) - 0.5) * aspect;
  const top = layout.below ? Math.max(0.5 - layout.edge - 0.05, bottom + 0.08) : 0.5 - 96 / height;
  const right = aspect / 2 + past;
  const hy = (top - bottom) / 2;
  return { x: (left + right) / 2, y: (top + bottom) / 2, hx: (right - left) / 2, hy, round: Math.min(0.3, hy), wobble: Math.min(0.14, hy * 0.6, aspect / 6) };
}

/** CSS px per texel of the tank's distance field; a cell of its waves is two texels, a cell of its flow four. */
export const TANK_TEXEL = 3;

/** A conservative 2D CFL bound, including both axes, face speeds and a fourfold depth margin.
 * Never cap the number of steps: doing so made a 50 ms frame less stable than a 16 ms one. */
export function waveSteps(dt, speed, fastest, depth = 4) {
  return Math.max(1, Math.ceil(Math.max(0, dt) * (Math.SQRT2 * speed * Math.sqrt(depth) + 2 * fastest) / 0.45));
}

/**
 * The tank's grids for a page `width` by `height` CSS px: one rect over the whole page, `cols` by
 * `rows` cells of its flow, each two cells of its waves and four texels of its distance field
 * across, so all three cover the same rect and share one map. On a page too long for the GPU's
 * `maxSize` the texel grows.
 */
export function tankGrid(width, height, maxSize) {
  let texel = TANK_TEXEL;
  while (Math.ceil(Math.max(width, height) / (4 * texel)) * 4 > maxSize) texel++;
  const cols = Math.ceil(width / (4 * texel));
  const rows = Math.ceil(height / (4 * texel));
  return { texel, cols, rows, width: cols * 4 * texel, height: rows * 4 * texel };
}

/**
 * How far each cell of a grid (rows bottom first) lies from the nearest of the `seeds`, going only
 * through `open` cells, eight ways out of each (diagonals √2), in cells: the way a liquid would have
 * to run, round its walls. Infinity where it can't get to.
 */
export function geodesic(open, cols, rows, seeds) {
  // In doubles: a sum that rounds back to what a cell already holds must never count as nearer.
  const far = new Float64Array(cols * rows).fill(Infinity);
  for (const i of seeds) if (open[i]) far[i] = 0;
  const cells = openCells(open);
  const D = Math.SQRT2;
  // Sweeps forward and back over the open cells until nothing gets nearer: a few for a channel
  // that winds.
  for (let pass = 0; pass < 200; pass++) {
    let nearer = false;
    for (let n = 0; n < cells.length; n++) {
      const i = cells[n];
      const x = i % cols;
      let best = far[i];
      if (x > 0) best = Math.min(best, far[i - 1] + 1);
      if (i >= cols) {
        best = Math.min(best, far[i - cols] + 1);
        if (x > 0) best = Math.min(best, far[i - cols - 1] + D);
        if (x + 1 < cols) best = Math.min(best, far[i - cols + 1] + D);
      }
      if (best < far[i]) {
        far[i] = best;
        nearer = true;
      }
    }
    for (let n = cells.length - 1; n >= 0; n--) {
      const i = cells[n];
      const x = i % cols;
      let best = far[i];
      if (x + 1 < cols) best = Math.min(best, far[i + 1] + 1);
      if (i + cols < cols * rows) {
        best = Math.min(best, far[i + cols] + 1);
        if (x + 1 < cols) best = Math.min(best, far[i + cols + 1] + D);
        if (x > 0) best = Math.min(best, far[i + cols - 1] + D);
      }
      if (best < far[i]) {
        far[i] = best;
        nearer = true;
      }
    }
    if (!nearer) break;
  }
  return far;
}

/** The indices of the open cells, in order. */
function openCells(open) {
  let count = 0;
  for (let i = 0; i < open.length; i++) count += open[i] ? 1 : 0;
  const cells = new Int32Array(count);
  for (let i = 0, n = 0; i < open.length; i++) if (open[i]) cells[n++] = i;
  return cells;
}

/** How fast the liquid runs: down the middle of a channel `w` px across its half, FLOW / w px a second. */
export const FLOW = 1500;
/** The fastest it runs anywhere, px a second; the flow's texture holds ± this. */
export const FLOW_MAX = 120;
/** A side branch (a ring off the river) runs slower the further it leads off the way through: this far, px, to a third. */
const BRANCH = 90;
/** It never stops altogether: a side branch still runs this much of a channel's pace. */
const BRANCH_LEAST = 0.25;
/** Wider than this (half, px), a body of liquid counts as wide; the distance field holds no more. */
const WIDEST = 64;

/**
 * The liquid's own flow through the tank, cell by cell (px a second, x right, y up; rows bottom
 * first): downhill from the hero to the pool along the shortest way through the liquid, so it runs
 * round a ring on both sides and on out; fastest down the middle of a channel and still at its
 * banks, as a liquid runs in a pipe, and faster where the channel narrows; slower in a branch off
 * the way through; slow in the hero, and faster as it nears the way out; turning over slowly in the
 * hero and in the pool; and never into a wall.
 *
 * `depth`: how far inside the liquid each cell's middle lies, px (negative outside); `cell`: px a
 * cell. `hero` and `pool`: {cells (1 for each cell of it), centre: [x, y] in cells, spin (radians a
 * second, anticlockwise)}; without a pool, the flow ends at the lowest liquid.
 */
export function tankFlow({ depth, cols, rows, cell, hero, pool }) {
  const size = cols * rows;
  const open = new Uint8Array(size);
  for (let i = 0; i < size; i++) open[i] = depth[i] > -0.4 * cell ? 1 : 0;
  const cells = openCells(open);
  const ofHero = [];
  const ofPool = [];
  for (const i of cells) {
    if (hero.cells[i]) ofHero.push(i);
    else if (pool?.cells[i]) ofPool.push(i);
  }
  if (!ofPool.length && cells.length) ofPool.push(cells[0]);
  const toPool = geodesic(open, cols, rows, ofPool);
  const fromHero = geodesic(open, cols, rows, ofHero);
  // Where the hero lets the river out: its liquid nearest the pool.
  let shortest = Infinity;
  for (const i of ofHero) shortest = Math.min(shortest, toPool[i]);
  if (!Number.isFinite(shortest)) shortest = 0;
  const wide = widths(depth, cells, cols, rows, Math.ceil(WIDEST / cell));

  const out = new Float32Array(size * 2);
  for (const i of cells) {
    const away = toPool[i];
    if (!Number.isFinite(away)) continue;
    const x = i % cols;
    const y = (i - x) / cols;
    const w = clamp(wide[i], cell, WIDEST);
    const across = clamp(depth[i] / w, 0, 1);
    // Still at the banks, fastest down the middle.
    const profile = across * (2 - across);
    const gx = slope(toPool, open, i, x > 0 ? i - 1 : -1, x + 1 < cols ? i + 1 : -1);
    const gy = slope(toPool, open, i, y > 0 ? i - cols : -1, y + 1 < rows ? i + cols : -1);
    const length = Math.sqrt(gx * gx + gy * gy);
    let speed;
    if (hero.cells[i]) speed = FLOW / Math.max(w, (away - shortest) * cell * 1.6);
    else if (pool?.cells[i]) speed = 0;
    else speed = (FLOW / w) * Math.max(BRANCH_LEAST, Math.exp((-Math.max(0, fromHero[i] + away - shortest) * cell) / BRANCH));
    let vx = length > 0 ? (-gx / length) * speed : 0;
    let vy = length > 0 ? (-gy / length) * speed : 0;
    const turn = hero.cells[i] ? hero : pool?.cells[i] ? pool : null;
    if (turn) {
      vx -= (y - turn.centre[1]) * turn.spin * cell;
      vy += (x - turn.centre[0]) * turn.spin * cell;
    }
    // Near a wall, whatever would run into it runs along it instead.
    const nx = slope(depth, open, i, x > 0 ? i - 1 : -1, x + 1 < cols ? i + 1 : -1);
    const ny = slope(depth, open, i, y > 0 ? i - cols : -1, y + 1 < rows ? i + cols : -1);
    const n = Math.sqrt(nx * nx + ny * ny);
    const into = n > 0 ? -(vx * nx + vy * ny) / n : 0;
    if (into > 0) {
      const near = 1 - clamp(depth[i] / (2 * cell), 0, 1);
      vx += (nx / n) * into * near;
      vy += (ny / n) * into * near;
    }
    out[2 * i] = vx * profile;
    out[2 * i + 1] = vy * profile;
  }
  smooth(out, open, cells, cols, rows);
  smooth(out, open, cells, cols, rows);
  for (const i of cells) {
    const v = Math.sqrt(out[2 * i] ** 2 + out[2 * i + 1] ** 2);
    if (v > FLOW_MAX) {
      out[2 * i] = (out[2 * i] * FLOW_MAX) / v;
      out[2 * i + 1] = (out[2 * i + 1] * FLOW_MAX) / v;
    }
  }
  return out;
}

/**
 * The slope of `field` at cell `i` along one axis, per cell, from its open neighbours `before` and
 * `after` (-1 off the grid): across both, or one side where the other is shut.
 */
function slope(field, open, i, before, after) {
  const a = after >= 0 && open[after] && Number.isFinite(field[after]) ? field[after] : null;
  const b = before >= 0 && open[before] && Number.isFinite(field[before]) ? field[before] : null;
  if (a !== null && b !== null) return (a - b) / 2;
  const here = Number.isFinite(field[i]) ? field[i] : 0;
  return a !== null ? a - here : b !== null ? here - b : 0;
}

/** Each open cell's channel half width, px: the deepest liquid within `reach` cells of it. */
function widths(depth, cells, cols, rows, reach) {
  // Each cell of liquid spreads its depth along its row, then each of those down its column.
  const across = new Float32Array(cols * rows);
  for (const i of cells) {
    const d = depth[i];
    if (d <= 0) continue;
    const x = i % cols;
    const row = i - x;
    for (let k = Math.max(0, x - reach); k <= Math.min(cols - 1, x + reach); k++) if (across[row + k] < d) across[row + k] = d;
  }
  const out = new Float32Array(cols * rows);
  for (let i = 0; i < across.length; i++) {
    const d = across[i];
    if (d <= 0) continue;
    const x = i % cols;
    const y = (i - x) / cols;
    for (let k = Math.max(0, y - reach); k <= Math.min(rows - 1, y + reach); k++) if (out[k * cols + x] < d) out[k * cols + x] = d;
  }
  return out;
}

/** Each open cell's flow, averaged with its open neighbours': the grid's steps ironed out. */
function smooth(flow, open, cells, cols, rows) {
  const was = Float32Array.from(flow);
  for (const i of cells) {
    const x = i % cols;
    const y = (i - x) / cols;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let cy = Math.max(0, y - 1); cy <= Math.min(rows - 1, y + 1); cy++) {
      for (let cx = Math.max(0, x - 1); cx <= Math.min(cols - 1, x + 1); cx++) {
        const j = cy * cols + cx;
        if (!open[j]) continue;
        sx += was[2 * j];
        sy += was[2 * j + 1];
        n++;
      }
    }
    flow[2 * i] = sx / n;
    flow[2 * i + 1] = sy / n;
  }
}

/** The flow for the GPU in 8 bits a part: ±FLOW_MAX around the middle value, x in red, y in green. */
export function encodeFlow(flow) {
  const size = flow.length / 2;
  const out = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    out[4 * i] = Math.round(255 * clamp(0.5 + (flow[2 * i] ?? 0) / (2 * FLOW_MAX), 0, 1));
    out[4 * i + 1] = Math.round(255 * clamp(0.5 + (flow[2 * i + 1] ?? 0) / (2 * FLOW_MAX), 0, 1));
    out[4 * i + 3] = 255;
  }
  return out;
}

/** Which rows of the grid (bottom first) have liquid within `margin` rows of them: where the canvas has anything to draw. */
export function wetRows(depth, cols, rows, margin) {
  const wet = new Uint8Array(rows);
  for (let y = 0; y < rows; y++) {
    let any = false;
    for (let x = 0; x < cols && !any; x++) any = (depth[y * cols + x] ?? -1) > 0;
    if (!any) continue;
    for (let k = Math.max(0, y - margin); k <= Math.min(rows - 1, y + margin); k++) wet[k] = 1;
  }
  return wet;
}

/**
 * How the page accelerates as it scrolls: what the liquid feels when the tank it is in is carried,
 * so it sloshes back as the page sets off and on as the page stops. The scroll comes in uneven
 * steps, so it is followed on a critically damped spring and the spring's acceleration is the
 * page's; a jump (a link, a reload) moves the spring along at once rather than slamming the liquid.
 */
export class Slosh {
  /** The spring's stiffness, per second: higher follows tighter. */
  static FOLLOW = 12;
  /** A scroll this far in one frame, field units, is a jump. */
  static JUMP = 1.5;

  #pos = null;
  #vel = 0;
  #last = null;

  /** Resuming a paused/hidden page starts from its actual position without an old impulse. */
  reset() {
    this.#pos = null;
    this.#vel = 0;
    this.#last = null;
  }

  /** The page is scrolled to `scroll` (field units, down positive) at `time` (seconds): its acceleration, field units a second², down positive. */
  step(scroll, time) {
    const dt = this.#last === null ? 0 : clamp(time - this.#last, 0, 0.05);
    this.#last = time;
    if (this.#pos === null || Math.abs(scroll - this.#pos) > Slosh.JUMP) {
      this.#pos = scroll;
      this.#vel = 0;
      return 0;
    }
    if (dt <= 0) return 0;
    const was = this.#vel;
    const w = Slosh.FOLLOW;
    const decay = Math.exp(-w * dt);
    const c1 = this.#pos - scroll;
    const c2 = this.#vel + w * c1;
    this.#pos = scroll + (c1 + c2 * dt) * decay;
    this.#vel = (c2 - w * (c1 + c2 * dt)) * decay;
    return (this.#vel - was) / dt;
  }
}

const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * What the pointer moves through the liquid. Pointer events arrive unevenly, so the brush never
 * jumps to them: it hangs on a critically damped spring, so both its position and its speed change
 * smoothly, it never overshoots, and at a steady pace it runs 2 / FOLLOW seconds (about 60 ms)
 * behind. Each frame it drags the liquid along its own move, and a press drops into it.
 */
export class Brush {
  /** The spring's stiffness, per second: higher follows tighter. */
  static FOLLOW = 34;
  /** A pointer that moves this far in one event jumped (a scroll, a re-entry): the brush goes there without a streak. */
  static JUMP = 0.3;

  #target = null;
  #pos = null;
  #from = null;
  #vel = [0, 0];
  #last = null;
  #press = null;

  reset() {
    this.#target = this.#pos = this.#from = this.#last = this.#press = null;
    this.#vel = [0, 0];
  }

  /** The pointer is at (x, y), in field units. */
  point(x, y) {
    const target = this.#target;
    if (!target || !this.#pos || Math.hypot(x - target[0], y - target[1]) > Brush.JUMP) {
      this.#pos = [x, y];
      this.#from = [x, y];
      this.#vel = [0, 0];
    }
    this.#target = [x, y];
  }

  /** The pointer left, or the page scrolled under it: the brush rests, and the next point starts afresh. */
  leave() {
    this.#target = null;
  }

  /** The pointer pressed at (x, y). */
  press(x, y) {
    this.#press = [x, y];
  }

  /** Where the last press was, once: null after it has been taken, or before any. */
  takePress() {
    const press = this.#press;
    this.#press = null;
    return press;
  }

  /** Where the brush is, in field units, or null before the pointer came. */
  get position() {
    return this.#pos ? [...this.#pos] : null;
  }

  /** How fast it moves, in field units a second. */
  get speed() {
    return Math.hypot(this.#vel[0], this.#vel[1]);
  }

  /** Moves the brush on to `time` (seconds), once per frame. */
  step(time) {
    const dt = this.#last === null ? 0 : clamp(time - this.#last, 0, 0.05);
    this.#last = time;
    if (!this.#pos || dt <= 0) return;
    // The spring solved exactly over the step, so it is steady at any frame rate. With no pointer
    // it settles where it is.
    const w = Brush.FOLLOW;
    const decay = Math.exp(-w * dt);
    const goal = this.#target ? [...this.#target] : [...this.#pos];
    for (const i of [0, 1]) {
      const c1 = (this.#pos[i] ?? 0) - (goal[i] ?? 0);
      const c2 = (this.#vel[i] ?? 0) + w * c1;
      this.#pos[i] = (goal[i] ?? 0) + (c1 + c2 * dt) * decay;
      this.#vel[i] = (c2 - w * (c1 + c2 * dt)) * decay;
    }
  }

  /**
   * What it does to the liquid since the last time: the segment it covered, its velocity (field
   * units a second) and how hard it drags, from 0 at rest to 1 at a stroke's pace. Null before the
   * pointer came.
   */
  paint() {
    if (!this.#pos) return null;
    const from = this.#from ?? this.#pos;
    this.#from = [...this.#pos];
    return { segment: [from[0], from[1], this.#pos[0], this.#pos[1]], velocity: [...this.#vel], weight: smoothstep(0.05, 0.4, this.speed) };
  }
}
