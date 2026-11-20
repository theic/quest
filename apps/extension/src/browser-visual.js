/**
 * Whether Quest may picture and click its task tab: on unless they turned it off in the popup.
 * The `debugger` permission it needs is required, not optional: Chrome refuses `debugger` as an
 * optional permission, so a switch that asked for it at run time could never turn on.
 */
export const visualAllowed = ({ visual }) => visual !== false;

/**
 * The debugger stays on a tab while Quest works in it, and comes off a while after its last use: each attach and detach
 * shows and hides Chrome's "started debugging" bar, which moves the page, so a picture taken a moment before no longer
 * matched it ("The viewport changed", live, 2026-11-13, once every press was a real one).
 */
const HOLD_MS = 90_000;
const held = new Map();

async function hold(api, tabId) {
  if (!held.has(tabId)) {
    try {
      await api.attach({ tabId }, "1.3");
      // The bar takes a moment to come and move the page: what is measured next is the page as it stays.
      await new Promise((r) => setTimeout(r, 300));
    } catch (e) { if (!/already attached/i.test(String(e?.message ?? e))) throw e; }
  }
  clearTimeout(held.get(tabId));
  held.set(tabId, setTimeout(() => { held.delete(tabId); api.detach({ tabId }).catch(() => undefined); }, HOLD_MS));
}

/** The debugger came off (the tab closed, or the customer cancelled it on Chrome's bar): attached again when next needed. */
export function released(tabId) {
  clearTimeout(held.get(tabId));
  held.delete(tabId);
}

/** Trusted input for a task's own tab only. No arbitrary CDP/JavaScript from the model. */
export async function visualInput(api, tabId, action, shot) {
  const target = { tabId };
  if (!shot || shot.id !== action.screen || Date.now() - shot.at > 180000) throw new Error("That picture expired. Take a fresh screenshot.");
  const point = () => {
    if (!(action.x >= 0 && action.y >= 0 && action.x < shot.width && action.y < shot.height)) throw new Error("That point is outside the task tab's picture.");
    return { x: action.x * shot.viewportWidth / shot.width, y: action.y * shot.viewportHeight / shot.height };
  };
  await hold(api, tabId);
  const send = (method, params) => api.sendCommand(target, method, params);
  try {
    const layout = await send("Page.getLayoutMetrics", {});
    const current = layout.cssVisualViewport ?? layout.visualViewport;
    if (Math.abs(current.clientWidth - shot.viewportWidth) > 1 || Math.abs(current.clientHeight - shot.viewportHeight) > 1) throw new Error("The viewport changed. Take a fresh picture.");
    if (action.kind === "move_point") {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point(), button: "none", buttons: 0 });
    } else if (action.kind === "click_point") {
      const p = point();
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...p, button: "left", clickCount: 1, buttons: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...p, button: "left", clickCount: 1, buttons: 0 });
    } else if (action.kind === "type_text") {
      if (action.method === "keys" && /[\u0000-\u001f\u007f]/.test(action.text)) throw new Error("Key typing accepts a single line without control characters; use text insertion for multiline content.");
      await replaceFocused(send, action.text, action.method === "keys");
    } else if (action.kind === "press_focused") {
      const code = { Enter: 13, Tab: 9, Escape: 27 }[action.key];
      if (!code) throw new Error("Unsupported key.");
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: action.key, code: action.key, windowsVirtualKeyCode: code });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: action.key, code: action.key, windowsVirtualKeyCode: code });
    } else if (action.kind === "scroll_point") {
      await send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point(), deltaX: 0, deltaY: action.direction === "up" ? -600 : 600 });
    } else throw new Error("Unsupported visual input.");
  } finally { await hold(api, tabId).catch(() => undefined); }
}

/** Selects everything in the focused field and puts the text in its place: as a paste arrives, or key by key. */
async function replaceFocused(send, text, keys = false) {
  const modifiers = /Mac/i.test(navigator.userAgentData?.platform ?? navigator.platform) ? 4 : 2;
  // On a Mac the shortcut alone selects nothing: macOS, not the page, maps it to the command.
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers, windowsVirtualKeyCode: 65, commands: ["selectAll"] });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers, windowsVirtualKeyCode: 65 });
  if (!keys) return send("Input.insertText", { text });
  for (const character of text) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: character, text: character });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: character });
  }
}

/**
 * Fills the rich editor a page script just focused (browser-page.js), with trusted input instead of a DOM edit,
 * which Draft.js and its kind take apart. The page script has already refused password, code and card fields.
 */
export async function trustedFill(api, tabId, text) {
  const target = { tabId };
  await hold(api, tabId);
  await replaceFocused((method, params) => api.sendCommand(target, method, params), text);
}

/**
 * A hand on the session's tab while it acts on one control: a press is a real mouse press at the control's centre and a
 * key a real key, as a person makes them. Pages built on React and its kind act only on input the browser itself sends
 * (`isTrusted`), so a script's click left Bluesky's Reply closed five times in a day (live, 2026-11-13). Attached before
 * the control's place is measured, since Chrome's debugging bar can move the page. Null when Chrome refuses it.
 */
export async function holdInput(api, tabId) {
  const target = { tabId };
  try { await hold(api, tabId); } catch { return null; }
  const send = (method, params) => api.sendCommand(target, method, params);
  return {
    async press({ x, y }) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
    },
    async key(key) {
      const code = { Enter: 13, Tab: 9, Escape: 27 }[key];
      if (!code) throw new Error("Unsupported key.");
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: code, ...(key === "Enter" ? { text: "\r" } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code });
    },
    // Left on for the next step (see hold): it comes off by itself.
    close: async () => undefined,
  };
}

/**
 * Whether the words typed are in the focused field, read once the typing is done; a plain field that holds something
 * else gets them the old way, by its value. Self-contained: Chrome serializes this function.
 */
export function typedCheck(text) {
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  if (!el || !/INPUT|TEXTAREA/.test(el.tagName)) return { ok: true };
  if (clean(el.value) === clean(text)) return { ok: true };
  const win = el.ownerDocument.defaultView;
  const prototype = el.tagName === "INPUT" ? win.HTMLInputElement.prototype : win.HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(el, text);
  el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: clean(el.value) === clean(text), held: clean(el.value).slice(0, 200) };
}

/** Picture of the task tab, with pixel dimensions for unambiguous model coordinates. */
export async function visualPicture(api, tabId) {
  const target = { tabId };
  await hold(api, tabId);
  const layout = await api.sendCommand(target, "Page.getLayoutMetrics", {});
  const viewport = layout.cssVisualViewport ?? layout.visualViewport;
  const picture = await api.sendCommand(target, "Page.captureScreenshot", { format: "jpeg", quality: 60, captureBeyondViewport: false, fromSurface: true });
  const bytes = Uint8Array.from(atob(picture.data), c => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  const width = bitmap.width, height = bitmap.height;
  bitmap.close();
  if (picture.data.length > 1500000) throw new Error("The task picture is too large.");
  return { id: crypto.randomUUID(), image: `data:image/jpeg;base64,${picture.data}`, width, height, viewportWidth: viewport.clientWidth, viewportHeight: viewport.clientHeight, at: Date.now() };
}

/**
 * Whether the field that has the keyboard in this frame is one the customer fills in themselves:
 * a password, a one-time code, a card or a file. Injected into each frame before visual typing,
 * which goes to whatever is focused. Never reads the field's value.
 */
export function focusedSensitive() {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el.tagName !== "INPUT") return false;
  const auto = String(el.getAttribute("autocomplete") ?? "");
  return el.type === "password" || el.type === "file" || /password|one-time-code|(^|\s)cc-/i.test(auto);
}

/** Temporarily cover credential/payment inputs while capturing; never reads their values. */
export function protectPicture(hide) {
  const key = "__mqPictureMasks";
  if (!hide) { for (const mask of window[key] ?? []) mask.remove(); delete window[key]; return; }
  const masks = [];
  const roots = [document];
  for (let i = 0; i < roots.length; i++) for (const el of roots[i].querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
  for (const root of roots) for (const input of root.querySelectorAll('input[type="password"],input[autocomplete*="password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"],input[type="file"]')) {
    const r = input.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const mask = document.createElement("div");
    Object.assign(mask.style, { position: "fixed", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, background: "#111", zIndex: "2147483647", pointerEvents: "none" });
    document.documentElement.appendChild(mask);
    masks.push(mask);
  }
  window[key] = masks;
}
