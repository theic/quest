// The product video under the title (index.html, #watch): our own file, started once the page has loaded and
// a good part of it is on the screen, so the title paints first and a phone decodes no video nobody is watching
// (Lighthouse's throttled phone spent 2 s of its main thread on a video started early). It plays muted, because browsers start a video by
// themselves only without sound, and loops. A click on the picture opens it big over the page, as X opens a post's
// video, with the sound on (the first time, from the start, so nothing is missed); the speaker says so in words, and
// turns the sound on or off by itself. Open, a click on the picture pauses it and plays it again, with a play mark
// while it's paused; the cross, Escape or a click beside it puts it back in the post. The line along the bottom shows how far it is, and a drag, a click or the arrow
// keys on it take the video there. Off screen a muted video waits; with reduced motion it waits for a
// click. With no script the browser's own controls stay.

const frame = document.querySelector(".watch-frame");
const video = frame?.querySelector("video");

if (frame && video) {
  const sound = frame.querySelector(".sound");
  const hit = frame.querySelector(".watch-hit");
  const seek = frame.querySelector(".watch-seek");
  const shut = frame.querySelector(".watch-close");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let inView = false;
  let loaded = document.readyState === "complete";
  let stopped = reduce; // paused by the visitor (or waiting for a first click, with reduced motion)
  let heard = false; // the visitor has turned the sound on at least once

  video.controls = false;
  sound.hidden = false;
  hit.hidden = false;
  seek.hidden = false;
  const sync = () => {
    sound.setAttribute("aria-checked", String(!video.muted));
    hit.setAttribute("aria-pressed", String(stopped));
  };
  for (const event of ["play", "pause", "volumechange"]) video.addEventListener(event, sync);
  sync();

  const play = () => video.play().catch(() => {});
  /** Plays when it's in view and nobody stopped it; a muted video waits off screen, one with sound plays on. */
  const fit = () => {
    if (stopped || !loaded) return;
    if (inView) play();
    else if (video.muted && !video.paused) video.pause();
  };

  const unmute = () => {
    if (!heard) video.currentTime = 0;
    heard = true;
    video.muted = false;
    if (video.volume < 0.3) video.volume = 0.8;
    stopped = false;
    play();
    sync();
  };
  sound.addEventListener("click", () => {
    if (video.muted) return unmute();
    video.muted = true;
    sync();
  });
  const open = (on) => {
    frame.classList.toggle("watch-open", on);
    document.documentElement.classList.toggle("watching", on);
    if (shut) shut.hidden = !on;
  };
  shut?.addEventListener("click", () => open(false));
  addEventListener("keydown", (event) => { if (event.key === "Escape") open(false); });
  // A click beside the open video closes it, and does nothing else.
  addEventListener("click", (event) => {
    if (!frame.classList.contains("watch-open") || frame.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    open(false);
  }, true);
  hit.addEventListener("click", () => {
    if (!frame.classList.contains("watch-open")) {
      open(true);
      if (video.muted || stopped || video.paused) unmute();
      return;
    }
    if (video.muted) return unmute();
    stopped = !stopped;
    if (stopped) video.pause();
    else play();
    sync();
  });

  // The line follows the video a frame at a time while it plays, and leads it while the visitor holds the handle.
  let held = false;
  let frameId = 0;
  const mark = () => {
    frameId = 0;
    if (!held && video.duration) seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
    seek.style.setProperty("--at", `${seek.value / 10}%`);
    if (!video.paused) frameId = requestAnimationFrame(mark);
  };
  for (const event of ["play", "seeked", "timeupdate"]) video.addEventListener(event, () => { if (!frameId) mark(); });
  seek.addEventListener("pointerdown", () => { held = true; });
  for (const event of ["pointerup", "pointercancel", "change"]) seek.addEventListener(event, () => { held = false; });
  seek.addEventListener("input", () => {
    if (video.duration) video.currentTime = (seek.value / 1000) * video.duration;
    seek.style.setProperty("--at", `${seek.value / 10}%`);
  });

  if (!loaded) addEventListener("load", () => { loaded = true; fit(); }, { once: true });
  new IntersectionObserver(([entry]) => {
    inView = entry.intersectionRatio >= 0.4;
    fit();
  }, { threshold: 0.4 }).observe(frame);
}
