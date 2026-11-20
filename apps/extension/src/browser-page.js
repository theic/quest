/**
 * Waits until the page stops changing: nothing added or removed for `quietMs` once it has loaded, or `maxMs` at
 * most (a page with a ticker never goes quiet). Injected after every action, in place of a fixed pause: a reply
 * box that opens in 200 ms is not waited on for a second, and a feed that answers in three is not read half drawn.
 * Self-contained: Chrome serializes this function.
 */
export function domQuiet(maxMs = 3000, quietMs = 400) {
  return new Promise((resolve) => {
    const started = Date.now();
    let last = started;
    const observer = new MutationObserver(() => { last = Date.now(); });
    observer.observe(document, { subtree: true, childList: true, characterData: true });
    // The page is going away (a click navigated it): nothing more to wait for here.
    window.addEventListener("pagehide", () => { observer.disconnect(); resolve(Date.now() - started); }, { once: true });
    const check = () => {
      const now = Date.now();
      if ((now - last >= quietMs && document.readyState === "complete") || now - started >= maxMs) {
        observer.disconnect();
        resolve(now - started);
      } else setTimeout(check, 100);
    };
    setTimeout(check, Math.min(quietMs, 150));
  });
}

/**
 * Scrolls what scrolls the page (the window, or the largest pane a web app scrolls instead) by most of a screen,
 * and at the end of a feed that draws more as it is neared, waits for it to grow, up to `maxWaitMs`.
 * Self-contained: Chrome serializes this function.
 */
/**
 * A list's own "Load more" pressed, where it has one, and a moment for the rows it brings: LinkedIn's search shows
 * about 3 posts and then that button (live, 2026-11-11). Only a button that pages a list, by its words or LinkedIn's
 * own class; nothing else is clicked. Answers whether it pressed one and whether the page grew.
 * Self-contained: Chrome serializes this function.
 */
export async function loadMore(maxWaitMs = 3000) {
  const size = () => document.body?.innerText.length ?? 0;
  const before = size();
  const words = /^(load more|show more results|see more results|show more posts|показати більше|показать ещё|mehr laden|cargar más|charger plus)$/i;
  const button =
    document.querySelector(".scaffold-finite-scroll__load-button") ??
    [...document.querySelectorAll("button")].find((b) => words.test((b.innerText || "").trim()) && b.getClientRects().length && !b.disabled);
  if (!button) return { pressed: false, grew: false };
  button.scrollIntoView({ block: "center" });
  button.click();
  const started = Date.now();
  while (Date.now() - started < maxWaitMs && size() <= before + 80) await new Promise((r) => setTimeout(r, 250));
  return { pressed: true, grew: size() > before + 80 };
}

export async function scrollPage(direction = "down", maxWaitMs = 4000) {
  let s = document.scrollingElement ?? document.documentElement;
  if (s.scrollHeight <= s.clientHeight + 1) {
    let best = 0;
    for (const el of document.querySelectorAll("*")) {
      if (el.scrollHeight <= el.clientHeight + 1 || !/auto|scroll/.test(getComputedStyle(el).overflowY) || !el.getClientRects().length) continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > best) { best = area; s = el; }
    }
  }
  const top = s.scrollTop;
  const height = s.scrollHeight;
  const step = Math.max(300, Math.round((s.clientHeight || window.innerHeight) * 0.85));
  s.scrollBy({ top: direction === "up" ? -step : step, behavior: "instant" });
  const atEnd = () => s.scrollTop + s.clientHeight >= s.scrollHeight - 4;
  const started = Date.now();
  if (direction !== "up" && atEnd()) {
    while (Date.now() - started < maxWaitMs && s.scrollHeight <= height) await new Promise((r) => setTimeout(r, 250));
  }
  return { moved: Math.round(s.scrollTop - top), grew: s.scrollHeight > height, atEnd: atEnd() };
}

/** Injected into each accessible frame. Self-contained: Chrome serializes this function.
 * @param {import("../../../packages/core/src/browser.ts").BrowserAction & { trusted?: boolean, hand?: boolean }} action A fill with `trusted` leaves a rich editor focused for the extension to type into; with `hand`, a press, a key or a plain field's words are left for the extension's real input.
 * @returns {any} The page's view, or what an action did, or why it could not.
 */
export function browserPage(action = { kind: "snapshot" }) {
  const key = "__mqBrowserView";
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const hasWords = (s) => /\p{L}|\p{N}/u.test(s);
  // An icon button (a heart, a bell) says what it is on the picture inside it: its aria-label, title or alt.
  const inner = (el) => {
    const named = el.querySelector?.("[aria-label],[title],img[alt],svg title");
    return named ? clean(named.getAttribute("aria-label") || named.getAttribute("title") || named.getAttribute("alt") || named.textContent) : "";
  };
  const label = (el) => {
    const labelled = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).map(id => el.ownerDocument.getElementById(id)?.textContent ?? "").join(" ");
    const nearby = /INPUT|TEXTAREA/.test(el.tagName) || el.getAttribute("contenteditable") === "true" ? clean(el.parentElement?.textContent) : "";
    const words = clean(el.getAttribute("aria-label") || labelled.trim() || el.labels?.[0]?.textContent || el.getAttribute("placeholder") || el.getAttribute("data-placeholder") || el.getAttribute("title") || el.getAttribute("data-tooltip") || (nearby.length <= 100 ? nearby : "") || el.innerText || el.textContent);
    // A count alone ("2" on Threads' heart once a post has likes) does not say what the button does: the picture's name
    // comes first, "Like 2", then "Unlike 3". Live, 2026-11-04: a Threads post's own heart read "2", and its like went
    // to a reply's heart, the first that read "Like".
    const count = /^\d[\d.,\s]*(?:[KMkm]|тис\.?|млн)?$/u.test(words);
    const icon = count || !hasWords(words) ? inner(el) : "";
    if (count) return (hasWords(icon) ? `${icon} ${words}` : words).slice(0, 300);
    if (hasWords(words)) return words.slice(0, 300);
    return (hasWords(icon) ? icon : `${words} ${el.getAttribute("data-testid") ?? ""} ${el.id} ${el.className}`).trim().slice(0, 300);
  };
  const role = (el) => (el.getAttribute("role") || (el.type === "search" ? "searchbox" : /INPUT|TEXTAREA/.test(el.tagName) || el.isContentEditable || el.getAttribute("contenteditable") === "true" ? "textbox" : el.tagName.toLowerCase())).slice(0, 100);
  const sensitive = (el) => el.type === "password" || /password|one-time-code|cc-number|cc-csc/i.test(el.autocomplete ?? "") || el.type === "file";
  /** Drawn at all: not hidden, not see-through, wherever it is on the page. */
  const rendered = (el) => {
    const win = el.ownerDocument.defaultView;
    const style = win.getComputedStyle(el);
    return !el.hidden && el.getAttribute("aria-hidden") !== "true" && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };
  /** On screen now: what can be clicked. */
  const visible = (el) => {
    const win = el.ownerDocument.defaultView;
    return rendered(el) && Array.from(el.getClientRects()).some(r => r.bottom > 0 && r.top < win.innerHeight && r.right > 0 && r.left < win.innerWidth);
  };
  /**
   * Where a real press lands on the control, in the tab's own coordinates (through any same-origin frames it sits in):
   * the centre of its part on screen, or another spot of it, whichever the page shows the control itself at (a dialog
   * or a banner over it would take the press). Null when no spot of it is on top: then the script's press, as before.
   */
  const pressPoint = (el) => {
    const win = el.ownerDocument.defaultView;
    const r = Array.from(el.getClientRects()).find(b => b.bottom > 0 && b.top < win.innerHeight && b.right > 0 && b.left < win.innerWidth && b.width > 0 && b.height > 0);
    if (!r) return null;
    const left = Math.max(r.left, 0), right = Math.min(r.right, win.innerWidth), top = Math.max(r.top, 0), bottom = Math.min(r.bottom, win.innerHeight);
    const root = el.getRootNode();
    const finder = typeof root.elementFromPoint === "function" ? root : el.ownerDocument;
    const ours = (hit) => { for (let at = hit; at; at = at.parentElement ?? at.getRootNode?.().host ?? null) if (at === el) return true; return false; };
    let spot = null;
    for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7]]) {
      const x = left + (right - left) * fx, y = top + (bottom - top) * fy;
      if (ours(finder.elementFromPoint(x, y))) { spot = { x, y }; break; }
    }
    if (!spot) return null;
    // Same-origin frames (a mail composer's editor) are measured from the tab's corner; another origin's frame is not.
    for (let w = win; w !== w.top; w = w.parent) {
      let frame = null;
      try { frame = w.frameElement; } catch { return null; }
      if (!frame) return null;
      const f = frame.getBoundingClientRect();
      spot = { x: spot.x + f.left + frame.clientLeft, y: spot.y + f.top + frame.clientTop };
    }
    return { x: Math.round(spot.x), y: Math.round(spot.y) };
  };
  /** Drawn, and from a screen above where the page is scrolled down: the words to read. */
  const readable = (el) => {
    const win = el.ownerDocument.defaultView;
    return rendered(el) && Array.from(el.getClientRects()).some(r => r.bottom > -win.innerHeight && r.right > 0 && r.left < win.innerWidth && (r.width > 0 || r.height > 0));
  };
  const roots = [document];
  for (let i = 0; i < roots.length; i++) for (const el of roots[i].querySelectorAll("*")) {
    if (el.shadowRoot) roots.push(el.shadowRoot);
    // Mail composers commonly use same-origin about:blank/srcdoc editor frames.
    if (el.tagName === "IFRAME" && visible(el)) {
      try { if (el.contentDocument && /^about:/.test(el.contentDocument.URL) && !roots.includes(el.contentDocument)) roots.push(el.contentDocument); } catch { /* other origins are inspected by the extension in their own frames */ }
    }
  }
  const signature = (el) => `${role(el)}|${label(el)}|${el.getAttribute("href") ?? ""}`;
  if (action.kind !== "snapshot") {
    const state = window[key];
    const [revision, id] = String(action.ref ?? "").split(":");
    const saved = state?.nodes?.[Number(id)];
    if (!saved || revision !== state.revision || state.url !== location.href || !saved.el.isConnected || signature(saved.el) !== saved.signature || !visible(saved.el)) {
      return { error: "stale", message: "The page changed. Inspect it again before acting." };
    }
    const el = saved.el;
    if (sensitive(el) || el.disabled || el.getAttribute("aria-disabled") === "true") return { error: "refused", message: "That control is protected or disabled. The customer handles signing in." };
    // Consume the reference before acting, including failed actions: never repeat a send blindly.
    delete window[key];
    el.scrollIntoView?.({ block: "center" });
    el.focus();
    // Quest's cursor (cursor.js), when this page has one, glides to the control as it is used: seen, never waited on.
    if (window === window.top && action.kind !== "scroll") {
      const r = el.getBoundingClientRect();
      const what = String(label(el) || "").replace(/\s+/g, " ").trim().slice(0, 40);
      const verb = action.kind === "fill" ? "Typing" : action.kind === "select" ? "Choosing" : "Clicking";
      try {
        window.__mqOverlay?.say?.(what ? `${verb} “${what}”` : verb);
        window.__mqOverlay?.move(r.left + Math.min(r.width / 2, 120), r.top + r.height / 2, action.kind === "click" || action.kind === "press");
      } catch { /* only a picture of the work */ }
    }
    switch (action.kind) {
      case "click":
        if (el.tagName === "A" && el.href && !/^https?:/.test(el.href)) return { error: "refused", message: "Only web navigation is supported." };
        // A link that opens a new tab opens in this one: the session works in its own tab, and a tab of its own
        // left behind would leave it reading the old page.
        if (el.tagName === "A" && el.href && el.target === "_blank") { location.assign(el.href); break; }
        // With a hand on the tab (`hand`: drawn, visual controls on), the press is the browser's own, at a point of the
        // control nothing covers: the extension makes it (browser-visual.js, holdInput).
        if (action.hand) {
          const point = pressPoint(el);
          if (point) return { acted: true, press: point, ...(window.__mqOverlay?.at ? { at: window.__mqOverlay.at } : {}) };
        }
        // The whole press, as a hand makes it: some pages act on the button going down, never on the click (live,
        // 2026-11-13: a chat in Telegram Web's list opens on mousedown, so a click alone left the page as it was and
        // no run ever read a group).
        {
          const r = el.getBoundingClientRect();
          const at = { bubbles: true, cancelable: true, composed: true, view: el.ownerDocument.defaultView, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
          for (const [type, buttons] of [["pointerdown", 1], ["mousedown", 1], ["pointerup", 0], ["mouseup", 0]]) {
            const Kind = type.startsWith("pointer") ? PointerEvent : MouseEvent;
            el.dispatchEvent(new Kind(type, { ...at, buttons, ...(type.startsWith("pointer") ? { pointerId: 1, pointerType: "mouse", isPrimary: true } : {}) }));
          }
        }
        if (el.isConnected) el.click();
        break;
      case "fill": {
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
          // A script's value skips a field's maxlength, and the site then refuses or cuts it (live, 2026-10-15: a
          // 174-character bio for X's 160): the words are never put in a field too short for them.
          if (el.maxLength > 0 && action.text.length > el.maxLength) return { error: "refused", message: `This field takes at most ${el.maxLength} characters, and the words have ${action.text.length}. Nothing was typed.` };
          // Typed by the browser's own keys where a hand is on the tab: a value set by script is not seen by a page
          // that keeps its own copy (live, 2026-11-13: Mastodon's reply box kept only its "@name " three times). The
          // mentions a reply box opens with stay in front of the words, so the reply still reaches them.
          const opened = /^(?:@[\w.@-]+\s+)+$/.test(el.value) && !action.text.trimStart().startsWith("@") ? el.value.replace(/\s*$/, " ") : "";
          const text = opened + action.text;
          if (el.maxLength > 0 && text.length > el.maxLength) return { error: "refused", message: `This field takes at most ${el.maxLength} characters, and the words have ${text.length}. Nothing was typed.` };
          if (action.hand) return { acted: true, type: true, text };
          const win = el.ownerDocument.defaultView;
          const prototype = el.tagName === "INPUT" ? win.HTMLInputElement.prototype : win.HTMLTextAreaElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, "value").set.call(el, text);
        } else if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
          // A rich editor (Draft.js on X, Lexical, ProseMirror) keeps its own copy of the text, and an edit to its DOM
          // crashed X's composer or tripled the link it posted (live, 2026-10-14). Focused here, the extension types
          // the text with trusted input, the way a paste arrives.
          if (action.trusted) return { acted: true, type: true };
          // Without trusted input: keep editor descendants intact when possible; rich-text editors observe input.
          const doc = el.ownerDocument;
          const selection = doc.getSelection();
          const range = doc.createRange();
          range.selectNodeContents(el);
          selection.removeAllRanges();
          selection.addRange(range);
          if (!doc.execCommand?.("insertText", false, action.text)) el.textContent = action.text;
        } else return { error: "refused", message: "That control is not an editor." };
        el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: action.text }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        break;
      }
      case "select":
        if (el.tagName !== "SELECT") return { error: "refused", message: "That control is not a select." };
        if (!Array.from(el.options).some(o => o.value === action.value && !o.disabled)) return { error: "stale", message: "That option is not available. Inspect the select again." };
        el.value = action.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        break;
      case "press":
        if (!["Enter", "Tab", "Escape"].includes(action.key)) return { error: "refused", message: "Unsupported key." };
        if (action.hand) return { acted: true, key: action.key };
        for (const type of ["keydown", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, { key: action.key, code: action.key, keyCode: action.key === "Enter" ? 13 : action.key === "Tab" ? 9 : 27, bubbles: true, composed: true }));
        break;
      case "scroll":
        el.scrollBy?.({ top: (action.direction === "up" ? -1 : 1) * Math.max(300, Math.round((el.clientHeight || 600) * 0.85)), behavior: "instant" });
        break;
      default: return { error: "refused", message: "Unsupported browser action." };
    }
    return { acted: true, ...(window.__mqOverlay?.at ? { at: window.__mqOverlay.at } : {}) };
  }
  /** @type {import("../../../packages/core/src/browser.ts").BrowserControl[]} */
  const controls = [];
  const nodes = [];
  // The posts a page lists (a feed, a thread's comments), each once: a control inside one says which post it acts on.
  // Threads marks each post (and each reply) with data-pressable-container, none inside another (measured 2026-11-04).
  const ITEM = 'article,[role="article"],[role="listitem"],shreddit-post,shreddit-comment,[data-pressable-container]';
  const items = [];
  const itemOf = new Map();
  const item = (el) => {
    let box = null;
    for (let at = el; at && !box; at = at.parentElement ?? at.getRootNode?.().host ?? null) if (at !== el && at.matches?.(ITEM)) box = at;
    if (!box) return undefined;
    if (!itemOf.has(box)) {
      if (items.length >= 60) return undefined;
      itemOf.set(box, items.length);
      items.push(clean(box.innerText || box.textContent).slice(0, 200));
    }
    return itemOf.get(box);
  };
  const revision = crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  for (const root of roots) {
    const selector = 'a[href],button,input,textarea,select,[contenteditable="true"],[role="button"],[role="textbox"],[role="combobox"],[role="option"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="switch"],[role="link"],[tabindex]';
    for (const el of root.querySelectorAll(selector)) {
      if (!visible(el) || el.disabled || el.getAttribute("aria-disabled") === "true" || controls.length >= 300) continue;
      const id = nodes.length;
      nodes.push({ el, signature: signature(el) });
      const c = { ref: `${revision}:${id}`, role: role(el), label: sensitive(el) ? "Protected sign-in/payment control" : label(el), value: sensitive(el) ? null : ("value" in el ? String(el.value).slice(0, 10000) : role(el) === "textbox" ? el.textContent?.slice(0, 10000) ?? "" : null), href: el.tagName === "A" ? el.href : null };
      if (/INPUT|TEXTAREA/.test(el.tagName) && el.maxLength > 0) c.limit = el.maxLength;
      // A toggle's state: a like that is on, a follow that is done, a switch that is set.
      const pressed = el.getAttribute("aria-pressed") ?? el.getAttribute("aria-checked");
      if (pressed === "true" || pressed === "false") c.pressed = pressed === "true";
      const at = item(el);
      if (at !== undefined) c.item = at;
      // An option whose value is too long to send whole could never be chosen by it, so it is left out.
      if (el.tagName === "SELECT") c.options = Array.from(el.options).filter(o => !o.disabled && o.value.length <= 1000).slice(0, 100).map(o => ({ value: o.value, label: clean(o.textContent).slice(0, 300) }));
      controls.push(c);
    }
  }
  // Web messengers and mail clients scroll inner panes rather than the window.
  for (const root of roots) for (const el of root.querySelectorAll("*")) {
    if (controls.length >= 300 || !visible(el) || el.scrollHeight <= el.clientHeight + 1 || !/auto|scroll/.test(getComputedStyle(el).overflowY)) continue;
    const id = nodes.length;
    nodes.push({ el, signature: signature(el) });
    controls.push({ ref: `${revision}:${id}`, role: "scrollarea", label: (label(el) || "Scrollable content").slice(0, 300), value: null, href: null });
  }
  // Editor text is separate from page text, so composing a message cannot count as proof it was sent. The words
  // run from a screen above where the page is scrolled to as far down as the page has them, so one look reads more
  // than the screen in front; a feed that draws only what is near still needs scrolling.
  const text = [];
  let length = 0;
  for (const root of roots) {
    const start = root === document ? document.body : root;
    if (!start || length >= 24000) continue;
    const walker = document.createTreeWalker(start, NodeFilter.SHOW_TEXT);
    let node;
    while (length < 24000 && (node = walker.nextNode())) {
      const p = node.parentElement;
      if (!p || p.closest('script,style,noscript,textarea,input,[contenteditable="true"],[aria-hidden="true"]') || !readable(p)) continue;
      const words = clean(node.textContent);
      if (words) {
        text.push(words);
        length += words.length + 1;
      }
    }
  }
  // Where the page is scrolled to, on whatever scrolls it: the window, or the largest pane a web app scrolls instead.
  let scroller = document.scrollingElement ?? document.documentElement;
  if (scroller.scrollHeight <= scroller.clientHeight + 1) {
    let best = 0;
    for (const el of document.querySelectorAll("*")) {
      if (el.scrollHeight <= el.clientHeight + 1 || !/auto|scroll/.test(getComputedStyle(el).overflowY) || !visible(el)) continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > best) { best = area; scroller = el; }
    }
  }
  const scroll = { y: Math.round(scroller.scrollTop), height: Math.round(scroller.scrollHeight), viewport: Math.round(scroller.clientHeight || window.innerHeight) };
  // Still coming in: the document, or a busy region or spinner on screen.
  const busy = Array.from(document.querySelectorAll('[aria-busy="true"],[role="progressbar"]:not([aria-valuenow])')).some(visible);
  // What an action opened, said so the model need not work it out from the words: the field the keys go to now, and a
  // dialog or a menu on screen.
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  const typing = active && active !== document.body && (/INPUT|TEXTAREA/.test(active.tagName) || active.isContentEditable);
  const focus = typing && !sensitive(active) ? `${role(active)}: ${label(active).slice(0, 150)}` : undefined;
  // A menu or list that is always on screen (Telegram Web's has no words) is not something an action opened: only one that names itself.
  const named = (el) => clean(el.getAttribute("aria-label") || el.querySelector("h1,h2,h3,[role=heading]")?.textContent || el.innerText).slice(0, 150);
  const open = Array.from(document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="menu"],[role="listbox"]')).find((el) => visible(el) && hasWords(named(el)));
  const dialog = open ? `${open.getAttribute("role") || "dialog"}: ${named(open)}` : undefined;
  window[key] = { revision, nodes, url: location.href };
  return { url: location.href, title: document.title.slice(0, 1000), text: text.join(" ").slice(0, 24000), controls, items: items.length ? items : undefined, scroll, loading: document.readyState !== "complete" || busy, ...(focus ? { focus } : {}), ...(dialog ? { dialog } : {}) };
}

/**
 * Puts one of the customer's own pictures (or videos), sent to Quest in their chat, into the composer's file field,
 * the way choosing it in the file dialog would: never a file from their computer, and nothing is sent. The field is
 * the one inside the control `ref` names (the composer's add-media button), in the same form or dialog, or else the
 * one field on the page that takes this kind of file. Self-contained: Chrome serializes this function.
 * @param {{ ref: string | null, name: string, type: string, data: string }} job The file, its bytes base64.
 */
export function attachFile(job) {
  const key = "__mqBrowserView";
  let near = null;
  if (job.ref) {
    const state = window[key];
    const [revision, id] = String(job.ref).split(":");
    const saved = state?.nodes?.[Number(id)];
    if (!saved || revision !== state.revision || state.url !== location.href || !saved.el.isConnected) return { error: "stale", message: "The page changed. Inspect it again before attaching." };
    near = saved.el;
  }
  const type = String(job.type || "").toLowerCase();
  const name = String(job.name || "file").toLowerCase();
  const takes = (input) => {
    const accept = (input.getAttribute("accept") || "").toLowerCase().split(",").map((a) => a.trim()).filter(Boolean);
    return !accept.length || accept.some((a) => a === type || (a.endsWith("/*") && type.startsWith(a.slice(0, -1))) || (a.startsWith(".") && name.endsWith(a)));
  };
  const roots = [document];
  for (let i = 0; i < roots.length; i++) for (const el of roots[i].querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
  const fields = roots.flatMap((r) => Array.from(r.querySelectorAll('input[type="file"]'))).filter((i) => !i.disabled && takes(i));
  let input = null;
  if (near) {
    if (near.matches?.('input[type="file"]') && takes(near)) input = near;
    // Up from the control to the nearest box (its form, dialog or composer) that holds a file field.
    for (let at = near; !input && at && at !== document.documentElement; at = at.parentElement ?? at.getRootNode?.().host ?? null) {
      input = fields.find((f) => at.contains(f)) ?? null;
    }
  }
  input ??= fields.find((f) => f.closest('[role="dialog"],dialog')) ?? (fields.length === 1 ? fields[0] : null) ?? fields[0] ?? null;
  if (!input) return { error: "refused", message: "Nothing on this page takes this file. Open the composer (its add-photo control) first." };
  const bytes = Uint8Array.from(atob(job.data), (c) => c.charCodeAt(0));
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], job.name || "file", { type: job.type || "application/octet-stream" }));
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  return { acted: true };
}
