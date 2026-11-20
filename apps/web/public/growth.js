import { ready, t } from "/i18n/browser.js";
// The title (index.html, #top): the founder's post about Quest, a sentence a line.
// The page is served with it in English; here it is written in the reader's language, with the numbers the page
// came with (growth.json's "week"; the tests hold the two together). Left alone when it already reads right.
const TITLE = "<span>This is Quest, a growth hire for solo founders.</span> <span>It works in my browser. Last week it started {started} conversations and {back} people wrote back.</span>";
const title = document.querySelector("#hero-h");
function headline() {
  const next = document.createElement("template");
  next.innerHTML = t(TITLE, { ...title.dataset });
  if (next.content.textContent === title.textContent) return;
  title.replaceChildren(next.content);
}
if (title) {
  ready.then(headline);
  document.addEventListener("languagechange", headline);
}

// The gallery (#replies): a row of slides that rolls by itself, one slide every few seconds, and goes back to the
// first after the last. Still while the pointer or the keyboard is on it, for a while after the reader scrolls it
// themselves, while the tab is hidden, and for a reader who asked for less motion.
const track = document.querySelector("#replies .reel-track");
const still = matchMedia("(prefers-reduced-motion: reduce)");
let theirs = 0;
function roll() {
  if (document.hidden || still.matches || Date.now() < theirs || track.matches(":hover, :focus-within")) return;
  const step = track.children[1].offsetLeft - track.children[0].offsetLeft;
  const at = Math.abs(track.scrollLeft);
  const last = at + track.clientWidth >= track.scrollWidth - 4;
  track.scrollTo({ left: last ? 0 : Math.sign(step) * (at + Math.abs(step)), behavior: "smooth" });
}
if (track && track.children.length > 1) {
  for (const touch of ["pointerdown", "touchstart", "wheel"]) track.addEventListener(touch, () => { theirs = Date.now() + 8000; }, { passive: true });
  setInterval(roll, 3500);
}
