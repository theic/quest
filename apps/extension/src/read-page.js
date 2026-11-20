/**
 * What runs inside the page Quest opened. Chrome copies each function into the
 * page on its own (chrome.scripting.executeScript), so each must stand alone:
 * no imports, nothing from this module's scope.
 *
 * The page is only read. Nothing here clicks, types, scrolls or changes it.
 */

/**
 * Reads the page: its title and description, its text, its links, and the rows
 * each spec asks for. A spec is `{ items, limit, fields }`; each field is
 * `attr:<name>`, `attr:<name>@<selector>`, `text`, `text:<selector>`, `href`,
 * `href:<selector>`, `tag`, or several joined by `|` (the first that answers).
 * Selectors look through open shadow roots too.
 */
export function readPage(take) {
  const MAX_TEXT = 60000;
  const MAX_FIELD = 4000;
  // What the agent accepts (apps/agent/src/http/chrome-outcome.ts): one field over its limit and the whole read is refused.
  const MAX_TITLE = 1000;
  const MAX_DESCRIPTION = 2000;
  const MAX_URL = 4000;
  const want = take && typeof take === "object" ? take : {};

  const squash = (s) => String(s ?? "").replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  const meta = (sel) => {
    const v = document.querySelector(sel)?.getAttribute("content");
    return v && v.trim() ? v.trim() : null;
  };
  const absolute = (h) => {
    if (!h) return null;
    try {
      return new URL(h, location.href).href;
    } catch {
      return null;
    }
  };

  // Every root to search: the document and each open shadow root under it.
  const roots = [document];
  for (let i = 0; i < roots.length && roots.length < 2000; i++) {
    for (const el of roots[i].querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
  }
  const all = (sel) => {
    const found = [];
    const seen = new Set();
    for (const r of roots) {
      for (const el of r.querySelectorAll(sel)) {
        if (!seen.has(el)) {
          seen.add(el);
          found.push(el);
        }
      }
    }
    return found;
  };
  const inside = (el, sel) => {
    try {
      return el.querySelector(sel) ?? (el.shadowRoot ? el.shadowRoot.querySelector(sel) : null);
    } catch {
      return null;
    }
  };
  const textOf = (el) => squash(el?.innerText || el?.textContent).slice(0, MAX_FIELD);
  const field = (el, how) => {
    const h = String(how ?? "");
    if (h.includes("|")) {
      for (const part of h.split("|")) {
        const v = field(el, part.trim());
        if (v !== null && v !== undefined && v !== "") return v;
      }
      return null;
    }
    if (h === "text") return textOf(el);
    if (h === "href") return absolute(el.getAttribute("href"));
    if (h === "tag") return el.tagName.toLowerCase();
    let m = /^attr:([^@]+)@(.+)$/.exec(h);
    if (m) return inside(el, m[2])?.getAttribute(m[1]) ?? null;
    m = /^attr:(.+)$/.exec(h);
    if (m) return el.getAttribute(m[1]);
    m = /^text:(.+)$/.exec(h);
    if (m) {
      const d = inside(el, m[1]);
      return d ? textOf(d) : null;
    }
    m = /^href:(.+)$/.exec(h);
    if (m) return absolute(inside(el, m[1])?.getAttribute("href"));
    return null;
  };

  /** @type {Record<string, Record<string, unknown>[]>} */
  const rows = {};
  for (const [name, spec] of Object.entries(want.specs ?? {})) {
    const limit = Math.max(1, Math.min(500, Number(spec?.limit) || 100));
    let items = [];
    try {
      items = all(String(spec?.items ?? "")).slice(0, limit);
    } catch {
      items = [];
    }
    rows[name] = items.map((el) => {
      const row = {};
      for (const [k, how] of Object.entries(spec?.fields ?? {})) {
        const v = field(el, how);
        row[k] = typeof v === "string" ? v.slice(0, MAX_FIELD) : v;
      }
      return row;
    });
  }

  let text = "";
  if (want.text) {
    const body = document.body;
    text = squash(body?.innerText || body?.textContent).replace(/\n{3,}/g, "\n\n").slice(0, MAX_TEXT);
  }

  const links = [];
  if (want.links) {
    for (const a of Array.from(document.querySelectorAll("a[href]")).slice(0, 300)) {
      const href = absolute(a.getAttribute("href"));
      // A link cut short leads nowhere, so a longer one (a data: address, a tracking link) is left out.
      if (href && href.length <= MAX_URL) links.push({ href, text: squash(a.textContent).slice(0, 80) });
    }
  }

  return {
    url: location.href.slice(0, MAX_URL),
    title: squash(document.title).slice(0, MAX_TITLE),
    description: (meta('meta[name="description"]') ?? meta('meta[property="og:description"]'))?.slice(0, MAX_DESCRIPTION) ?? null,
    text,
    links,
    rows,
  };
}

/** Whether the page has what the reader waits for yet, and whether Chrome is drawing it. */
export function probePage(selector) {
  let found = false;
  if (selector) {
    const roots = [document];
    for (let i = 0; i < roots.length && roots.length < 2000; i++) {
      for (const el of roots[i].querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
    }
    try {
      found = roots.some((r) => r.querySelector(selector) !== null);
    } catch {
      found = false;
    }
  }
  return { found, visible: document.visibilityState === "visible" };
}
