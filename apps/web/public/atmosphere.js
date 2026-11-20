import { ready, t } from "/i18n/browser.js";
await ready;
import { vertex, fragments } from "./atmosphere-shaders.js";
import { GasGrid } from "./gas-model.js";

export const directions = {
  weather: { number: "01", name: "Signal weather", idea: "The internet is a cloud of noise. Quest finds the signal.", scroll: "Scroll to stir the mist", touch: "Move to stir the gas · tap to make it swirl" },
  whispers: { number: "02", name: "Whisper archive", idea: "Somewhere, someone is already asking. Make the unheard visible.", scroll: "Scroll to uncover the next voice", touch: "Move to illuminate · tap to scatter a voice" },
  pollen: { number: "03", name: "Magnetic pollen", idea: "A thousand strangers. One useful connection waiting to happen.", scroll: "Scroll to bring distant points together", touch: "Move to attract · tap to release" },
};

// Pixels drawn a frame. A phone draws fewer: the mist is soft, and its GPU also composites the
// page as it scrolls. A device that still can't keep up steps down further (pace() below).
const BUDGET = { weather: 360000, other: 480000 };
const PHONE_SHARE = .45;
const FLOOR = 90000;
// A finger that lifts within this long and this close to where it landed tapped; anything else scrolled.
const TAP_MS = 400;
const TAP_PX = 12;

function program(gl, source) {
  const shaders = [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, source]].map(([type, code]) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, code); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  });
  const result = gl.createProgram();
  shaders.forEach(shader => gl.attachShader(result, shader));
  gl.linkProgram(result);
  shaders.forEach(shader => gl.deleteShader(shader));
  if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result));
  return result;
}

function wordTexture(gl) {
  const paper = document.createElement("canvas"); paper.width = 2048; paper.height = 2048;
  const ctx = paper.getContext("2d");
  ctx.fillStyle = "black"; ctx.fillRect(0, 0, 2048, 2048);
  ctx.fillStyle = "white"; ctx.textBaseline = "middle";
  ctx.font = "600 460px 'DM Sans', sans-serif";
  ctx.fillText(t("hello"), 560, 380);
  ctx.font = "italic 500 570px Georgia, serif"; ctx.fillText("“", 300, 930);
  ctx.font = "500 440px 'DM Sans', sans-serif"; ctx.fillText(t("anyone?"), 620, 1020);
  ctx.font = "600 440px 'DM Sans', sans-serif"; ctx.fillText(t("let’s talk"), 210, 1680);
  const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, paper);
  return texture;
}

function flowTexture(gl, filter) {
  const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

// The weather's flow, as the scene sees it: the grid's shape and its last picture. A worker steps it
// (gas-worker.js) and this passes on what stirred it and how much time went by, at most one step ahead, so a
// solver slower than a frame (a phone's) never holds the page's scrolling up; it only slows the flow down. Where
// a worker can't start, the grid steps here, as it always did.
class Flow {
  constructor(aspect, rows) {
    this.grid = new GasGrid(aspect, rows);
    ({ cols: this.cols, rows: this.rows, mapBytes: this.mapBytes, dyeBytes: this.dyeBytes } = this.grid);
    this.version = 0; this.owed = 0; this.inputs = []; this.waiting = false; this.measured = null;
    try {
      this.worker = new Worker(new URL("./gas-worker.js", import.meta.url), { type: "module" });
      this.worker.onmessage = ({ data }) => {
        this.mapBytes = data.map; this.dyeBytes = data.dye; this.measured = data.metrics;
        this.version++; this.waiting = false; this.send();
      };
      this.worker.onerror = () => this.dispose();
      this.worker.postMessage({ aspect, rows });
    } catch { this.worker = null; }
  }
  scroll(delta) { this.input("scroll", delta); }
  stroke(x0, y0, x1, y1) { this.input("stroke", x0, y0, x1, y1); }
  tap(x, y) { this.input("tap", x, y); }
  input(name, ...args) { if (this.worker) this.inputs.push([name, ...args]); else this.grid[name](...args); }
  advance(dt) {
    if (!this.worker) { this.grid.advance(dt); ({ mapBytes: this.mapBytes, dyeBytes: this.dyeBytes } = this.grid); this.version++; return; }
    this.owed += dt; this.send();
  }
  send() {
    if (this.waiting || !this.worker || (!this.owed && !this.inputs.length)) return;
    this.worker.postMessage({ dt: this.owed, inputs: this.inputs });
    this.owed = 0; this.inputs = []; this.waiting = true;
  }
  metrics() { return this.worker && this.measured ? this.measured : this.grid.metrics(); }
  /** Stops the worker; the grid here carries on with what is still owed. */
  dispose() {
    this.worker?.terminate(); this.worker = null; this.waiting = false;
    for (const [name, ...args] of this.inputs) this.grid[name](...args);
    this.inputs = [];
  }
}

// A fixed viewpoint, no tank or surface. The scroll position is an explicit scene coordinate.
export function startAtmosphere(canvas, kind, { particles = null, miniature = false } = {}) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, powerPreference: "low-power" });
  if (!gl) { canvas.classList.add("unavailable"); return null; }
  const weather = kind === "weather";
  const phone = matchMedia("(pointer: coarse)").matches;
  let budget = (weather ? BUDGET.weather : BUDGET.other) * (phone ? PHONE_SHARE : 1);

  // Everything the GPU holds, made again after the context is lost and restored (a phone does that
  // to a tab in the background) instead of reloading the page under the reader.
  let scene, uniforms, words = null, mapTexture = null, inkTexture = null, uploaded = null, uploadedVersion = -1;
  function init() {
    scene = program(gl, fragments[kind]);
    gl.useProgram(scene);
    const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(scene, "position");
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    uniforms = Object.fromEntries(["resolution", "time", "travel", "progress", "impulse", "pointer", "pulse", "words", "gasMap", "gasInk", "gasSize"].map(name => [name, gl.getUniformLocation(scene, name)]));
    words = kind === "whispers" ? wordTexture(gl) : null;
    // The displacement map is decoded texel by texel in the shader, so it is never filtered.
    if (weather) { mapTexture = flowTexture(gl, gl.NEAREST); inkTexture = flowTexture(gl, gl.LINEAR); }
    uploaded = null;
  }
  try { init(); } catch (error) { console.error(error); canvas.classList.add("unavailable"); return null; }

  let gas = null, gasAspect = 0, pointerLast = null, lastPageScroll = scrollY, touch = null;
  let width = 1, height = 1, frame = 0, last = performance.now(), elapsed = 0;
  let paused = reduce.matches, hidden = document.hidden, visible = true, lost = false, dirty = true;
  let scroll = 0, targetScroll = 0, speed = 0, pointerStrength = 0, slowFrames = 0;
  const aim = { x: .78, y: .5, active: 0 }, mouse = { x: .78, y: .5 };
  const tap = { x: .78, y: .5, age: 20 };
  let drawCount = 0;
  const overlay = particles?.getContext("2d");
  let motes = [];
  const random = n => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  // Scroll is counted in screens. The landing's canvas is the large viewport, which holds still while
  // a phone's toolbar comes and goes; innerHeight does not, and would jolt the mist each time.
  const screenHeight = () => Math.max(1, miniature ? innerHeight : height);

  function size() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const turned = Math.abs(rect.height - height) > 1;
    width = rect.width; height = rect.height;
    const scale = Math.min(devicePixelRatio, miniature ? 1 : 1.35, Math.sqrt(budget / (width * height)));
    const pixelsWide = Math.max(1, Math.round(width * scale)), pixelsHigh = Math.max(1, Math.round(height * scale));
    // Assigning a canvas's size blanks it, even to the same numbers.
    if (pixelsWide !== canvas.width || pixelsHigh !== canvas.height) { canvas.width = pixelsWide; canvas.height = pixelsHigh; }
    gl.viewport(0, 0, canvas.width, canvas.height);
    // Only a new shape (a phone turned on its side) starts the flow over.
    if (weather && (!gas || Math.abs(Math.log(gasAspect * height / width)) > .15)) {
      gas?.dispose(); gas = new Flow(width / height, miniature ? 32 : 40); gasAspect = width / height; pointerLast = null;
    }
    if (particles) {
      particles.width = canvas.width; particles.height = canvas.height;
      motes = Array.from({ length: miniature ? 280 : 720 }, (_, i) => ({ x: random(i) * width, y: random(i + 1100) * height, oldX: 0, oldY: 0, age: random(i + 2200) * 10, seed: i, vx: 0, vy: 0 }));
    }
    if (turned) { targetScroll = scroll = scrollY / screenHeight(); lastPageScroll = scrollY; }
    // Draw now, before the browser paints the blank canvas.
    if (!lost && drawCount) render(0);
    dirty = true; kick();
  }
  function pageScroll() {
    if (!paused) gas?.scroll((scrollY - lastPageScroll) / screenHeight());
    lastPageScroll = scrollY; pointerLast = null;
    targetScroll = scrollY / screenHeight();
    if (reduce.matches || paused) scroll = targetScroll;
    dirty = true; kick();
  }
  function locate(event) {
    const rect = canvas.getBoundingClientRect();
    aim.x = (event.clientX - rect.left) / rect.width; aim.y = 1 - (event.clientY - rect.top) / rect.height;
    aim.active = aim.x >= 0 && aim.x <= 1 && aim.y >= 0 && aim.y <= 1 ? 1 : 0;
  }
  function move(event) {
    // A finger moving is the page scrolling; only a mouse or a pen stirs the air.
    if (paused || !event.isPrimary || event.pointerType === "touch") return;
    locate(event);
    if (aim.active && pointerLast) gas?.stroke(pointerLast.x, pointerLast.y, aim.x, aim.y);
    pointerLast = aim.active ? { x: aim.x, y: aim.y } : null;
    dirty = true; kick();
  }
  function puff(event) {
    locate(event); tap.x = aim.x; tap.y = aim.y; tap.age = 0;
    gas?.tap(aim.x, aim.y); pointerLast = { x: aim.x, y: aim.y }; dirty = true; kick();
  }
  function press(event) {
    if (paused || !event.isPrimary || event.target.closest("a,button,label,select")) return;
    // Every scroll on a phone starts with a finger down: wait to see whether it was a tap.
    if (event.pointerType === "touch") touch = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    else puff(event);
  }
  function release(event) {
    if (event.pointerType !== "touch") return;
    const tapped = touch && event.isPrimary && !paused && event.timeStamp - touch.at < TAP_MS && Math.hypot(event.clientX - touch.x, event.clientY - touch.y) < TAP_PX;
    if (tapped) puff(event);
    leave();
  }
  function leave() { aim.active = 0; pointerLast = null; touch = null; }
  function motion(event) { paused = !!event.detail.paused || reduce.matches; pointerLast = null; last = performance.now(); dirty = true; kick(); }
  function preference() { paused = reduce.matches || document.querySelector("#pause")?.dataset.paused === "true"; pointerLast = null; last = performance.now(); dirty = true; kick(); }
  function visibility() { hidden = document.hidden; pointerLast = null; last = performance.now(); if (hidden) { cancelAnimationFrame(frame); frame = 0; } else kick(); }

  // A device that keeps missing frames draws fewer pixels rather than stuttering the page.
  function pace(interval) {
    if (interval > 26 && interval < 250) slowFrames++;
    else slowFrames = Math.max(0, slowFrames - 2);
    if (slowFrames > 45 && budget * .6 >= FLOOR) { budget *= .6; slowFrames = 0; size(); }
  }

  function pollen(dt) {
    if (!overlay) return;
    const ratio = particles.width / width;
    overlay.setTransform(ratio, 0, 0, ratio, 0, 0);
    overlay.clearRect(0, 0, width, height);
    // Each mote leaves a short luminous trail. Links appear only near useful encounters.
    overlay.globalCompositeOperation = "lighter";
    const anchors = Array.from({ length: 6 }, (_, i) => ({
      x: width * (.49 + .27 * Math.sin(i * 2.2 + scroll * .55)),
      y: height * (.5 + .33 * Math.cos(i * 1.9 - scroll * .6)),
    }));
    const trails = [[], [], [], []], links = [];
    for (const mote of motes) {
      const x = mote.x / width, y = mote.y / height;
      const angle = Math.sin(x * 5 + y * 3 + elapsed * .10 + scroll * .9) * 2.4 + Math.cos(y * 5 - x * 2 - scroll * .65);
      let vx = Math.cos(angle) * 22, vy = Math.sin(angle) * 22;
      const node = anchors[mote.seed % anchors.length];
      const pull = .10 + .16 * (.5 + .5 * Math.sin(scroll * 1.5));
      vx += (node.x - mote.x) * pull; vy += (node.y - mote.y) * pull - speed * 75;
      const dx = mouse.x * width - mote.x, dy = (1 - mouse.y) * height - mote.y;
      const near = Math.exp(-(dx * dx + dy * dy) / (height * height * .075)) * pointerStrength;
      vx += dx * near * .85; vy += dy * near * .85;
      const tx = mote.x - tap.x * width, ty = mote.y - (1 - tap.y) * height, distance = Math.hypot(tx, ty);
      const burst = Math.exp(-Math.pow((distance / height - tap.age * .32) * 8, 2)) * Math.exp(-tap.age) * 150;
      vx += tx / (distance + 1) * burst; vy += ty / (distance + 1) * burst;
      mote.vx += (vx - mote.vx) * Math.min(1, dt * 3); mote.vy += (vy - mote.vy) * Math.min(1, dt * 3);
      if (dt > 0) {
        mote.oldX = mote.x; mote.oldY = mote.y;
        mote.x += mote.vx * dt; mote.y += mote.vy * dt;
        if (mote.x < -20 || mote.x > width + 20 || mote.y < -20 || mote.y > height + 20) {
          mote.x = random(mote.seed + elapsed) * width; mote.y = random(mote.seed + elapsed + 900) * height; mote.oldX = mote.x; mote.oldY = mote.y;
        }
      }
      const bright = .22 + .5 * random(mote.seed + 17);
      const veil = .3 + .7 * Math.min(1, Math.max(0, (x - .2) * 3));
      trails[Math.min(3, Math.floor(bright * veil * 5))].push(mote);
      if (mote.seed % 13 === 0 && Math.hypot(node.x - mote.x, node.y - mote.y) < 130) {
        links.push([mote, node]);
      }
    }
    // Batch by brightness: eight draw calls instead of a stroke/fill pair per mote.
    overlay.lineWidth = .6;
    for (let index = 0; index < trails.length; index++) {
      overlay.strokeStyle = `rgba(183,255,128,${.055 + index * .07})`; overlay.beginPath();
      for (const mote of trails[index]) { overlay.moveTo(mote.x - mote.vx * .09, mote.y - mote.vy * .09); overlay.lineTo(mote.x, mote.y); }
      overlay.stroke(); overlay.fillStyle = `rgba(202,255,145,${.13 + index * .15})`; overlay.beginPath();
      for (const mote of trails[index]) { const diameter = random(mote.seed + 20) > .94 ? 1.7 : .8; overlay.rect(mote.x, mote.y, diameter, diameter); }
      overlay.fill();
    }
    overlay.strokeStyle = "rgba(180,246,151,.055)"; overlay.beginPath();
    for (const [mote, node] of links) { overlay.moveTo(mote.x, mote.y); overlay.lineTo(node.x, node.y); }
    overlay.stroke();
    for (const node of anchors) {
      const glow = overlay.createRadialGradient(node.x, node.y, 0, node.x, node.y, 16);
      glow.addColorStop(0, "#ccff9b99"); glow.addColorStop(.12, "#a3ff6744"); glow.addColorStop(1, "#a3ff6700");
      overlay.fillStyle = glow; overlay.fillRect(node.x - 16, node.y - 16, 32, 32);
    }
    overlay.globalCompositeOperation = "source-over";
  }

  /** Moves time, the flow and the eased inputs on to `now`; returns the step in seconds. */
  function advance(now) {
    const interval = now - last; last = now;
    const dt = paused ? 0 : Math.min(.05, Math.max(0, interval / 1000));
    elapsed += dt; tap.age += dt;
    gas?.advance(dt);
    const before = scroll;
    scroll += (targetScroll - scroll) * (paused ? 1 : 1 - Math.exp(-dt * (weather ? 5.5 : 9)));
    speed = dt > 0 ? (scroll - before) / dt : 0;
    mouse.x += (aim.x - mouse.x) * (1 - Math.exp(-dt * 8)); mouse.y += (aim.y - mouse.y) * (1 - Math.exp(-dt * 8));
    pointerStrength += (aim.active - pointerStrength) * (1 - Math.exp(-dt * 4));
    if (!paused) pace(interval);
    return dt;
  }
  /** Draws the scene as it stands. */
  function render(dt) {
    gl.useProgram(scene);
    gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
    gl.uniform1f(uniforms.time, elapsed); gl.uniform1f(uniforms.travel, scroll);
    gl.uniform1f(uniforms.progress, scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight));
    gl.uniform1f(uniforms.impulse, speed); gl.uniform3f(uniforms.pointer, mouse.x, mouse.y, pointerStrength);
    gl.uniform3f(uniforms.pulse, tap.x, tap.y, tap.age);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, words); gl.uniform1i(uniforms.words, 0);
    if (gas) {
      // A new grid (or a restored context) needs its textures allocated; after that, only refilled, when the
      // flow has a new picture.
      const fresh = uploaded !== gas, moved = fresh || uploadedVersion !== gas.version;
      for (const [unit, texture, data, uniform] of [[1, mapTexture, gas.mapBytes, uniforms.gasMap], [2, inkTexture, gas.dyeBytes, uniforms.gasInk]]) {
        gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture);
        if (fresh) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gas.cols, gas.rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        else if (moved) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gas.cols, gas.rows, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.uniform1i(uniform, unit);
      }
      gl.uniform2f(uniforms.gasSize, gas.cols, gas.rows);
      uploaded = gas; uploadedVersion = gas.version;
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); pollen(dt); drawCount++;
    if (drawCount === 1) {
      canvas.classList.add("ready");
      if (!miniature) document.documentElement.classList.add("atmosphere-ready");
    }
  }
  function draw(now) {
    frame = 0;
    if (hidden || !visible || lost) return;
    render(advance(now)); dirty = false;
    if (!paused) kick();
  }
  function kick() { if (!frame && !hidden && visible && !lost && (!paused || dirty)) frame = requestAnimationFrame(draw); }

  const surface = miniature ? canvas.parentElement : document;
  surface.addEventListener("pointermove", move, { passive: true });
  surface.addEventListener("pointerdown", press, { passive: true });
  surface.addEventListener("pointerup", release, { passive: true });
  surface.addEventListener("pointerleave", leave, { passive: true });
  surface.addEventListener("pointercancel", leave, { passive: true });
  addEventListener("scroll", pageScroll, { passive: true });
  document.addEventListener("motion", motion); document.addEventListener("visibilitychange", visibility);
  reduce.addEventListener("change", preference);
  new ResizeObserver(size).observe(canvas);
  if (miniature) new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting; last = performance.now();
    if (!visible) { cancelAnimationFrame(frame); frame = 0; } else { dirty = true; kick(); }
  }).observe(canvas);
  canvas.addEventListener("webglcontextlost", event => { event.preventDefault(); lost = true; cancelAnimationFrame(frame); frame = 0; });
  canvas.addEventListener("webglcontextrestored", () => {
    try { init(); } catch (error) { console.error(error); canvas.classList.add("unavailable"); return; }
    lost = false; last = performance.now(); size();
  });
  document.fonts.ready.then(() => {
    if (lost || kind !== "whispers") return;
    gl.deleteTexture(words); words = wordTexture(gl); dirty = true; kick();
  });
  size(); pageScroll(); scroll = targetScroll;
  return { get state() { return { kind, paused, scroll, targetScroll, elapsed, tapAge: tap.age, drawCount, budget, pixels: canvas.width * canvas.height, error: gl.getError(), fluid: gas?.metrics() }; } };
}

export function mountLanding(kind, { preview = false } = {}) {
  document.documentElement.classList.add("atmospheric", `atmosphere-${kind}`);
  const canvas = document.querySelector("#field");
  const particles = kind === "pollen" ? document.createElement("canvas") : null;
  if (particles) { particles.className = "pollen-motes"; canvas.after(particles); }
  const entry = directions[kind];
  if (preview) {
    document.title = `${t(entry.name)} · ${t("Quest atmosphere experiment")}`;
    const robots = document.createElement("meta"); robots.name = "robots"; robots.content = "noindex,nofollow"; document.head.append(robots);
  }
  // The footer's pause stops the weather and starts it again. It hides where nothing moves: under reduced
  // motion, which stops the weather already, and without WebGL, where the CSS glow stands in for it.
  const pause = document.querySelector("#pause");
  const moving = startAtmosphere(canvas, kind, { particles });
  if (pause && moving) {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    const name = () => { pause.textContent = t(pause.dataset.paused === "true" ? "Resume motion ▷" : "Pause motion Ⅱ"); };
    const fit = () => { pause.hidden = reduce.matches; };
    pause.addEventListener("click", () => {
      pause.dataset.paused = String(pause.dataset.paused !== "true");
      name();
      document.dispatchEvent(new CustomEvent("motion", { detail: { paused: pause.dataset.paused === "true" } }));
    });
    reduce.addEventListener("change", fit);
    document.addEventListener("languagechange", name);
    name(); fit();
  }
  if (preview && new URLSearchParams(location.search).get("embedded") !== "1") {
    document.documentElement.classList.add("atmosphere-preview");
    const dock = document.createElement("aside"); dock.className = "experiment-dock"; dock.setAttribute("aria-label", t("Atmosphere experiments"));
    dock.innerHTML = `<a class="lab-back" href="/experiments.html">← ${t("Experiments")}</a><span class="lab-title"><b>${entry.number}</b> ${t(entry.name)}</span><nav aria-label="${t("Choose an experiment")}">${Object.entries(directions).map(([key, item]) => `<a href="/?experiment=${key}" ${key === kind ? 'aria-current="page"' : ''} aria-label="${t(item.name)}">${item.number}</a>`).join("")}</nav><span class="lab-scroll">${t(entry.scroll)} <i>↓</i></span><i class="lab-meter" aria-hidden="true"></i>`;
    document.body.append(dock);
    const meter = () => dock.style.setProperty("--journey", String(scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight)));
    addEventListener("scroll", meter, { passive: true }); meter();
  }
}
