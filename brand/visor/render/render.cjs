// Renders the Visor: frames (headless Chrome, paused CSS animations seeked frame
// by frame), then the bot photo MP4 and six WEBM stickers (ffmpeg), into brand/visor/.
//   npm i --no-save playwright-core ffmpeg-static   (here, once; or RENDER_MODULES=<a node_modules with both>)
//   node render.cjs frames [name...] | encode | review | all | mark (the website's logo files)
// The drawing is mq.js (the traced Q in its slanted frame), the motion base.css + export.css.
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const { spawnSync } = require("child_process");
const NM = process.env.RENDER_MODULES || path.join(__dirname, "node_modules");
const { chromium } = require(path.join(NM, "playwright-core"));
const FF = require(path.join(NM, "ffmpeg-static"));
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DIR = __dirname, FPS = 30, T0 = 60000; // T0: a common multiple of every period, past every delay
const STATES = ["active", "search", "news", "wait", "sleep", "off"];
const JOBS = [
  { name: "photo-active", mode: "photo", state: "active", size: 800, secs: 6 },
  ...STATES.map((s) => ({ name: "sticker-" + s, mode: "sticker", state: s, size: 512, secs: s === "news" ? 1.5 : 3 })),
];
const url = (j, extra = "") => "file:///" + path.join(DIR, "render.html").replace(/\\/g, "/") + `?mode=${j.mode}&state=${j.state}${extra}`;

// Alpha bounding box of an RGBA PNG (Chrome writes 8-bit RGBA, non-interlaced).
function alphaBox(file) {
  const buf = fs.readFileSync(file);
  let p = 8, w, h, idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("ascii", p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); if (d[9] !== 6) return null; }
    if (type === "IDAT") idat.push(d);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), bpp = 4, stride = w * bpp, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], o = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      let v = raw[o + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 255;
    }
  }
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[y * stride + x * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}

async function frames(only, extra) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--force-color-profile=srgb", "--hide-scrollbars"] });
  for (const j of JOBS.filter((j) => !only.length || only.includes(j.name))) {
    const page = await browser.newPage({ viewport: { width: j.size, height: j.size }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(url(j, extra));
    await page.waitForFunction(() => window.__ready === true);
    const out = path.join(DIR, "frames", j.name);
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const n = Math.round(j.secs * FPS);
    let box = null;
    for (let i = 0; i < n; i++) {
      await page.evaluate((ms) => window.seek(ms), T0 + (i * 1000) / FPS);
      const f = path.join(out, String(i).padStart(3, "0") + ".png");
      await page.screenshot({ path: f, omitBackground: j.mode === "sticker" });
      if (j.mode === "sticker") {
        const b = alphaBox(f);
        box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b;
      }
    }
    console.log(j.name, n, "frames", box ? "alpha box " + box.join(",") : "", errors.join(" | "));
    await page.close();
  }
  await browser.close();
}

function ff(args) {
  const r = spawnSync(FF, ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status) throw new Error(r.stderr);
}

function encode() {
  const out = path.join(DIR, "..");
  fs.mkdirSync(out, { recursive: true });
  // Bot photo: square H.264 MP4, BT.709, no audio. Telegram: square, <= 10 s, 160..1280 px, <= 2 MB.
  ff(["-framerate", FPS, "-i", path.join(DIR, "frames/photo-active/%03d.png"),
    "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
    "-c:v", "libx264", "-preset", "veryslow", "-tune", "animation", "-crf", "14", "-profile:v", "high",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-movflags", "+faststart", "-an", path.join(out, "quest-visor-photo.mp4")].map(String));
  // Stickers: 512 px VP9 WEBM with alpha. Telegram: <= 3 s, <= 30 fps, <= 256 KB, no audio.
  // The best quality that fits, with a little headroom under the 256 KB cap.
  for (const s of STATES) {
    const file = path.join(out, `quest-visor-${s}.webm`);
    for (const crf of [24, 27, 30, 33, 36, 40]) {
      ff(["-framerate", FPS, "-i", path.join(DIR, `frames/sticker-${s}/%03d.png`),
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", crf, "-deadline", "good", "-cpu-used", "0", "-row-mt", "1",
        "-an", file].map(String));
      if (fs.statSync(file).size <= 245 * 1024) { console.log(s, "crf", crf); break; }
    }
  }
  for (const f of fs.readdirSync(out).filter((f) => /\.(mp4|webm)$/.test(f))) console.log(f, fs.statSync(path.join(out, f)).size, "bytes");
}

async function review() {
  // One sheet: each sticker at 6 moments on Telegram's light and dark chat colours, plus the photo in its circle.
  const pick = (name, n, k) => Array.from({ length: k }, (_, i) => `frames/${name}/${String(Math.floor((i * n) / k)).padStart(3, "0")}.png`);
  let h = `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:12px system-ui;background:#fff}.row{display:flex;gap:6px;padding:6px 8px;align-items:center}.row b{width:70px}.l{background:#cfdcbd}.d{background:#0e1621;color:#ccc}img{width:150px;height:150px}.ph img{border-radius:50%;width:220px;height:220px}</style>`;
  for (const s of STATES) for (const bg of ["l", "d"]) h += `<div class="row ${bg}"><b>${s}</b>` + pick("sticker-" + s, s === "news" ? 45 : 90, 6).map((f) => `<img src="${f}">`).join("") + `</div>`;
  h += `<div class="row ph d"><b>photo</b>` + pick("photo-active", 180, 5).map((f) => `<img src="${f}">`).join("") + `</div>`;
  fs.writeFileSync(path.join(DIR, "review.html"), h);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.goto("file:///" + path.join(DIR, "review.html").replace(/\\/g, "/"));
  await page.screenshot({ path: path.join(DIR, "review.png"), fullPage: true });
  await browser.close();
  console.log("review.png");
}

// The website's logo files, into apps/web/public: quest.svg (the mark alone, a tight box, with a
// blink and the antenna light) and favicon.svg (the mark on the dark tile, still). Both in the
// site's lime, a hair off the photo's, so the mark matches ".quest" beside it.
async function mark() {
  const MQ = new Function(fs.readFileSync(path.join(DIR, "mq.js"), "utf8") + "; return MQ;")();
  const LIME = "#ceff32", SCREEN = "#1a230a";
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
  await page.setContent(`<style>body{margin:0}svg{width:512px;height:512px;display:block}</style>${MQ.svg("bot", { state: "active", still: true })}`);
  const { box, rig } = await page.evaluate(() => {
    const svg = document.querySelector("svg");
    for (const el of svg.querySelectorAll(".disc, .fx, .e-half, .e-star, .e-dash")) el.remove();
    const r = svg.querySelector(".rig").getBoundingClientRect();
    return { box: [r.left, r.top, r.width, r.height], rig: svg.querySelector(".rig").parentElement.outerHTML };
  });
  await browser.close();
  const drawing = rig.replace(/(\d+\.\d{3})\d+/g, "$1");
  const r1 = (n) => Math.round(n * 10) / 10;
  const [x, y, w, h] = box, pad = 3;
  const web = path.join(DIR, "../../../apps/web/public");
  fs.writeFileSync(path.join(web, "quest.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${[x - pad, y - pad, w + 2 * pad, h + 2 * pad].map(r1).join(" ")}">` +
    `<style>.body,.pupil{fill:${LIME}}.screen{fill:${SCREEN}}.lid,.bulb{transform-box:fill-box;transform-origin:50% 50%}` +
    `.lid{animation:blink 5.2s infinite}.bulb{animation:pulse 2.6s ease-in-out infinite}` +
    `@keyframes blink{0%,90%,100%{transform:scaleY(1)}93%{transform:scaleY(.08)}96%{transform:scaleY(1)}}` +
    `@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}@media (prefers-reduced-motion:reduce){.lid,.bulb{animation:none}}</style>` +
    drawing + `</svg>\n`);
  // The tile: the mark fills it to 8% of the side, so it still reads at 16 px in a tab.
  const T = 512, inset = 0.08 * T, side = Math.max(w, h) + 2 * pad, s = (T - 2 * inset) / side;
  fs.writeFileSync(path.join(web, "favicon.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${T} ${T}"><style>.body,.pupil{fill:${LIME}}.screen{fill:${SCREEN}}</style>` +
    `<rect width="${T}" height="${T}" rx="112" fill="#0b0c0b"/>` +
    `<g transform="translate(${r1(inset)} ${r1(inset)}) scale(${Math.round(s * 1e4) / 1e4}) translate(${r1(-(x + w / 2 - side / 2))} ${r1(-(y + h / 2 - side / 2))})">${drawing}</g></svg>\n`);
  for (const f of ["quest.svg", "favicon.svg"]) console.log(f, fs.statSync(path.join(web, f)).size, "bytes");
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const extra = process.env.EXTRA || "";
  if (cmd === "mark") return mark();
  if (cmd === "frames" || cmd === "all") await frames(cmd === "all" ? [] : rest, extra);
  if (cmd === "encode" || cmd === "all") encode();
  if (cmd === "review" || cmd === "all") await review();
})().catch((e) => { console.error(e); process.exit(1); });
