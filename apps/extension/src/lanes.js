/**
 * How this Chrome takes Quest's work: several jobs at once, each in a tab of its own, as many as the agent asks for
 * (its `x-mq-tabs`). The agent keeps each site's pace and never hands two pages of one site at once (chrome/broker.ts);
 * what is here is the floor under it, should an agent ever ask too fast, and the order things are done in.
 *
 * Nothing here calls Chrome, so the tests run it as it is.
 */

/** The most jobs this Chrome takes at once, whatever an agent says. */
export const MAX_TABS = 4;

/** Between one page and the next, alone: a reader's pace, not a crawler's. Slower on communities that watch for bots. */
export const GAP_MS = [2500, 5000];
export const SLOW_GAP_MS = [8000, 15000];
export const SLOW_HOSTS = /(^|\.)(reddit\.com)$/i;
/** With several tabs, the agent paces each site; this is the least between two pages of one host here. */
export const HOST_FLOOR_MS = 2000;

/** How many pollers the agent's answer asks for: one when it says nothing, as an agent from before several tabs does. */
export function tabsFrom(header) {
  const n = Number(header);
  return Number.isInteger(n) && n >= 1 ? Math.min(MAX_TABS, n) : 1;
}

/**
 * One at a time: each call starts once the one before it ended, whether that one worked or not, or once it has had
 * `maxMs`: a call that never ends must not stop every call after it.
 */
export function oneAtATime(maxMs = 0) {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    const ended = run.then(
      () => undefined,
      () => undefined,
    );
    tail = maxMs ? Promise.race([ended, new Promise((r) => setTimeout(r, maxMs))]) : ended;
    return run;
  };
}

/**
 * When the next page on `host` may open. Alone (one tab), the pause counts from the last page on any site, as it
 * always has; with several tabs, only from the last page on this host, by the floor.
 */
export function nextNavAt({ now, host, lastAny, lastHost, alone, random = Math.random }) {
  const slow = SLOW_HOSTS.test(host ?? "");
  if (alone) {
    const [lo, hi] = slow ? SLOW_GAP_MS : GAP_MS;
    return Math.max(now, (lastAny || 0) + lo + random() * (hi - lo));
  }
  return Math.max(now, (lastHost || 0) + (slow ? SLOW_GAP_MS[0] : HOST_FLOOR_MS));
}

const VISUAL = new Set(["click_point", "move_point", "type_text", "press_focused", "scroll_point"]);

/**
 * Whether a browser session's step needs its tab in front: "input" for a picture or input by sight, which reach only
 * a tab Chrome draws, in a window that has the keyboard (not done at all without it); "type" for a fill, which types
 * with trusted keys into a rich editor and is best done in front (done in the background when it may not come up);
 * "drawn" on a site whose pages show their posts only while drawn (the agent says so, `drawn`); null for the rest,
 * which read and act in the background. An agent from before sends no `drawn`, and every step came to the front for it.
 */
export function frontFor(job) {
  const kind = job?.action?.kind;
  if (VISUAL.has(kind) || kind === "screenshot" || kind === "shot") return "input";
  if (kind === "fill") return "type";
  if (kind === "close") return null;
  return job?.drawn === false ? null : "drawn";
}

/** Whether Quest's tab may come to the front: their switch in the popup, and the one on their page (the agent's word). */
export const mayFront = ({ local, agent }) => local !== false && agent !== false;
