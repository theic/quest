const MQ = (() => {
  const FRAME = "matrix(0.974 -0.225 -0.493 0.870 190 138)";
  const face = (x, y, inner) => `<g transform="translate(${x} ${y}) rotate(-13) skewX(-12)">${inner}</g>`;
  const P = (a) => a.map((p) => p.map((n) => Math.round(n * 10) / 10).join(",")).join(" ");
  const poly = (a, c = "") => `<polygon${c ? ` class="${c}"` : ""} points="${P(a)}"/>`;
  const dia = (x, y, rx, ry = rx) => [[x, y - ry], [x + rx, y], [x, y + ry], [x - rx, y]];
  const star = (x, y, R, r) => [[x, y - R], [x + r, y - r], [x + R, y], [x + r, y + r], [x, y + R], [x - r, y + r], [x - R, y], [x - r, y - r]];
  const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const hex = (x, y, rx, w, ry) => [[x - rx, y], [x - w, y - ry], [x + w, y - ry], [x + rx, y], [x + w, y + ry], [x - w, y + ry]];
  const lower = (x, y, rx, ry) => [[x - rx, y], [x + rx, y], [x, y + ry]];
  const chevron = (x, y, w, h, t) => [[x - w, y + h], [x, y - h], [x + w, y + h], [x + w - t, y + h], [x, y - h + t * 1.6], [x - w + t, y + h]];
  const cross = (x, y, s, t) => poly([[x - s, y - s], [x - s + t, y - s], [x + s, y + s], [x + s - t, y + s]], "pupil") + poly([[x + s - t, y - s], [x + s, y - s], [x - s + t, y + s], [x - s, y + s]], "pupil");
  const path = (a) => "M" + a.map((p) => p.join(",")).join(" L") + "Z";

  // The traced Q (from the 512 px logo), in the slanted frame.
  const OUTER = [[0, 0], [253, 0], [302, 251], [259, 265], [320, 321], [339, 406], [156, 234], [0, 241]];
  const HOLE = [[74, 79], [196, 75], [227, 233], [148, 162], [72, 164]];
  // The mascot's Q: the same outline, a lighter top bar, left side and floor, so the face has room.
  const FACE = [[58, 60], [193, 60], [227, 233], [170, 182], [58, 182]];
  const LOGO = `<path class="body" fill-rule="evenodd" d="${path(OUTER)} ${path(HOLE)}"/>`;
  const HEAD = `<path class="body" fill-rule="evenodd" d="${path(OUTER)} ${path(FACE)}"/>`;
  const C = [255, 216]; // the middle of the face, in the 512 box

  // Effects, in the circle's own space (512 box), placed per mascot.
  const zed = (x, y, s, i) =>
    `<polyline class="z z${i}" points="${P([[x, y], [x + s, y - s * 0.23], [x - s * 0.12, y + s * 0.88], [x + s * 0.88, y + s * 0.65]])}"/>`;
  const fx = ({ z: [zx, zy], q: [qx, qy], sparks }) =>
    `<g class="fx fx-z">${zed(zx, zy, 30, 1)}${zed(zx - 34, zy - 60, 38, 2)}${zed(zx - 78, zy - 128, 46, 3)}</g>` +
    `<g class="fx fx-q" transform="translate(${qx} ${qy}) rotate(-8)"><g class="q-in"><polyline points="${P([[0, 14], [44, 0], [58, 36], [28, 60], [28, 86]])}"/>${poly(rect(17, 106, 22, 22), "dot")}</g></g>` +
    `<g class="fx fx-spark">${sparks.map(([x, y, r], i) => poly(star(x, y, r, r * 0.3), "spark k" + i)).join("")}</g>`;

  const eyesBlock = (open, half, starE, dash) =>
    `<g class="eyes"><g class="look"><g class="lid">${open}</g></g>` +
    `<g class="e-half">${half}</g><g class="e-star">${starE}</g><g class="e-dash">${dash}</g></g>`;

  const KINDS = {
    lens: {
      fit: [0.96, 254, 250],
      fx: { z: [176, 150], q: [92, 74], sparks: [[132, 104, 30], [196, 58, 18], [96, 186, 14]] },
      draw: () =>
        `<g transform="${FRAME}">${HEAD}</g>` +
        face(...C, eyesBlock(
          poly(hex(0, 2, 58, 30, 40), "pupil") + poly(dia(6, 1, 17, 22), "iris") + poly(dia(13, -8, 5, 6), "pupil"),
          poly([[-54, 6], [54, 6], [28, 30], [-28, 30]], "pupil"),
          poly(star(0, 2, 50, 12), "pupil"),
          poly(rect(-40, -5, 80, 13), "pupil")
        )),
    },
    owl: {
      fit: [0.9, 250, 232],
      fx: { z: [150, 176], q: [64, 110], sparks: [[300, 82, 28], [366, 52, 16], [104, 196, 14]] },
      draw: () =>
        `<g transform="${FRAME}"><g class="tuft">${poly([[0, 2], [-58, -78], [82, 2]], "body")}</g>${HEAD}</g>` +
        face(...C,
          eyesBlock(
            poly(dia(-32, 8, 30, 38), "pupil") + poly(dia(-28, 5, 12, 16), "iris") +
              poly(dia(32, 8, 30, 38), "pupil") + poly(dia(36, 5, 12, 16), "iris"),
            poly(lower(-32, 10, 30, 30), "pupil") + poly(lower(32, 10, 30, 30), "pupil"),
            poly(star(-32, 6, 34, 8), "pupil") + poly(star(32, 6, 34, 8), "pupil"),
            poly(rect(-56, 0, 48, 11), "pupil") + poly(rect(8, 0, 48, 11), "pupil")
          ) + poly([[-11, -50], [11, -50], [0, -20]], "body beak")),
    },
    bird: {
      fit: [0.86, 262, 240],
      fx: { z: [176, 150], q: [62, 200], sparks: [[446, 206, 26], [470, 270, 14], [96, 250, 18]] },
      draw: () =>
        `<g class="wing">${poly([[226, 132], [328, 110], [150, 24], [180, 74], [134, 58], [176, 104], [130, 98]], "body")}</g>` +
        `<g transform="${FRAME}">${HEAD}</g>` +
        face(392, 118, eyesBlock(
          poly(dia(0, 0, 15, 18), "cut") + poly(dia(4, -4, 5, 6), "pupil"),
          poly(rect(-15, -1, 30, 8), "cut"),
          poly(star(0, 0, 19, 5), "cut"),
          poly(rect(-14, -3, 28, 8), "cut")
        )) +
        `<g class="letter">${face(330, 452, poly(rect(-46, -30, 92, 60), "env") + `<polyline class="env-v" points="-46,-30 0,4 46,-30"/>`)}</g>`,
    },
    bot: {
      fit: [0.9, 256, 226],
      fx: { z: [170, 160], q: [80, 84], sparks: [[124, 128, 28], [186, 74, 16], [446, 176, 14]] },
      draw: () =>
        `<g transform="${FRAME}">${poly(FACE, "screen")}<g class="ant">${poly([[150, 2], [170, 2], [190, -56], [170, -56]], "body")}<g class="bulb">${poly([[178, -100], [206, -78], [184, -56], [156, -78]], "body")}</g></g>${HEAD}</g>` +
        face(...C, eyesBlock(
          poly(rect(-46, -26, 30, 52), "pupil") + poly(rect(16, -26, 30, 52), "pupil"),
          poly(rect(-50, 6, 38, 11), "pupil") + poly(rect(12, 6, 38, 11), "pupil"),
          poly(chevron(-31, 0, 20, 16, 11), "pupil") + poly(chevron(31, 0, 20, 16, 11), "pupil"),
          cross(-31, 0, 16, 9) + cross(31, 0, 16, 9)
        )),
    },
  };

  // A die-cut sticker: no disc, a dark cut line around the body (alpha thresholded, so the
  // edge stays solid while the body dims). The effects carry their own outline, a dark copy
  // drawn under them, so it grows and shrinks with them.
  const CUT = (r) =>
    `<defs><filter id="cut" filterUnits="userSpaceOnUse" x="-100" y="-100" width="712" height="712" color-interpolation-filters="sRGB">` +
    `<feComponentTransfer in="SourceAlpha" result="a"><feFuncA type="linear" slope="40"/></feComponentTransfer>` +
    `<feMorphology in="a" operator="dilate" radius="${r}" result="d"/><feFlood flood-color="#0b0c0b"/>` +
    `<feComposite in2="d" operator="in" result="o"/><feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;

  function svg(kind, { state = "active", tile = false, glow = false, still = false, label = "", cls: extra = "", sticker = null, fxAt = null } = {}) {
    const k = KINDS[kind];
    const [s, cx, cy] = k.fit;
    const sc = tile ? s * 0.94 : s;
    const fit = `translate(256 256) scale(${sc}) translate(${-cx} ${-cy})`;
    const cls = ["mq", "m-" + kind, "s-" + state, glow ? "glow" : "", still ? "still" : "", extra].filter(Boolean).join(" ");
    if (sticker) {
      const { zoom, at: [ax, ay], cut } = sticker;
      return (
        `<svg class="${cls}" viewBox="0 0 512 512">${CUT(cut)}` +
        `<g transform="translate(256 256) scale(${zoom}) translate(${-ax} ${-ay})">` +
        `<g filter="url(#cut)"><g transform="${fit}"><g class="rig">${k.draw()}</g></g></g>` +
        `<g class="under">${fx(fxAt || k.fx)}</g>${fx(fxAt || k.fx)}</g></svg>`
      );
    }
    return (
      `<svg class="${cls}" viewBox="0 0 512 512" role="img" aria-label="${label}">` +
      (tile ? `<rect class="tile" x="16" y="16" width="480" height="480" rx="104"/>` : `<circle class="disc" cx="256" cy="256" r="256"/>`) +
      `<g transform="${fit}"><g class="rig">${k.draw()}</g></g>` +
      (tile ? "" : fx(k.fx)) +
      `</svg>`
    );
  }

  const original = () =>
    `<svg class="mq m-orig" viewBox="0 0 512 512" role="img" aria-label="The original Q logo"><rect class="tile" x="16" y="16" width="480" height="480" rx="104"/><g transform="${FRAME}">${LOGO}</g></svg>`;

  return { svg, original };
})();
