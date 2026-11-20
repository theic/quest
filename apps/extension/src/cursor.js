/**
 * Quest's cursor and the glow round the page it works in (the founder, 2026-11-11: "a smooth green-glowing cursor that
 * shows what the agent is doing; maybe some edge glow as well"). Injected into a session's page, main frame only.
 *
 * It is drawn inside a closed shadow root on one element under <html>, with no pointer events: the page's own scripts,
 * Quest's reading of the page (browser-page.js walks only open roots) and its clicks never meet it, and what moves
 * moves inside the root, where the wait for a quiet page (domQuiet) does not see it. It is hidden while a picture is
 * taken, so no model sees it, and goes by itself when no step has asked for it for a while.
 *
 * cmd: { kind: "show", from?: {x, y}, x?, y?, press?, label? } | { kind: "hide" } | { kind: "unhide" } | { kind: "remove" }.
 * The colour is the logo's and the site's accent, #ceff32, on its dark #1a230a.
 * Answers where the cursor is now.
 */
export function questOverlay(cmd) {
  const KEY = "__mqOverlay";
  const LIFE_MS = 90000;
  let o = window[KEY];
  if (cmd.kind === "remove" || cmd.kind === "hide" || cmd.kind === "unhide") {
    if (!o) return null;
    if (cmd.kind === "remove") { clearTimeout(o.timer); o.stop?.(); o.host.remove(); delete window[KEY]; return null; }
    o.wrap.style.visibility = cmd.kind === "hide" ? "hidden" : "visible";
    return o.at;
  }
  if (!o || !o.host.isConnected) {
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "all:initial;position:fixed;inset:0;width:0;height:0;pointer-events:none;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      .wrap{position:fixed;inset:0;pointer-events:none;overflow:hidden;contain:strict}
      .glow{position:absolute;inset:0;box-shadow:inset 0 0 32px 7px rgba(206,255,50,.5),inset 0 0 3px 1px rgba(206,255,50,.9);animation:breathe 2.6s ease-in-out infinite}
      .hand{position:absolute;left:0;top:0;will-change:transform}
      .tilt{transform-origin:4px 4px;transition:transform .18s ease-out}
      .halo{position:absolute;left:-14px;top:-14px;width:36px;height:36px;border-radius:50%;background:radial-gradient(circle,rgba(206,255,50,.45),rgba(206,255,50,0) 70%);animation:halo 1.8s ease-in-out infinite}
      .cur{position:absolute;left:-4px;top:-4px;width:36px;height:36px;filter:drop-shadow(0 0 7px rgba(206,255,50,.95)) drop-shadow(0 2px 10px rgba(0,0,0,.35))}
      .say{position:absolute;left:30px;top:26px;max-width:260px;padding:5px 11px 5px 9px;border-radius:999px;background:#1a230af2;color:#eef7d6;border:1px solid rgba(206,255,50,.55);
        font:600 12.5px/1.25 "DM Sans","Segoe UI",system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 6px 18px rgba(0,0,0,.35);
        display:flex;align-items:center;gap:7px;opacity:0;transform:translateY(4px);transition:opacity .2s,transform .2s}
      .say.on{opacity:1;transform:none}
      .say i{width:7px;height:7px;border-radius:50%;background:#ceff32;flex:none;animation:halo 1.2s ease-in-out infinite}
      .say span{overflow:hidden;text-overflow:ellipsis}
      .ring{position:absolute;left:0;top:0;width:48px;height:48px;margin:-24px 0 0 -24px;border-radius:50%;border:3px solid rgba(206,255,50,.95);opacity:0}
      .ring.on{animation:press .55s ease-out}
      @keyframes breathe{0%,100%{opacity:.55}50%{opacity:1}}
      @keyframes halo{0%,100%{opacity:.5;scale:.85}50%{opacity:1;scale:1.15}}
      @keyframes press{0%{opacity:.95;scale:.25}100%{opacity:0;scale:1.5}}
      @media (prefers-reduced-motion:reduce){.glow,.halo,.say i{animation:none}.tilt{transition:none}}
    </style><div class="wrap"><div class="glow"></div><div class="ring"></div>
      <div class="hand"><div class="tilt"><div class="halo"></div>
        <svg class="cur" viewBox="0 0 26 26"><path d="M3 3 L3 20 L8 15.5 L11.5 23 L14.5 21.6 L11 14.2 L18 14 Z" fill="#ceff32" stroke="#1a230a" stroke-width="1.3" stroke-linejoin="round"/></svg>
      </div><div class="say"><i></i><span></span></div></div></div>`;
    const wrap = root.querySelector(".wrap");
    const hand = root.querySelector(".hand");
    const ring = root.querySelector(".ring");
    const bubble = root.querySelector(".say");
    const tilt = root.querySelector(".tilt");
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const at = cmd.from && cmd.from.x >= 0 && cmd.from.y >= 0 ? { x: cmd.from.x, y: cmd.from.y } : { x: Math.round(innerWidth * 0.6), y: Math.round(innerHeight * 0.55) };
    // Where the hand is drawn now (it glides, so not always at `at`), and the glide under way.
    const pos = { x: at.x, y: at.y };
    const put = (x, y) => { pos.x = x; pos.y = y; hand.style.transform = `translate(${x}px,${y}px)`; };
    put(at.x, at.y);
    let frame = 0;
    let idle = 0;
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    /**
     * Glides along a gentle arc, slow at both ends and quick in the middle, leaning the way it goes, like a hand and not
     * a slide on a rail; a far move takes longer. `done` runs as it arrives.
     */
    const glide = (x, y, ms, bend, done) => {
      cancelAnimationFrame(frame);
      const fx = pos.x, fy = pos.y, dx = x - fx, dy = y - fy, d = Math.hypot(dx, dy);
      if (calm || d < 1 || document.hidden) { put(x, y); tilt.style.transform = ""; done?.(); return; }
      const off = Math.min(90, d * bend) * (Math.random() < 0.5 ? -1 : 1);
      const cx = fx + dx / 2 - (dy / d) * off, cy = fy + dy / 2 + (dx / d) * off;
      const t0 = performance.now();
      let lx = fx;
      const step = (now) => {
        const t = Math.min(1, (now - t0) / ms), e = ease(t), u = 1 - e;
        const nx = u * u * fx + 2 * u * e * cx + e * e * x, ny = u * u * fy + 2 * u * e * cy + e * e * y;
        put(nx, ny);
        const lean = Math.max(-14, Math.min(14, (nx - lx) * 1.4));
        lx = nx;
        tilt.style.transform = t < 1 ? `rotate(${-6 + lean}deg) scale(${1 + Math.min(0.08, d / 6000)})` : "";
        if (t < 1) frame = requestAnimationFrame(step);
        else done?.();
      };
      frame = requestAnimationFrame(step);
    };
    /** Between steps the hand is never quite still: it drifts a few pixels round where it last went, as a resting hand does. */
    const rest = () => {
      clearTimeout(idle);
      if (calm) return;
      idle = setTimeout(() => {
        if (document.hidden || wrap.style.visibility === "hidden") return rest();
        const a = Math.random() * Math.PI * 2, r = 3 + Math.random() * 9;
        glide(o.at.x + Math.cos(a) * r, o.at.y + Math.sin(a) * r, 700 + Math.random() * 700, 0.4, rest);
      }, 900 + Math.random() * 1800);
    };
    o = window[KEY] = {
      host, wrap, at, timer: 0,
      /** Glides to a point of the viewport; with `press`, a ring opens there as it arrives. */
      move(x, y, press) {
        const px = Math.max(0, Math.min(innerWidth - 4, Math.round(x)));
        const py = Math.max(0, Math.min(innerHeight - 4, Math.round(y)));
        o.at = { x: px, y: py };
        // The label keeps inside the window: on the cursor's left near the right edge.
        bubble.style.left = px > innerWidth - 300 ? "auto" : "30px";
        bubble.style.right = px > innerWidth - 300 ? "14px" : "auto";
        clearTimeout(idle);
        const d = Math.hypot(px - pos.x, py - pos.y);
        // A click by sight waits 300 ms for the hand, so a press arrives sooner than a plain move.
        const ms = Math.round(Math.max(press ? 240 : 320, Math.min(press ? 520 : 820, 220 + d * 0.55)));
        glide(px, py, ms, 0.16, () => {
          rest();
          if (!press) return;
          ring.style.transform = `translate(${px}px,${py}px)`;
          ring.classList.remove("on");
          void ring.offsetWidth;
          ring.classList.add("on");
        });
      },
      stop() { cancelAnimationFrame(frame); clearTimeout(idle); },
      /** What Quest does now, in a few words beside the cursor (the founder, 2026-11-16: "the live status ... near the cursor like in Claude's extension"). */
      say(text) {
        const t = String(text ?? "").trim();
        bubble.querySelector("span").textContent = t;
        bubble.classList.toggle("on", Boolean(t));
      },
    };
    (document.documentElement ?? document.body)?.append(host);
  }
  clearTimeout(o.timer);
  o.timer = setTimeout(() => { o.stop?.(); o.host.remove(); if (window[KEY] === o) delete window[KEY]; }, LIFE_MS);
  o.wrap.style.visibility = "visible";
  if (typeof cmd.label === "string") o.say(cmd.label);
  if (typeof cmd.x === "number" && typeof cmd.y === "number") o.move(cmd.x, cmd.y, Boolean(cmd.press));
  return o.at;
}
