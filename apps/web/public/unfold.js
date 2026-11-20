// The page below the title screen, laid out ahead of the reader. site.css lets the browser leave those sections
// until they're near the screen (content-visibility), so the title screen paints sooner; once the page has loaded,
// this lays them out one at a time, each when the browser is idle, so none is left for the middle of a scroll.
// One already on the screen is left as it is: the browser has laid it out, and switching it would nudge its
// contents by a fraction of a pixel under the reader's eyes.
const later = [...document.querySelectorAll("main > section")].filter((section) => getComputedStyle(section).contentVisibility === "auto");
const idle = window.requestIdleCallback ?? ((then) => setTimeout(then, 50));

const next = () => {
  const section = later.shift();
  if (!section) return;
  const { top, bottom } = section.getBoundingClientRect();
  if (bottom <= 0 || top >= innerHeight) {
    section.style.contentVisibility = "visible";
    section.getBoundingClientRect(); // laid out now, while idle, not in the next frame
  }
  idle(next);
};

if (later.length) {
  if (document.readyState === "complete") idle(next);
  else addEventListener("load", () => idle(next), { once: true });
}
