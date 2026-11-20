// Signal weather is the landing. Explicit experiment URLs keep the other studies reviewable.
// It starts once the page has loaded, so its scripts, the GPU's program and the flow's worker never stand between
// the visitor and the words; until then the bed's glow (atmosphere.css) stands in, and the weather fades in over it.
// Where it would cost the page its smoothness it never starts, and the glow stays: on a phone or tablet, with data
// saving on, on 4 cores or 4 GB or fewer, and on a machine whose frames already run late before it starts (measured
// over half a second once the page has loaded). Lighthouse's phone, throttled 4x, spent 15.6 s of CPU on it.
const direction = new URLSearchParams(location.search).get("experiment");
const preview = ["weather", "whispers", "pollen"].includes(direction);
const start = () => import("./atmosphere.js").then(({ mountLanding }) => mountLanding(preview ? direction : "weather", { preview }));

const light = () => {
  const n = navigator;
  return document.documentElement.dataset.device === "phone" || n.connection?.saveData === true
    || (n.hardwareConcurrency ?? 8) <= 4 || (n.deviceMemory ?? 8) <= 4;
};
/** Half a second of frames: does this machine keep up with the page alone? */
const smooth = () => new Promise((resolve) => {
  const gaps = [];
  let last = performance.now();
  const frame = (now) => {
    gaps.push(now - last);
    last = now;
    if (gaps.length < 30) requestAnimationFrame(frame);
    else resolve(gaps.slice(2).sort((a, b) => a - b)[Math.floor((gaps.length - 2) / 2)] < 24);
  };
  requestAnimationFrame(frame);
});
const go = async () => {
  if (preview) return start();
  if (light() || !(await smooth())) return;
  start();
};
if (document.readyState === "complete") go();
else addEventListener("load", go, { once: true });
