import { ready, t } from "/i18n/browser.js";
await ready;
import { startAtmosphere } from "./atmosphere.js";
for (const canvas of document.querySelectorAll("[data-atmosphere]")) {
  startAtmosphere(canvas, canvas.dataset.atmosphere, { miniature: true, particles: canvas.parentElement.querySelector(".pollen-motes") });
}
const pause = document.querySelector("#lab-pause");
if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
  pause.setAttribute("aria-pressed", "true"); pause.textContent = t("Motion reduced"); pause.disabled = true;
}
pause.addEventListener("click", () => {
  const paused = pause.getAttribute("aria-pressed") !== "true";
  pause.setAttribute("aria-pressed", String(paused));
  pause.textContent = t(paused ? "Resume motion ▷" : "Pause motion Ⅱ");
  document.dispatchEvent(new CustomEvent("motion", { detail: { paused } }));
});
