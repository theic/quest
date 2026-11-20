// The page's moving ink: one tank of liquid in acid lime behind the page, drawn on the GPU into one
// canvas. The liquid fills a pool in the hero behind the phone, beside or below the copy, drains
// out of its foot and runs down the page as a river through every [data-river] mark the page sets,
// into and out of every [data-ink] shape on its way (a pool at the end; a ring or letters, where a
// page has them), with necks of the same liquid between rings that sit close together. It is all
// one body:
//
// - Its outline is worked out once a layout, as a distance field over the whole page: the tank's
//   walls. A frame reads where the liquid is rather than working it out.
// - It flows one way through all of it, downhill from the hero to the pool along the shortest way
//   through the liquid: round a ring on both sides and on out, fastest down the middle of a channel
//   and still at its banks, faster where it narrows, turning over slowly in the hero and the pool
//   (tankFlow in field-model.js). Its marbling is carried along with it.
// - Its surface is a shallow sheet of liquid, simulated on a coarse grid over the page: the pointer
//   drags it and a press drops into it, and a scroll sloshes it, the way a tank sloshes when it is
//   carried. Every wave runs on through the necks and channels into the rest of it and back off
//   its walls, then settles.
//
// The canvas is 1.4 screens tall and part of the page, so the browser scrolls it with the text,
// frame for frame, and it is moved along and drawn afresh around wherever the screen has got to.
// Where WebGL is missing, the canvas stays hidden and the hero's CSS glow stands in for its ink.
// The button under the phone pauses it with the phone's demo (demo.js sends a "motion" event).
//
// What it costs: about two dozen texture reads for a pixel of liquid and one for a pixel clear of it, no
// more pixels on the screen than PIXEL_BUDGET and fewer on a GPU that can't keep up, the waves
// worked on only around the screen and only for a few seconds after something stirs them, frames
// about 30 a second while only the hero's liquid turns and on every display frame while the river
// shows or anything moves, and nothing drawn while no liquid is on the canvas or the tab is hidden.
// The tank's outline, its flow and its marbling are worked out once a layout. Paused, it draws only
// when the screen has scrolled half way to the canvas's edge.
import {
  Brush,
  DISTANCE_KNEE,
  FLOW_MAX,
  MAX_SEGMENTS,
  MAX_SHAPES,
  PINCH,
  Slosh,
  WAIST,
  canvasSize,
  canvasTop,
  encodeDistance,
  encodeFlow,
  glyphDistance,
  heroBody,
  landings,
  layoutFor,
  nearestInside,
  necks,
  pageToField,
  port,
  riverSegments,
  segmentsIn,
  shapesIn,
  tankFlow,
  tankGrid,
  waveSteps,
  wetRows,
} from "./field-model.js";

// Every display frame while anything moves or the river shows; about 30 a second while only the
// hero's liquid turns.
const STIRRING_MS = 1000 / 60;
const DRIFTING_MS = 1000 / 30;

// The river leaves the hero's ink this wide (half widths, field units), narrowing to its foot.
const OUT_OF_INK = 0.16;
const AT_FOOT = 0.035;
const KINDS = { pool: 1, ring: 2, type: 3 };
// The hero's body stops this far (CSS px) above its floor; under the copy, it starts this far
// (CSS px) above the phone, so the phone lies in it.
const FLOOR_GAP = 24;
const ABOVE_PHONE = 56;

// The surface relief: a tile this many CSS pixels across, of so many texels; carried along the flow for
// PERIOD seconds before a phase starts afresh. The hero's liquid and the pool turn over this fast
// (radians a second).
const TILE = 760; // CSS pixels, so the material keeps its scale on a tall mobile hero.
const MARBLE_SIZE = 512;
const PERIOD = 4;
const HERO_SPIN = 0.025;
const POOL_SPIN = 0.045;

// The waves: how fast they run where the liquid is deepest (CSS px a second), how long it keeps its
// speed (seconds), how long after the last stir they are worked on, how far round the brush it drags
// and how hard, how wide a press is and how fast it pushes the liquid out (cells a second), how much
// of the page's acceleration the liquid feels, up to how much.
const WAVE_SPEED = 300;
const DRAG_SECONDS = 0.95;
const SETTLE_SECONDS = 8;
const DRAG_REACH = 38;
const BRUSH_DRAG = 0.38;
const PRESS_REACH = 28;
const PRESS = 28;
const SLOSH = 0.1;
const SLOSH_MOST = 3200;
// The liquid's bed: it deepens to its full depth this far (CSS px) inside its edge, and the bank
// outside rises as steeply, so the liquid can run up out of its outline and slide back. Shallower
// than WET (of its full depth), a cell is dry; thin liquid drags on its bed (FRICTION); and it never
// runs faster than FASTEST (cells a second).
const BANK = 24;
const WET = 0.002;
const FRICTION = 0.4;
const FASTEST = 32;
// How the waves show: how far their speed and slope carry and bend the marbling (seconds, CSS px),
// and how steep they look.
const SEEN = 0.15;
const BEND = 22;
const WAVE = 12;

const PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif`;

// How near two parts of the liquid come before they melt together, how far its distance field
// reaches either side of its edge, and how far its glow shows: CSS pixels.
const MELT = 30;
const RANGE = 64;
const GLOW = 48;

// The tank's distance field: ±RANGE CSS px around the liquid's edge in 16 bits (red and green), so
// it reads back smoothly between texels.
const DISTANCE = `
float dist(sampler2D field, vec2 at) { vec4 c = texture2D(field, at); return (c.r + c.g / 255. - .5) * ${(2 * RANGE).toFixed(1)}; }`;

const NOISE = `
float hash(vec2 v) { return fract(sin(dot(v, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 v) {
  vec2 i = floor(v), f = fract(v);
  f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + 1.), f.x), f.y);
}`;

// The surface relief, worked out once into a seamless tile: smooth height in red and green,
// with 16-bit encoding to keep its normals free of quantization bands.
const MARBLE = `${PRECISION}
uniform float size;   // the tile, in texels
void main() {
  vec2 p = gl_FragCoord.xy / size * 6.2831853;
  // A seamless, low-frequency height map. Fractal detail in the normals made the old
  // surface look crumpled; these three broad folds leave room for actual interaction waves.
  float k = (.5 + .16 * sin(p.x + 1.7 * sin(p.y))
    + .12 * cos(2. * p.y + .7 * sin(2. * p.x)) + .05 * sin(3. * p.x - 2. * p.y)) * 255.;
  gl_FragColor = vec4(floor(k) / 255., fract(k), 0., 1.);
}`;

// The tank's outline, worked out once a layout: how far each point of the page lies from the
// liquid's edge, in CSS px (negative inside). The hero's body, the river's pieces, the necks and the
// shapes are each a distance to their own edge, melted together where they meet (a smooth minimum),
// so the river pours into a ring and out of it, and out of the hero, rather than stopping at an edge.
const BAKE = `${PRECISION}
uniform vec4 area;    // the tank, in field units: its bottom left (.xy) and its size (.zw)
uniform vec2 fr;      // the target, in texels
uniform vec2 css;     // a CSS px in field units (.x), and how far apart two parts start to melt together (.y)
uniform vec4 hero;    // the hero's body: its middle (.xy) and half size (.zw)
uniform vec2 corner;  // how round its corners are (.x), and how far its edge wavers in (.y)
uniform vec4 seg[${2 * MAX_SEGMENTS}]; // each piece of river or neck: its two ends, x, y and half width,
                                    // and its kind (.w of the first: 0 river, 1 neck)
uniform float segs;                 // how many are set
uniform vec4 box[${MAX_SHAPES}];    // each shape's centre (.xy), and its half size or a ring's radius (.zw)
uniform vec4 look[${MAX_SHAPES}];   // its kind (1 pool, 2 ring, 3 type), a ring's half band or how far
                                    // the letters' distance reaches (.y), how much a pool's edge wobbles
                                    // or where the letters' distance steps grow coarse (.z), and for
                                    // the letters, log(1 + .y / .z) (.w)
uniform float shapes;               // how many are set
uniform sampler2D glyphs;           // the letters' distance field (encodeDistance): .5 on their edge, more inside
const float PI = 3.1415927;
${NOISE}
float sdBox(vec2 o, vec2 h, float k) {
  vec2 d = abs(o) - h + k;
  return length(max(d, 0.)) + min(max(d.x, d.y), 0.) - k;
}
float smin(float a, float b, float k) {
  float h = clamp(.5 + .5 * (b - a) / k, 0., 1.);
  return mix(b, a, h) - k * h * (1. - h);
}
// The letters' distance at o from the middle of their box b (look l), decoded (decodeDistance).
float letters(vec2 o, vec4 b, vec4 l) {
  float e = 1. - 2. * texture2D(glyphs, o / (2. * b.zw) + .5).a;
  return sign(e) * l.z * (exp(abs(e) * l.w) - 1.);
}
void main() {
  vec2 f = area.xy + gl_FragCoord.xy / fr * area.zw;
  float k = css.y;
  float far = css.x * ${RANGE.toFixed(1)} + k;
  // The hero's body, its edge wavering in and out. The river leaves it through a wide funnel: near
  // the body, the pieces melt into it further than anywhere else.
  float body = sdBox(f - hero.xy, hero.zw, corner.x);
  if (body < .3) body += (noise(f * 1.4 + 7.3) * .8 + noise(f * 4.1 + 2.9) * .2) * corner.y;
  float D = body;
  for (int i = 0; i < ${MAX_SEGMENTS}; i++) {
    if (float(i) >= segs) break;
    vec4 a = seg[2 * i];
    vec4 b = seg[2 * i + 1];
    float wide = max(a.z, b.z) * 1.3 + far;
    if (f.y > max(a.y, b.y) + wide || f.y < min(a.y, b.y) - wide || f.x > max(a.x, b.x) + wide || f.x < min(a.x, b.x) - wide) continue;
    float d;
    if (a.w < .5) {
      // The river between two anchors: the S it bends in (curveAt in field-model.js), beaded at
      // each, meandering a little and swelling here and there, rounded off where it ends.
      float span = max(a.y - b.y, 1e-4);
      float u = clamp((a.y - f.y) / span, 0., 1.);
      float e = u * u * (3. - 2. * u);
      float bead = sin(PI * u);
      float w = mix(a.z, b.z, e) * (1. - ${PINCH} * bead);
      float x = mix(a.x, b.x, e);
      float slope = (b.x - a.x) * 6. * u * (1. - u) / span;
      float across = (f.x - x) / sqrt(1. + slope * slope);
      float wave = noise(vec2(f.y * 6., 3.7)) - .5;
      across -= bead * w * .24 * wave;
      w *= 1. - bead * .2 * wave;
      d = f.y <= a.y && f.y >= b.y ? abs(across) - w : 1e3;
      d = min(d, min(length(f - a.xy) - a.z, length(f - b.xy) - b.z));
    } else {
      // A neck from one shape to another, narrowing in its middle.
      vec2 ba = b.xy - a.xy;
      float len = max(length(ba), 1e-4);
      float h = clamp(dot(f - a.xy, ba / len) / len, 0., 1.);
      d = length(f - a.xy - ba * h) - mix(a.z, b.z, h) * (1. - ${WAIST} * sin(PI * h));
    }
    D = smin(D, d, k * (1. + 2. * exp(-max(body, 0.) * 10.)));
  }
  for (int i = 0; i < ${MAX_SHAPES}; i++) {
    if (float(i) >= shapes) break;
    vec4 b = box[i];
    vec4 l = look[i];
    vec2 o = f - b.xy;
    vec2 extent = l.x > 1.5 && l.x < 2.5 ? vec2(b.z + l.y) : b.zw;
    float reach = l.x > 2.5 ? 0. : far + l.z;
    if (abs(o.x) > extent.x + reach || abs(o.y) > extent.y + reach) continue;
    float d;
    if (l.x < 1.5) {
      // The pool the river ends in, its edge wobbling.
      d = sdBox(o, b.zw, min(b.z, b.w));
      if (d < l.z + k) d += (noise(o * 4. + 1.7) - .5) * l.z;
    } else if (l.x < 2.5) {
      // A ring.
      d = abs(length(o) - b.z) - l.y;
      if (d < l.y + k) d += (noise(o * 9. + 4.7) - .5) * l.y * .35;
    } else {
      // Letters.
      d = abs(o.x) < b.z && abs(o.y) < b.w ? letters(o, b, l) : l.y;
    }
    D = smin(D, d, k);
  }
  float e = clamp(.5 + D / (css.x * ${(2 * RANGE).toFixed(1)}), 0., 1.) * 255.;
  gl_FragColor = vec4(floor(e) / 255., fract(e), 0., 1.);
}`;

// The waves are a shallow sheet of liquid on a floating-point grid over the page: how much
// deeper it stands in each cell than at rest (.x: kept as a difference, small and exact at rest, so
// half floats hold it finely and lose none of the liquid as it is worked on), its speed across the
// cell's right face (.y) and top face (.z), in cells a second, and the level of its surface (.w),
// carried on past its shore for drawing. It lies
// in a basin the shape of its outline: at its full depth a bank's width inside the edge, and outside
// it a bank that rises as steeply, so where it is pushed the liquid runs up out of its outline and
// slides back, the way a puddle's edge moves, rather than stopping at a wall. Each step is three
// passes: the speeds, pushed by differences in level, by the page's acceleration, by the brush and by
// a press, and held back by the bed where the liquid is thin; an outflow budget; then the depths, raised or lowered by
// what flows in and out, carried across a face only by the liquid that stands above it.
const BED = `
uniform sampler2D sdf;
${DISTANCE}
// The bed under a point, in the liquid's full depth: 1 down a bank's width inside the edge, level
// with the liquid's surface at the edge, and rising beyond it.
float bed(vec2 at) { return clamp(dist(sdf, at) / ${BANK.toFixed(1)}, -1., 3.); }
// How deep the liquid stands on a bed b, given how much deeper than at rest (h).
float deep(float b, float h) { return max(h - min(b, 0.), 0.); }
// A shared face carries the upstream depth above the higher bed.
float flux(float u, float a, float ba, float b, float bb) {
  return u * max((u > 0. ? ba + a : bb + b) - max(ba, bb), 0.);
}`;

const PUSH = `${PRECISION}
uniform sampler2D waves;
uniform vec2 fr;      // the grid, in cells
uniform float dt;     // seconds this step
uniform vec2 rows;    // the rows worked on, from the first to past the last: the liquid beyond is
                      // left as it was, so their edges are walls
uniform float pull;   // how hard a difference in level pushes: the waves' speed where deepest² (cells a second)², times dt
uniform float keep;   // how much of its speed the liquid keeps this step
uniform vec2 force;   // what the page's acceleration does to the liquid, cells a second², y up
uniform vec4 seg;     // the brush's move, from .xy to .zw, in cells
uniform vec2 drag;    // the brush's velocity, cells a second
uniform float paint;  // how hard it drags this step: 0 at rest
uniform float reach;  // how far round it it drags, in cells
uniform vec3 press;   // a press: where, in cells (.xy), and how fast it pushes the liquid out (.z, cells a second)
uniform float spread; // how wide a press is, in cells
${BED}
float near(vec2 q) {
  vec2 ab = seg.zw - seg.xy;
  vec2 d = q - (seg.xy + ab * clamp(dot(q - seg.xy, ab) / max(dot(ab, ab), 1e-6), 0., 1.));
  return paint * exp(-dot(d, d) / (reach * reach));
}
// The speed across the face from a cell (depth a, on bed ba) to the next (depth b, on bed bb), from
// what it was (u) and the force along it (f), and whether any liquid stands over the face (.y): none
// does where both sides' levels are below the higher of the two beds, and there it is still.
vec2 face(float u, float a, float ba, float b, float bb, float f) {
  float sill = max(ba, bb);
  float la = ba + a;
  float lb = bb + b;
  float over = max(la, lb) - sill;
  if (over <= ${WET}) return vec2(0.);
  // A side whose level is below the sill pushes on the face only as high as the sill: liquid
  // at rest against its bank stays put, and liquid higher than the bank runs up onto it.
  u = (u + f * dt - pull * (max(lb, sill) - max(la, sill))) * keep;
  // Thin liquid drags on its bed.
  u /= 1. + dt * ${FRICTION.toFixed(2)} / (over + .02);
  return vec2(clamp(u, -${FASTEST.toFixed(1)}, ${FASTEST.toFixed(1)}), 1.);
}
// What the brush and a press do to the speed u across a wet face at q, along x or y (along): the
// brush pulls it toward its own speed (to), and a press pushes it away from where it pressed.
float stir(float u, vec2 q, float to, vec2 along) {
  vec2 o = q - press.xy;
  return mix(u, to, near(q)) + press.z * dot(o, along) / spread * exp(-dot(o, o) / (spread * spread));
}
void main() {
  vec2 st = gl_FragCoord.xy / fr;
  vec2 e = 1. / fr;
  vec4 c = texture2D(waves, st);
  float bc = bed(st);
  float br = bed(st + vec2(e.x, 0.));
  float bu = bed(st + vec2(0., e.y));
  float dc = deep(bc, c.x);
  vec2 u = st.x + e.x < 1. ? face(c.y, dc, bc, deep(br, texture2D(waves, st + vec2(e.x, 0.)).x), br, force.x) : vec2(0.);
  vec2 v = gl_FragCoord.y + 1. < rows.y ? face(c.z, dc, bc, deep(bu, texture2D(waves, st + vec2(0., e.y)).x), bu, force.y) : vec2(0.);
  // The brush drags the liquid it passes through along with it; a press pushes it out all round.
  if (u.y > .5) u.x = stir(u.x, gl_FragCoord.xy + vec2(.5, 0.), drag.x, vec2(1., 0.));
  if (v.y > .5) v.x = stir(v.x, gl_FragCoord.xy + vec2(0., .5), drag.y, vec2(0., 1.));
  gl_FragColor = vec4(c.x, clamp(u.x, -${FASTEST.toFixed(1)}, ${FASTEST.toFixed(1)}), clamp(v.x, -${FASTEST.toFixed(1)}, ${FASTEST.toFixed(1)}), c.w);
}`;

// Limit each donor's total outflow to its available water. Every shared face uses the same
// donor scale in RISE, so keeping cells wet never invents water at a bank after a strong tap.
const LIMIT = `${PRECISION}
uniform sampler2D waves;
uniform vec2 fr;
uniform float dt;
uniform vec2 rows;
${BED}
void main() {
  vec2 st = gl_FragCoord.xy / fr;
  vec2 e = 1. / fr;
  vec4 c = texture2D(waves, st);
  vec4 l = texture2D(waves, st - vec2(e.x, 0.));
  vec4 r = texture2D(waves, st + vec2(e.x, 0.));
  vec4 d = texture2D(waves, st - vec2(0., e.y));
  vec4 u = texture2D(waves, st + vec2(0., e.y));
  float bc = bed(st), bl = bed(st - vec2(e.x, 0.)), br = bed(st + vec2(e.x, 0.));
  float bd = bed(st - vec2(0., e.y)), bu = bed(st + vec2(0., e.y));
  float dc = deep(bc, c.x);
  float outflow = max(flux(c.y, dc, bc, deep(br, r.x), br), 0.)
    + max(flux(c.z, dc, bc, deep(bu, u.x), bu), 0.)
    + (st.x > e.x ? max(-flux(l.y, deep(bl, l.x), bl, dc, bc), 0.) : 0.)
    + (gl_FragCoord.y - 1. > rows.x ? max(-flux(d.z, deep(bd, d.x), bd, dc, bc), 0.) : 0.);
  float scale = min(1., dc / max(dt * outflow, 1e-8));
  gl_FragColor = vec4(c.xyz, scale);
}`;

const RISE = `${PRECISION}
uniform sampler2D waves;
uniform vec2 fr;      // the grid, in cells
uniform float dt;     // seconds this step
uniform vec2 rows;    // the rows worked on, from the first to past the last: the liquid beyond is
                      // left as it was, so their edges are walls
${BED}
void main() {
  vec2 st = gl_FragCoord.xy / fr;
  vec2 e = 1. / fr;
  vec4 c = texture2D(waves, st);
  vec4 left = texture2D(waves, st - vec2(e.x, 0.));
  vec4 right = texture2D(waves, st + vec2(e.x, 0.));
  vec4 down = texture2D(waves, st - vec2(0., e.y));
  vec4 up = texture2D(waves, st + vec2(0., e.y));
  float bc = bed(st);
  float bl = bed(st - vec2(e.x, 0.));
  float br = bed(st + vec2(e.x, 0.));
  float bd = bed(st - vec2(0., e.y));
  float bu = bed(st + vec2(0., e.y));
  float dc = deep(bc, c.x);
  float leaving = flux(c.y, dc, bc, deep(br, right.x), br) * (c.y > 0. ? c.w : right.w)
    + flux(c.z, dc, bc, deep(bu, up.x), bu) * (c.z > 0. ? c.w : up.w);
  float coming = (st.x > e.x ? flux(left.y, deep(bl, left.x), bl, dc, bc) * (left.y > 0. ? left.w : c.w) : 0.)
    + (gl_FragCoord.y - 1. > rows.x ? flux(down.z, deep(bd, down.x), bd, dc, bc) * (down.z > 0. ? down.w : c.w) : 0.);
  // The change in depth, kept as the change from rest: never below dry.
  float rest = max(-bc, 0.);
  float h = max(c.x - dt * (leaving - coming), -rest);
  // Where the cell is dry, the level of the liquid around it, carried on past the shore, so the edge
  // is drawn where the surface meets the bank.
  vec4 depths = vec4(deep(bl, left.x), deep(br, right.x), deep(bd, down.x), deep(bu, up.x));
  vec4 wet = step(vec4(${WET}), depths);
  float neighbour = dot((vec4(bl, br, bd, bu) + depths), wet) / max(dot(wet, vec4(1.)), 1.);
  float level = rest + h > ${WET} ? bc + rest + h : neighbour;
  gl_FragColor = vec4(h, c.y, c.z, level);
}`;

// The palette follows the tokens in site.css: LIME is --accent. The canvas is drawn with
// premultiplied alpha over the page, so where there is no liquid the page shows through.
//
// A pixel of liquid: its marbling, carried along by the flow (two phases of it, each carried for a
// while and then started afresh as the other takes over, so it never stretches out of shape) and by
// the waves, and bent by their slope; a darker rim; light from the upper left on the slope inside
// its edge and on the waves; and a faint glow outside it.
const INK = `${PRECISION}
uniform vec3 view;    // a device pixel in field units (.x), and the field point at the canvas's bottom left (.yz)
uniform vec4 tank;    // the tank: its bottom left (.xy) in field units, and 1 over its size (.zw)
uniform vec4 steps;   // a texel of its distance field (.xy) and a cell of its waves (.zw), in the tank's 0 to 1
uniform vec4 px;      // a CSS px in field units (.x), a device px in CSS px (.y), a texel of the distance
                      // field and a cell of the waves in CSS px (.zw)
uniform sampler2D sdf;
uniform sampler2D flow;    // the flow, encodeFlow
uniform sampler2D waves;
uniform sampler2D marble;
uniform float stirred;     // 1 while the waves are worked on
uniform float t;           // seconds
const vec3 DEEP = vec3(.025, .042, .012);
const vec3 OLIVE = vec3(.16, .22, .055);
const vec3 LIME = vec3(.808, 1., .196);
${DISTANCE}
float hash(vec2 v) { return fract(sin(dot(v, vec2(127.1, 311.7))) * 43758.5453); }
// Broad folds, rather than ink contour lines. The material is lit as one continuous surface.
float height(vec2 m, vec2 drift, float a, float b, float wa) {
  vec4 A = texture2D(marble, m - drift * a);
  vec4 B = texture2D(marble, m - drift * b);
  float k = mix(B.x + B.y / 255., A.x + A.y / 255., wa);
  return k;
}
void main() {
  vec2 f = gl_FragCoord.xy * view.x + view.yz;
  vec2 at = (f - tank.xy) * tank.zw;
  float D = dist(sdf, at);
  if (D > ${GLOW.toFixed(1)}) { gl_FragColor = vec4(0.); return; }

  // The waves here: the liquid's speed and the level of its surface, and the surface's slope, per cell.
  vec4 w = vec4(0.);
  vec2 rise = vec2(0.);
  if (stirred > .5) {
    w = texture2D(waves, at);
    // The level a cell and a half either way: its slope, and with it a surface smoothed over a
    // few cells.
    float right = texture2D(waves, at + vec2(steps.z, 0.) * 1.5).w;
    float left = texture2D(waves, at - vec2(steps.z, 0.) * 1.5).w;
    float up = texture2D(waves, at + vec2(0., steps.w) * 1.5).w;
    float down = texture2D(waves, at - vec2(0., steps.w) * 1.5).w;
    rise = vec2(right - left, up - down) / 3.;
    // The edge lies where the surface meets the bank: further out where the liquid has run up it,
    // further in where it has drained back.
    D -= (2. * w.w + right + left + up + down) / 6. * ${BANK.toFixed(1)};
  }

  // Its marbling, from where the flow and the waves carried it.
  vec2 run = (texture2D(flow, at).xy - .5) * ${(2 * FLOW_MAX).toFixed(1)};
  vec2 m = (f / px.x - w.yz * px.w * ${SEEN.toFixed(3)} - rise * ${BEND.toFixed(1)}) / ${TILE.toFixed(2)};
  vec2 drift = run / ${TILE.toFixed(2)} * ${PERIOD.toFixed(1)};
  float a = fract(t / ${PERIOD.toFixed(1)});
  float b = fract(a + .5);
  float wa = 1. - abs(2. * a - 1.);
  float H = height(m, drift, a, b, wa);
  vec2 e = vec2(.004, 0.);
  vec2 folds = vec2(height(m + e.xy, drift, a, b, wa) - height(m - e.xy, drift, a, b, wa),
    height(m + e.yx, drift, a, b, wa) - height(m - e.yx, drift, a, b, wa)) / .008;

  // A rounded surface: darker at its rim, lit from the upper left on the slope inside its edge and
  // on the waves, and shaded on the slopes away from the light.
  vec2 g = vec2(dist(sdf, at + vec2(steps.x, 0.)) - dist(sdf, at - vec2(steps.x, 0.)), dist(sdf, at + vec2(0., steps.y)) - dist(sdf, at - vec2(0., steps.y))) / (2. * px.z);
  vec3 normal = normalize(vec3(-folds * 1.2 + g * exp(-max(-D, 0.) / 8.) * 1.5 - rise * ${WAVE.toFixed(2)}, 1.));
  vec3 reflection = reflect(vec3(0., 0., -1.), normal);
  // Two long studio lights: a warm silver reflection and a lime fill, both on the same normals.
  float silver = exp(-pow((reflection.x + .4) / .15, 2.) - pow((reflection.y - .35) / .9, 2.));
  float lime = exp(-pow((reflection.x - .45) / .42, 2.) - pow((reflection.y + .45) / .8, 2.));
  float fresnel = pow(1. - normal.z, 3.);
  float diffuse = max(dot(normal, normalize(vec3(-.4, .6, 1.))), 0.);
  vec3 col = DEEP + OLIVE * (.25 + .25 * H + diffuse * .3);
  col += LIME * (lime * .68 + fresnel * .22);
  col += vec3(.88, .96, .72) * silver * .82;
  col *= .72 + .28 * smoothstep(0., 5., -D);

  // Back to front, premultiplied: a faint glow round the liquid, the liquid.
  float edge = px.y * .75;
  float body = 1. - smoothstep(-edge, edge, D);
  float glow = exp(-max(D, 0.) / 10.) * .18 * (1. - body);
  vec3 rgb = OLIVE * .5 * glow + (col + (hash(gl_FragCoord.xy) - .5) * .006) * body;
  float alpha = glow + body;
  gl_FragColor = vec4(clamp(rgb, 0., alpha), alpha);
}`;

const VERTEX = "attribute vec2 a; void main() { gl_Position = vec4(a, 0., 1.); }";

const root = document.documentElement;
const hero = document.querySelector(".hero");
const copy = hero.querySelector(".hero-copy");
const phone = hero.querySelector(".phone");
const canvas = document.querySelector("#field");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader");
  return shader;
}

/** A program over the full-screen quad, with every uniform its fragment shader names. */
function link(gl, fragment) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.bindAttribLocation(program, 0, "a");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link");
  const names = [...fragment.matchAll(/uniform \w+ (\w+)/g)].map((m) => m[1]);
  return { program, u: Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)])) };
}

/** A texture for smooth sampling: no mipmaps, clamped (or repeating), so any size will do. */
function texture(gl, wrap = gl.CLAMP_TO_EDGE) {
  const made = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, made);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  return made;
}

/** A texture to draw into, or null where this GPU can't render to that format. */
function target(gl, width, height, type, wrap) {
  const made = texture(gl, wrap);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, type, null);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, made, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (ok) return { texture: made, framebuffer };
  free(gl, { texture: made, framebuffer });
  return null;
}

function free(gl, made) {
  if (!made) return;
  gl.deleteTexture(made.texture);
  gl.deleteFramebuffer(made.framebuffer);
}

/** Prefer full floats to avoid cumulative depth rounding under repeated input. Half floats
 * remain a smaller fallback; if neither can render and filter, the material still draws. */
function waveFormat(gl) {
  const floats = gl.getExtension("OES_texture_float");
  const floatLinear = gl.getExtension("OES_texture_float_linear");
  gl.getExtension("WEBGL_color_buffer_float");
  if (floats && floatLinear) {
    const probe = target(gl, 4, 4, gl.FLOAT);
    free(gl, probe);
    if (probe) return gl.FLOAT;
  }
  const half = gl.getExtension("OES_texture_half_float");
  const linear = gl.getExtension("OES_texture_half_float_linear");
  gl.getExtension("EXT_color_buffer_half_float");
  if (!half || !linear) return null;
  const probe = target(gl, 4, 4, half.HALF_FLOAT_OES);
  free(gl, probe);
  return probe ? half.HALF_FLOAT_OES : null;
}

/** Draws the full-screen quad with `program` into `into` (a target, or the canvas when null), `width` by `height`. */
function run(gl, into, width, height) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, into?.framebuffer ?? null);
  gl.viewport(0, 0, width, height);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

/** The marbling's tile, worked out once. */
function marbling(gl) {
  const { program, u } = link(gl, MARBLE);
  const tile = target(gl, MARBLE_SIZE, MARBLE_SIZE, gl.UNSIGNED_BYTE, gl.REPEAT);
  if (!tile) throw new Error("marble");
  gl.useProgram(program);
  gl.uniform1f(u.size, MARBLE_SIZE);
  run(gl, tile, MARBLE_SIZE, MARBLE_SIZE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(tile.framebuffer);
  gl.deleteProgram(program);
  return tile.texture;
}

/** Every program, the quad, the marbling and empty glyphs and flow, or null where WebGL can't. The tank comes with the layout. */
function start() {
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
  if (!gl || gl.isContextLost()) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const glyphs = texture(gl);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  const flow = texture(gl);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 0, 255]));
  return {
    gl,
    ink: link(gl, INK),
    bake: link(gl, BAKE),
    push: link(gl, PUSH),
    limit: link(gl, LIMIT),
    rise: link(gl, RISE),
    marble: marbling(gl),
    format: waveFormat(gl),
    glyphs,
    glyphsFor: "",
    glyphGrid: null,
    flow,
    tank: null,
  };
}

const brush = new Brush();
const slosh = new Slosh();
const segmentData = new Float32Array(MAX_SEGMENTS * 8);
const boxData = new Float32Array(MAX_SHAPES * 4);
const lookData = new Float32Array(MAX_SHAPES * 4);
let field = null;
/**
 * The page in CSS pixels: the screen's width, the canvas's height, the screen's height, the page's
 * own height (`room`), the hero's height (one field unit) and top.
 */
let page = null;
/** Where the canvas is on the page: its top, in CSS pixels. */
let placed = 0;
let layout = null;
/** The hero's body of liquid (heroBody). */
let body = null;
let segments = [];
let shapes = [];
let quality = 1;
let paused = reduceMotion.matches;
let dirty = true;
let drawnAt = null;
let stirredAt = -Infinity;
/** The flow waits for the layout to settle and the page to be idle: its timer and its idle callback. */
let pouring = 0;
let pourIdle = 0;
let time = 0;
let frame = 0;
let lastFrame = 0;
let lastDraw = 0;
let skipped = 0;
let period = STIRRING_MS;
let frameMs = STIRRING_MS;
let slowFrames = 0;
let fastFrames = 0;

try {
  field = start();
} catch (error) {
  console.error(error);
}

/** The text's extent, not its box: a heading's box spans the column however short its lines. */
function extent(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  return range.getBoundingClientRect();
}

/** A length in pixels the page set on an element as a custom property; 0 when it set none. */
function px(style, name) {
  return parseFloat(style.getPropertyValue(name)) || 0;
}

/**
 * The hero's [data-floor] marks: those this layout makes the liquid's floor (--floor: 1), and the
 * rest, which stand beside it with the copy.
 */
function floors() {
  const marks = [...hero.querySelectorAll("[data-floor]")].filter((el) => el.getClientRects().length);
  const isFloor = (el) => getComputedStyle(el).getPropertyValue("--floor").trim() !== "0";
  return { under: marks.filter(isFloor), beside: marks.filter((el) => !isFloor(el)) };
}

/**
 * Reads the layout the CSS chose: where the hero's copy ended up and which way its ink goes (--art),
 * then every ink shape and river mark on the page, in field units, and the river's course through
 * them; then sizes the canvas and works out the tank.
 */
function measure() {
  const box = hero.getBoundingClientRect();
  const screen = canvas.getBoundingClientRect();
  if (!box.width || !box.height || !screen.width) return;
  const scroll = scrollY;
  page = { width: screen.width, height: screen.height, screen: innerHeight, room: canvas.parentElement.clientHeight, unit: box.height, top: box.top + scroll };
  const { under, beside } = floors();
  const parts = [
    extent(copy.querySelector("h1")),
    extent(copy.querySelector(".intro")),
    ...[...copy.querySelectorAll(".pill")].map((el) => el.getBoundingClientRect()),
    ...beside.map((el) => el.getBoundingClientRect()),
  ];
  const right = Math.max(...parts.map((part) => part.right)) - box.left;
  const art = getComputedStyle(hero).getPropertyValue("--art").trim();
  // Under the copy the liquid starts a little above the phone (heroBody starts it 5% of the hero
  // below the copy's foot), so the phone lies in it rather than on its edge.
  let bottom = copy.getBoundingClientRect().bottom - box.top;
  if (art === "below" && phone) bottom = Math.max(bottom, phone.getBoundingClientRect().top - box.top - ABOVE_PHONE - 0.05 * box.height);
  layout = layoutFor(art, box.width, box.height, { right, bottom });
  const floor = Math.min(box.height, ...under.map((el) => el.getBoundingClientRect().top - box.top));
  body = heroBody(layout, box.width, box.height, floor - FLOOR_GAP);
  const unit = page.unit;
  const centreOf = (rect) => pageToField(rect.left + rect.width / 2, rect.top + scroll + rect.height / 2, page);
  const reach = (MELT + RANGE) / unit;

  // The shapes the river runs into: rings, the letters of the price, the pool it ends in.
  shapes = [...document.querySelectorAll("[data-ink]")].flatMap((el) => {
    const kind = KINDS[el.dataset.ink];
    const rect = el.getBoundingClientRect();
    if (!kind || !rect.width || !rect.height) return [];
    const style = getComputedStyle(el);
    const [x, y] = centreOf(rect);
    const hx = rect.width / 2 / unit;
    const hy = rect.height / 2 / unit;
    if (kind === KINDS.ring) {
      const band = px(style, "--ring") / unit;
      return [{ el, kind, x, y, hx, hy, soft: reach, radius: hx - band, band, box: [x, y, hx - band, 0], look: [kind, band, 0, 0] }];
    }
    if (kind === KINDS.type) {
      // The letters' distance field reaches RANGE past their box, so the box grows by as much.
      const pad = RANGE / unit;
      const knee = DISTANCE_KNEE / glyphDensity() / unit;
      return [{ el, kind, x, y, hx: hx + pad, hy: hy + pad, soft: reach, box: [x, y, hx + pad, hy + pad], look: [kind, pad, knee, Math.log1p(pad / knee)] }];
    }
    const wobble = px(style, "--wobble") / unit;
    return [{ el, kind, x, y, hx, hy, soft: reach + wobble, box: [x, y, hx, hy], look: [kind, 0, wobble, 0] }];
  });
  letter();

  // The river's marks, top first: the ink's middle, the hero's foot (straight under the ink, unless
  // the page marked the foot itself, as a narrow screen's lane does), then every mark below.
  const marks = [...document.querySelectorAll("[data-river]")].flatMap((el) => {
    const width = px(getComputedStyle(el), "--river");
    const rect = el.getBoundingClientRect();
    if (width <= 0 || (!rect.width && !rect.height)) return [];
    const [x, y] = centreOf(rect);
    return [{ x, y, half: width / 2 / unit, foot: hero.contains(el), shape: shapes.find((s) => s.el === el) }];
  });
  // The river starts inside the hero's body, never wider than the body is deep there.
  const inside = Math.min(body.y + body.hy - layout.centre[1], layout.centre[1] - (body.y - body.hy));
  marks.push({ x: layout.centre[0], y: layout.centre[1], half: Math.max(AT_FOOT, Math.min(OUT_OF_INK, 0.8 * inside)) });
  if (!marks.some((mark) => mark.foot)) marks.push({ x: layout.centre[0], y: -0.5, half: AT_FOOT });
  marks.sort((a, b) => b.y - a.y);
  // A ring or letters the river runs through take it in on the side it comes from and let it out
  // on the side it goes on to; in between, the shape carries the liquid. It ends in the pool.
  const anchors = marks.flatMap((mark, i) => {
    const shape = mark.shape;
    if (!shape || shape.kind === KINDS.pool) return [mark];
    const into = meet(shape, marks[i - 1] ?? mark);
    const out = meet(shape, marks[i + 1] ?? mark);
    return [{ ...into, half: mark.half, into: shape }, { ...out, half: mark.half, outOf: shape }];
  });
  const river = riverSegments(anchors);
  // Rings close together are joined by necks, and a ring the river runs past gets one from it.
  const rings = shapes.filter((shape) => shape.kind === KINDS.ring);
  const through = new Set(marks.map((mark) => mark.shape));
  const span = Math.max(0, ...rings.map((ring) => ring.radius));
  segments = [...river, ...necks(rings, span * 2.5), ...landings(river, rings.filter((ring) => !through.has(ring)), (2 * MELT) / unit)];
  resize();
  bake();
}

/** Pixels of the letters' distance field per CSS pixel: as sharp as the screen, up to 1.5. */
function glyphDensity() {
  return Math.min(devicePixelRatio, 1.5);
}

/**
 * Where the river meets a shape on its way from or to `toward`: on a ring's band facing it, or in
 * the letters at their nearest point to it.
 */
function meet(shape, toward) {
  if (shape.kind === KINDS.ring) return port(shape, toward.x, toward.y);
  const grid = field?.glyphGrid;
  const left = shape.x - shape.hx;
  const top = shape.y + shape.hy;
  const scale = page.unit * (grid?.density ?? 1);
  const at = grid && nearestInside(grid.sd, grid.width, grid.height, (toward.x - left) * scale, (top - toward.y) * scale, 10 * grid.density);
  return at ? { x: left + at.x / scale, y: top - at.y / scale } : { x: shape.x, y: shape.y };
}

/**
 * Sets the letters a type shape's ink fills, in the element's own font, size and spacing, centred in
 * its box, as a distance field, so the river can melt into them. The page's text stays where it is
 * for reading and selecting; the ink draws the letters.
 */
function letter() {
  const shape = shapes.find((s) => s.kind === KINDS.type);
  if (!field || !shape) return;
  const style = getComputedStyle(shape.el);
  const density = glyphDensity();
  const width = Math.round(shape.hx * 2 * page.unit * density);
  const height = Math.round(shape.hy * 2 * page.unit * density);
  const text = shape.el.textContent.trim();
  const font = `${style.fontWeight} ${parseFloat(style.fontSize) * density}px ${style.fontFamily}`;
  const key = [width, height, text, font, style.letterSpacing].join("|");
  if (key === field.glyphsFor || !width || !height) return;
  const sheet = document.createElement("canvas");
  sheet.width = width;
  sheet.height = height;
  const pen = sheet.getContext("2d", { willReadFrequently: true });
  pen.font = font;
  if ("letterSpacing" in pen && style.letterSpacing !== "normal") pen.letterSpacing = `${parseFloat(style.letterSpacing) * density}px`;
  pen.textAlign = "center";
  pen.fillStyle = "#fff";
  const m = pen.measureText(text);
  pen.fillText(text, (width + m.actualBoundingBoxLeft - m.actualBoundingBoxRight) / 2, (height + m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
  const rgba = pen.getImageData(0, 0, width, height).data;
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3] ?? 0;
  const sd = glyphDistance(alpha, width, height);
  const { gl } = field;
  gl.bindTexture(gl.TEXTURE_2D, field.glyphs);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, width, height, 0, gl.ALPHA, gl.UNSIGNED_BYTE, encodeDistance(sd, width, height, RANGE * density));
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  field.glyphsFor = key;
  field.glyphGrid = { sd, width, height, density };
}

function resize() {
  if (!field || !page) return;
  // As sharp as the screen's budget allows, over the whole of the canvas.
  const [width, height] = canvasSize(page.width, page.height, devicePixelRatio, quality);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  dirty = true;
  kick();
}

/** The tank's rect over the page, in field units: its left, its bottom, its width and its height. */
function tankArea() {
  const { grid } = field.tank;
  return [-page.width / 2 / page.unit, (page.top + page.unit / 2 - grid.height) / page.unit, grid.width / page.unit, grid.height / page.unit];
}

/** The tank's textures for its grid: its distance field, a coarse copy of it to read back, and the waves (two, to step from one into the other). */
function tankFor(grid) {
  const { gl } = field;
  const old = field.tank;
  if (old && old.grid.cols === grid.cols && old.grid.rows === grid.rows && old.grid.texel === grid.texel) {
    old.grid = grid;
    return;
  }
  for (const made of [old?.sdf, old?.coarse, ...(old?.waves ?? [])]) free(gl, made);
  let waves = field.format ? [target(gl, grid.cols * 2, grid.rows * 2, field.format), target(gl, grid.cols * 2, grid.rows * 2, field.format)] : null;
  if (waves && (!waves[0] || !waves[1])) {
    for (const made of waves) free(gl, made);
    waves = null;
  }
  field.tank = {
    grid,
    sdf: target(gl, grid.cols * 4, grid.rows * 4, gl.UNSIGNED_BYTE),
    coarse: target(gl, grid.cols, grid.rows, gl.UNSIGNED_BYTE),
    waves,
    read: 0,
    live: false,
    wet: null,
  };
}

/** Works out the tank for this layout: its outline now, its waves at rest in it, and its flow once the layout has stopped changing. */
function bake() {
  if (!field || !page || !layout) return;
  const { gl } = field;
  tankFor(tankGrid(page.width, page.room, gl.getParameter(gl.MAX_TEXTURE_SIZE)));
  const { tank } = field;
  if (!tank.sdf) return;
  outline(tank.sdf, tank.grid.cols * 4, tank.grid.rows * 4);
  settle();
  waitToPour(tank.wet ? 150 : 0);
  dirty = true;
  kick();
}

/**
 * Works out the flow `ms` after the last change of layout, once the page is idle, so it never holds
 * up a frame; or, with no `ms`, not at all.
 */
function waitToPour(ms) {
  clearTimeout(pouring);
  if (pourIdle) cancelIdleCallback(pourIdle);
  pourIdle = 0;
  if (ms === undefined) return;
  pouring = setTimeout(() => {
    if ("requestIdleCallback" in window) pourIdle = requestIdleCallback(pour, { timeout: 600 });
    else pour();
  }, ms);
}

/** Draws the tank's distance field into `into`, `width` by `height` texels, a band of the page at a time with only the pieces and shapes that reach it. */
function outline(into, width, height) {
  const { gl, bake: { program, u } } = field;
  const unit = page.unit;
  const [left, bottom, wide, high] = tankArea();
  gl.useProgram(program);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, field.glyphs);
  gl.uniform1i(u.glyphs, 1);
  gl.uniform4f(u.area, left, bottom, wide, high);
  gl.uniform2f(u.fr, width, height);
  gl.uniform2f(u.css, 1 / unit, MELT / unit);
  gl.uniform4f(u.hero, body.x, body.y, body.hx, body.hy);
  gl.uniform2f(u.corner, body.round, body.wobble);
  gl.bindFramebuffer(gl.FRAMEBUFFER, into.framebuffer);
  gl.viewport(0, 0, width, height);
  gl.enable(gl.SCISSOR_TEST);
  const bands = Math.max(1, Math.ceil(high));
  const reach = (MELT + RANGE) / unit;
  for (let i = 0; i < bands; i++) {
    const from = Math.floor((height * i) / bands);
    const to = Math.floor((height * (i + 1)) / bands);
    const top = bottom + (to / height) * high;
    const low = bottom + (from / height) * high;
    const pieces = segmentsIn(segments, top, low, reach);
    const inks = shapesIn(shapes, top, low);
    segmentData.fill(0);
    pieces.forEach((s, j) => {
      segmentData.set([s.a.x, s.a.y, s.a.half, s.kind], j * 8);
      segmentData.set([s.b.x, s.b.y, s.b.half, 0], j * 8 + 4);
    });
    boxData.fill(0);
    lookData.fill(0);
    inks.forEach((shape, j) => {
      boxData.set(shape.box, j * 4);
      lookData.set(shape.look, j * 4);
    });
    gl.uniform4fv(u.seg, segmentData);
    gl.uniform1f(u.segs, pieces.length);
    gl.uniform4fv(u.box, boxData);
    gl.uniform4fv(u.look, lookData);
    gl.uniform1f(u.shapes, inks.length);
    gl.scissor(0, from, width, to - from);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  gl.disable(gl.SCISSOR_TEST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/**
 * Works out the liquid's flow through the tank: its outline drawn coarse and read back, then the way
 * from the hero to the pool through it (tankFlow), as a texture; and which rows hold any liquid.
 */
function pour() {
  pourIdle = 0;
  if (!field?.tank?.coarse || !page) return;
  const { gl, tank } = field;
  const { cols, rows, texel } = tank.grid;
  outline(tank.coarse, cols, rows);
  const bytes = new Uint8Array(cols * rows * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, tank.coarse.framebuffer);
  gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const depth = new Float32Array(cols * rows);
  for (let i = 0; i < depth.length; i++) depth[i] = -(((bytes[4 * i] ?? 0) + (bytes[4 * i + 1] ?? 0) / 255) / 255 - 0.5) * 2 * RANGE;
  const cell = 4 * texel;
  const [left, bottom] = tankArea();
  const step = cell / page.unit;
  const toCell = ([x, y]) => [(x - left) / step - 0.5, (y - bottom) / step - 0.5];
  const pool = shapes.find((shape) => shape.kind === KINDS.pool);
  const ofHero = new Uint8Array(cols * rows);
  const ofPool = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const fx = left + (x + 0.5) * step;
      const fy = bottom + (y + 0.5) * step;
      if (Math.abs(fx - body.x) <= body.hx && Math.abs(fy - body.y) <= body.hy) ofHero[y * cols + x] = 1;
      else if (pool && Math.abs(fx - pool.x) <= pool.hx && Math.abs(fy - pool.y) <= pool.hy) ofPool[y * cols + x] = 1;
    }
  }
  const flow = tankFlow({
    depth,
    cols,
    rows,
    cell,
    hero: { cells: ofHero, centre: toCell(layout.centre), spin: HERO_SPIN },
    pool: pool ? { cells: ofPool, centre: toCell([pool.x, pool.y]), spin: POOL_SPIN } : null,
  });
  gl.bindTexture(gl.TEXTURE_2D, field.flow);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, encodeFlow(flow));
  tank.wet = wetRows(depth, cols, rows, Math.ceil(GLOW / cell) + 1);
  dirty = true;
  kick();
}

/** Whether any liquid, or its glow, lies on the page between field heights `top` and `bottom`; yes until the flow has been worked out. */
function wetBetween(top, bottom) {
  const tank = field.tank;
  if (!tank?.wet) return true;
  const [, low] = tankArea();
  const step = (4 * tank.grid.texel) / page.unit;
  const from = Math.max(0, Math.floor((bottom - low) / step));
  const to = Math.min(tank.wet.length - 1, Math.ceil((top - low) / step));
  for (let j = from; j <= to; j++) if (tank.wet[j]) return true;
  return false;
}

/** The waves at rest: the basin filled to its edge, flat and still. */
function settle() {
  const { gl, tank } = field;
  if (!tank?.waves) return;
  // At rest every cell is as deep as its bed makes it, still, with its surface level: all zeros.
  gl.clearColor(0, 0, 0, 0);
  for (const made of tank.waves) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, made.framebuffer);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  tank.live = false;
}

/** One pass of the waves, from the one last written into the other, with `set` setting the program's own uniforms. */
function wavePass({ program, u }, set) {
  const { gl, tank } = field;
  const [cols, rows] = [tank.grid.cols * 2, tank.grid.rows * 2];
  gl.useProgram(program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tank.waves[tank.read].texture);
  gl.uniform1i(u.waves, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, tank.sdf.texture);
  gl.uniform1i(u.sdf, 1);
  gl.uniform2f(u.fr, cols, rows);
  set(u);
  gl.bindFramebuffer(gl.FRAMEBUFFER, tank.waves[1 - tank.read].framebuffer);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  tank.read = 1 - tank.read;
}

/**
 * Moves the waves on by `dt` seconds, in steps short enough to stay steady, around the screen only:
 * the page's acceleration `accel` (field units a second², down positive) felt the other way, the
 * brush's `stroke` dragging the liquid along, and a `press` pushing it out all round.
 */
function stepWaves(dt, accel, stroke, press) {
  const { gl, tank } = field;
  const [cols, rows] = [tank.grid.cols * 2, tank.grid.rows * 2];
  const cell = 2 * tank.grid.texel;
  const speed = WAVE_SPEED / cell;
  const steps = waveSteps(dt, speed, FASTEST);
  const h = dt / steps;
  const [left, low] = tankArea();
  const size = cell / page.unit;
  const toCell = (x, y) => [(x - left) / size, (y - low) / size];
  // Increasing scrollY moves the tank UP on screen. In page coordinates y points up,
  // so its inertial force is -acceleration; braking reverses it.
  const most = SLOSH_MOST / cell;
  const force = Math.max(-most, Math.min(most, ((-accel * page.unit) / cell) * SLOSH));
  const seg = stroke ? [...toCell(stroke.segment[0], stroke.segment[1]), ...toCell(stroke.segment[2], stroke.segment[3])] : [0, 0, 0, 0];
  const drag = stroke ? [(stroke.velocity[0] / size) * BRUSH_DRAG, (stroke.velocity[1] / size) * BRUSH_DRAG] : [0, 0];
  const pressed = press ? [...toCell(press[0], press[1]), PRESS] : [0, 0, 0];
  // Only over the canvas: what lies beyond it settles out of sight.
  const [top, bottom] = band(placed, page.height);
  const from = Math.max(0, Math.floor((bottom - low) / size) - 2);
  const to = Math.min(rows, Math.ceil((top - low) / size) + 2);
  gl.viewport(0, 0, cols, rows);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(0, from, cols, Math.max(0, to - from));
  for (let i = 0; i < steps; i++) {
    wavePass(field.push, (u) => {
      gl.uniform1f(u.dt, h);
      gl.uniform1f(u.pull, speed * speed * h);
      gl.uniform1f(u.keep, Math.exp(-h / DRAG_SECONDS));
      gl.uniform2f(u.force, 0, force);
      gl.uniform4fv(u.seg, seg);
      gl.uniform2fv(u.drag, drag);
      gl.uniform1f(u.paint, stroke ? stroke.weight * (1 - Math.exp(-h * 40)) : 0);
      gl.uniform1f(u.reach, DRAG_REACH / cell);
      gl.uniform3fv(u.press, i === 0 ? pressed : [0, 0, 0]);
      gl.uniform1f(u.spread, PRESS_REACH / cell);
      gl.uniform2f(u.rows, from, to);
    });
    wavePass(field.limit, (u) => {
      gl.uniform1f(u.dt, h);
      gl.uniform2f(u.rows, from, to);
    });
    wavePass(field.rise, (u) => {
      gl.uniform1f(u.dt, h);
      gl.uniform2f(u.rows, from, to);
    });
  }
  gl.disable(gl.SCISSOR_TEST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  tank.live = true;
}

/** A band of the page `height` tall from `from` down (CSS pixels), in field y: its top and its bottom. */
function band(from, height) {
  const top = (page.top + page.unit / 2 - from) / page.unit;
  return [top, top - height / page.unit];
}

/** Moves the canvas to `at` down the page; it is drawn for there in the same frame. */
function place(at) {
  if (at === placed) return;
  placed = at;
  canvas.style.transform = `translateY(${at}px)`;
}

function draw(scroll) {
  const { gl, ink: { program, u }, tank } = field;
  const unit = page.unit;
  const { cols, rows, texel } = tank.grid;
  const [left, low, wide, high] = tankArea();
  gl.useProgram(program);
  const bind = (slot, name, made) => {
    gl.activeTexture(gl.TEXTURE0 + slot);
    gl.bindTexture(gl.TEXTURE_2D, made);
    gl.uniform1i(u[name], slot);
  };
  bind(0, "sdf", tank.sdf.texture);
  bind(1, "flow", field.flow);
  bind(2, "waves", tank.waves ? tank.waves[tank.read].texture : tank.sdf.texture);
  bind(3, "marble", field.marble);
  gl.uniform3f(u.view, page.width / canvas.width / unit, -page.width / 2 / unit, band(placed, page.height)[1]);
  gl.uniform4f(u.tank, left, low, 1 / wide, 1 / high);
  gl.uniform4f(u.steps, 1 / (cols * 4), 1 / (rows * 4), 1 / (cols * 2), 1 / (rows * 2));
  gl.uniform4f(u.px, 1 / unit, page.width / canvas.width, texel, 2 * texel);
  gl.uniform1f(u.stirred, tank.live ? 1 : 0);
  gl.uniform1f(u.t, time);
  run(gl, null, canvas.width, canvas.height);
  dirty = false;
  drawnAt = scroll;
  if (!canvas.classList.contains("ready")) {
    canvas.classList.add("ready");
    root.classList.add("inked");
  }
}

/** Nothing of the ink is on screen: the canvas goes clear, once. */
function blank() {
  if (drawnAt === null) return;
  const { gl } = field;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  drawnAt = null;
}

/** A GPU that can't hold the frame rate gets fewer pixels; one with room gets them back, slowly. */
function adapt(ms) {
  frameMs = frameMs * 0.9 + ms * 0.1;
  if (frameMs > 24) {
    fastFrames = 0;
    if (++slowFrames > 40 && quality > 0.5) {
      quality = Math.max(0.5, quality * 0.8);
      slowFrames = 0;
      frameMs = STIRRING_MS;
      resize();
    }
  } else if (frameMs < 18) {
    slowFrames = 0;
    if (++fastFrames > 300 && quality < 1) {
      quality = Math.min(1, quality * 1.12);
      fastFrames = 0;
      resize();
    }
  } else {
    slowFrames = 0;
    fastFrames = 0;
  }
}

function tick(now) {
  frame = 0;
  if (!field?.tank?.sdf || !layout || document.hidden) return;
  const sinceFrame = now - lastFrame;
  lastFrame = now;
  const scroll = scrollY;
  // Paused, the canvas stays where it is until the screen is half way to its edge: the browser
  // carries it with the page in between, so nothing needs drawing.
  const want = canvasTop(scroll, page.height, page.screen, page.room);
  const at = paused && !dirty && drawnAt !== null && Math.abs(want - placed) < (page.height - page.screen) / 4 ? placed : want;
  const [top, bottom] = band(at, page.height);
  if (!wetBetween(top, bottom)) {
    // No liquid on the canvas; a scroll that brings some back starts the loop again.
    blank();
    return;
  }
  const tank = field.tank;
  if (paused) {
    // Still frames, after a resize or as the canvas moves on; then the loop stops until something changes.
    if (dirty || at !== placed || drawnAt === null) {
      place(at);
      draw(scroll);
    }
    return;
  }
  // The display's own frame period, so frames are skipped evenly: a 144 Hz screen drifts on every
  // fifth frame, never on an uneven three-two beat that would judder.
  period = period * 0.9 + Math.min(50, Math.max(4, sinceFrame)) * 0.1;
  const seconds = now / 1000;
  const accel = slosh.step(scroll / page.unit, seconds);
  brush.step(seconds);
  const press = brush.takePress();
  if (tank.waves && (Math.abs(accel) > 0.05 || brush.speed > 0.02 || press)) stirredAt = seconds;
  const stirring = tank.waves !== null && seconds - stirredAt < SETTLE_SECONDS;
  // The river's liquid runs on wherever it shows below the hero, so it gets every display frame to
  // flow on rather than step.
  const river = band(scroll, page.screen)[1] < -0.6;
  const lively = scroll !== drawnAt || stirring || river;
  const every = lively ? 1 : Math.max(1, Math.round(DRIFTING_MS / period));
  if (dirty || press || ++skipped >= every) {
    skipped = 0;
    const dt = Math.min((now - lastDraw) / 1000, 0.05);
    lastDraw = now;
    time += dt;
    const stroke = brush.paint();
    place(at);
    if (stirring) stepWaves(dt, accel, stroke, press);
    else if (tank.live) settle();
    draw(scroll);
    adapt(sinceFrame);
  }
  // A resize in this frame (the quality stepping) has already asked for the next one: one loop only.
  if (!frame) frame = requestAnimationFrame(tick);
}

/** Starts the loop if it has stopped. */
function kick() {
  if (frame || !field || document.hidden) return;
  lastFrame = performance.now();
  frame = requestAnimationFrame(tick);
}

function stop() {
  cancelAnimationFrame(frame);
  frame = 0;
}

/** Where the pointer is on the page, in field units. */
function pagePoint(event) {
  return pageToField(event.clientX, event.clientY + scrollY, page);
}

function leave() {
  brush.leave();
  kick();
}

if (field) {
  // The button under the phone pauses the liquid with the demo, and the system's reduced motion
  // pauses both; demo.js says which.
  document.addEventListener("motion", (event) => {
    paused = event.detail.paused;
    brush.reset();
    slosh.reset();
    lastDraw = performance.now();
    dirty = true;
    kick();
  });

  addEventListener(
    "pointermove",
    (event) => {
      if (paused || !layout || event.isPrimary === false) return;
      if (event.target instanceof Element && event.target.closest("a, button, .phone")) return leave();
      // Only where the pointer is now: the brush eases after it once a frame, so uneven events
      // never reach the liquid as jumps.
      const at = pagePoint(event);
      brush.point(at[0], at[1]);
      kick();
    },
    { passive: true },
  );
  addEventListener("pointerdown", (event) => {
    if (paused || !layout || event.isPrimary === false || (event.target instanceof Element && event.target.closest("a, button, .phone"))) return;
    const at = pagePoint(event);
    brush.point(at[0], at[1]);
    brush.press(at[0], at[1]);
    kick();
  });
  // A finger that starts scrolling is cancelled; a mouse that leaves the window is out. A scroll
  // moves the page under a still pointer, so the brush rests and starts afresh where it next moves.
  addEventListener("pointercancel", leave);
  addEventListener("pointerup", (event) => { if (event.pointerType !== "mouse") leave(); });
  root.addEventListener("pointerleave", leave);
  addEventListener(
    "scroll",
    () => {
      brush.leave();
      kick();
    },
    { passive: true },
  );

  const resized = new ResizeObserver(measure);
  for (const el of [document.body, copy, phone, canvas]) if (el) resized.observe(el);
  // Once the page's font has come, the letters the ink fills are set again in it.
  document.fonts?.ready.then(() => {
    if (field) field.glyphsFor = "";
    measure();
  });
  document.addEventListener("visibilitychange", () => {
    brush.reset();
    slosh.reset();
    lastDraw = performance.now();
    document.hidden ? stop() : kick();
  });
  addEventListener("pagehide", stop);
  addEventListener("pageshow", kick);

  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    stop();
    waitToPour();
    field = null;
    canvas.classList.remove("ready");
    root.classList.remove("inked");
  });
  canvas.addEventListener("webglcontextrestored", () => {
    try {
      field = start();
    } catch (error) {
      console.error(error);
    }
    drawnAt = null;
    measure();
  });

  measure();
}
