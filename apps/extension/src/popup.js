import { ready, t, currentLocale, systemMessage } from "../i18n/browser.js";
await ready;
/** The toolbar popup: how the connection stands, and connecting with a code by hand. */
const $ = (id) => document.getElementById(id);
const ask = (msg) => chrome.runtime.sendMessage(msg);


const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return t("just now");
  const m = Math.round(s / 60);
  return new Intl.RelativeTimeFormat(currentLocale(), { numeric: "auto", style: "short" }).format(m < 60 ? -m : -Math.round(m / 60), m < 60 ? "minute" : "hour");
};

// A switch shows what the extension says unless its own change is on the way. Focus is no sign of that: Chrome puts
// the focus on a popup's first control as it opens, so the first switch never showed a change made in the chat.
const changing = new Set();
const change = (id, work) => $(id).addEventListener("change", async (e) => {
  changing.add(id);
  try {
    await work(e);
  } finally {
    changing.delete(id);
  }
});

/** Whether the bar says Quest is paused, and the bar itself: what it says, and what its button does next. */
let paused = false;
function drawPower(off) {
  paused = Boolean(off);
  $("power-bar").classList.toggle("off", paused);
  // Written only when it changed: the label is a status, and a screen reader would say it again at every look.
  const put = (id, text) => $(id).textContent !== text && ($(id).textContent = text);
  put("power-label", t(paused ? "Quest is paused. Nothing browses or posts." : "Quest is working in this Chrome"));
  put("power", t(paused ? "Resume" : "Pause"));
}

async function render() {
  const s = await ask({ type: "status" });
  $("connected").hidden = !s.connected;
  $("setup").hidden = s.connected;
  $("power-bar").hidden = !s.connected;
  $("gear").hidden = !s.connected;
  if (!s.connected) $("settings").hidden = true;
  else if (view === "settings") $("connected").hidden = true;
  if (s.connected && !talking) void talk();
  if (s.connected) {
    $("device").textContent = s.device ? ` · ${s.device}` : "";
    $("state").classList.toggle("warn", s.link === "unreachable");
    $("activity").textContent = systemMessage(
      s.link === "unreachable"
        ? `Quest can't be reached at ${new URL(s.server).host}. It tries again every 30 seconds. If Quest moved, open the newest Connect Chrome link from the chat.`
        : s.posting
          ? `Posting on ${s.posting}…`
          : s.reading
            ? `Reading ${s.reading}…`
            : s.lastJobAt
              ? `Waiting for work. Last page read ${ago(s.lastJobAt)}.`
              : "Waiting for work.");
    $("today").textContent = t("Pages read today: {count}/{total}", { count: s.pagesToday, total: s.dailyPages });
    $("today-bar").style.width = `${Math.min(100, (100 * s.pagesToday) / (s.dailyPages || 1))}%`;
    if (!changing.has("power")) drawPower(s.off);
    if (!changing.has("awake")) $("awake").checked = s.awake;
    if (!changing.has("visual")) $("visual").checked = s.visual;
    // Their page's switch keeps it in the background too: the popup's says so, and waits for that one.
    if (!changing.has("front")) $("front").checked = s.front && !s.frontByPage;
    $("front").disabled = Boolean(s.frontByPage);
    $("front").title = s.frontByPage ? t("Kept in the background from your page in Telegram.") : "";
  } else {
    // A store install connects only to Quest's own address; an unpacked build can be pointed elsewhere.
    $("address").hidden = !s.customServer;
    if (!$("server").value) $("server").value = s.server;
    $("note").hidden = !s.note;
    $("note").textContent = systemMessage(s.note ?? "");
  }
}

/* ------------------------------------------------------------------ the chat */

let talking = false;
let mark = null;
let drawnKey = "";

/** Telegram's HTML, as Quest's cards carry it, kept to its own few tags; links open in a tab. */
function safeHtml(into, html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const walk = (from, to) => {
    for (const n of from.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) to.append(n.textContent);
      else if (n.nodeType === Node.ELEMENT_NODE) {
        const tag = n.tagName.toLowerCase();
        if (tag === "br") {
          to.append("\n");
          continue;
        }
        const keep = ["b", "strong", "i", "em", "u", "s", "code", "pre", "blockquote", "a"].includes(tag);
        const el = keep ? document.createElement(tag) : document.createDocumentFragment();
        if (tag === "a") {
          const href = n.getAttribute("href") ?? "";
          if (/^https?:\/\//.test(href)) Object.assign(el, { href, target: "_blank", rel: "noopener" });
        }
        walk(n, el);
        to.append(el);
      }
    }
  };
  into.replaceChildren();
  walk(doc.body.firstChild, into);
}

/** Plain words with their addresses made links. */
function linked(into, text) {
  into.replaceChildren();
  for (const part of String(text).split(/(https?:\/\/[^\s<>"]+)/g)) {
    if (/^https?:\/\//.test(part)) into.append(Object.assign(document.createElement("a"), { href: part, target: "_blank", rel: "noopener", textContent: part.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60) }));
    else if (part) into.append(part);
  }
}

function buttonsFor(buttons, box) {
  for (const b of buttons) {
    if (b.url) box.append(Object.assign(document.createElement("a"), { href: b.url, target: "_blank", rel: "noopener", textContent: b.label }));
    else {
      const el = Object.assign(document.createElement("button"), { type: "button", textContent: b.label });
      el.addEventListener("click", () => press(b.data, el));
      box.append(el);
    }
  }
}

let drawnOut = "";

async function press(data, el) {
  // A likely answer is their words, sent as a message.
  if (data.startsWith("say:")) return send(data.slice(4));
  if (el) el.disabled = true;
  const res = await ask({ type: "press", data }).catch(() => null);
  // What the press did ("Posting it…", "Scheduled…") stays a few seconds under the chat.
  if (res?.ack) ack = { text: res.ack, until: Date.now() + 6000 };
  await refresh();
}

let replyTo = null;
/** The voice message being recorded, while it is. */
let recording = null;
let ack = null;
let last = null;
/** What the panel shows: "chat" (the conversation, with what waits on them) or "settings". */
let view = "chat";
let wantsFocus = false;

/** The settings the agent keeps: each platform on or off and whether its replies go up by themselves, the model, the reports. */
function drawWork(w) {
  if (!w?.ok) return;
  $("work").hidden = false;
  const list = $("platforms");
  list.replaceChildren(
    ...w.platforms.map((p) => {
      const li = document.createElement("li");
      const label = document.createElement("label");
      const name = document.createElement("span");
      name.textContent = p.name ?? p.platform;
      const note = document.createElement("small");
      note.textContent = p.on ? (p.alone ? t("replies go up by themselves") : t("asks you first")) : t("off");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "toggle";
      box.setAttribute("role", "switch");
      box.checked = Boolean(p.on);
      box.addEventListener("change", async () => {
        box.disabled = true;
        drawWork(await ask({ type: "settings", platform: p.platform, on: box.checked }).catch(() => null));
        box.disabled = false;
      });
      label.append(name, note, box);
      li.append(label);
      return li;
    }),
  );
  $("model").textContent = w.model ? `${t("Thinks with")}: ${t(w.model)}` : "";
  $("reports-head").hidden = !w.reports.length;
  $("reports").replaceChildren(
    ...w.reports.map((r) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = r.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = r.day;
      li.append(a);
      return li;
    }),
  );
}

const show = (next) => {
  view = next;
  if (next === "settings") ask({ type: "settings" }).then(drawWork, () => {});
  $("gear").setAttribute("aria-pressed", String(next === "settings"));
  $("settings").hidden = next !== "settings";
  $("connected").hidden = next === "settings";
  if (last) draw(last);
};

/** What waits on them, drawn again only when it changed, so a press in flight is not reset. */
let asksKey = "";
/** What waits on them, a plain list above the box to write in: each with its words and its own buttons. */
function drawAsks(asks) {
  $("asks").hidden = !asks.length;
  const key = JSON.stringify(asks);
  if (key === asksKey) return;
  asksKey = key;
  $("asks-sum").textContent = `${t("Waiting for you")} · ${asks.length}`;
  const list = $("asks-list");
  list.replaceChildren();
  for (const a of asks) {
    const li = document.createElement("li");
    if (a.link) li.append(Object.assign(document.createElement("a"), { className: "to", href: a.link.url, target: "_blank", rel: "noopener", textContent: a.link.label }));
    if (a.head) li.append(Object.assign(document.createElement("p"), { className: "head", textContent: a.head }));
    if (a.quote) li.append(Object.assign(document.createElement("p"), { className: "quote", textContent: a.quote }));
    const words = Object.assign(document.createElement("div"), { className: "words" });
    if (a.text !== null && a.text !== undefined) linked(words, a.text);
    else safeHtml(words, a.html ?? "");
    li.append(words);
    const box = Object.assign(document.createElement("div"), { className: "buttons" });
    for (const b of a.buttons) {
      const el = Object.assign(document.createElement("button"), { type: "button", textContent: b.text ?? b.label });
      // Edit asks what should change: the box to write in takes the words.
      el.addEventListener("click", () => {
        wantsFocus = /(:|^)edit/i.test(b.data);
        for (const x of box.querySelectorAll("button")) x.disabled = true;
        void press(b.data, null);
      });
      box.append(el);
    }
    li.append(box);
    list.append(li);
  }
}

/** What the panel last told the icon it showed. */
let seen = "";
document.addEventListener("visibilitychange", () => {
  seen = "";
  if (last) draw(last);
});

function draw(chat) {
  last = chat;
  const asks = chat.asks ?? [];
  $("chat").hidden = view !== "chat";
  const messages = chat.messages;
  const latest = [...messages].reverse().find((m) => m.from === "quest" && !m.note);
  // The panel in view has shown it all: the icon's count goes back to the asks alone.
  const seenKey = `${latest?.at ?? ""}|${asks.length}`;
  if (document.visibilityState === "visible" && seenKey !== seen) {
    seen = seenKey;
    void ask({ type: "seen", at: latest?.at ?? null, asks: asks.length }).catch(() => undefined);
  }
  drawAsks(asks);
  const key = JSON.stringify([messages.map((m) => [m.ref, m.text, m.reaction, m.buttons.length]), chat.typing, view]);
  if (key !== drawnKey && view === "chat") {
    drawnKey = key;
    const list = $("chat");
    const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.replaceChildren();
    for (const m of messages) {
      const el = document.createElement("div");
      el.className = `msg ${m.note ? "note" : m.from}`;
      linked(el, m.text);
      if (m.reaction) el.append(Object.assign(document.createElement("span"), { className: "reaction", textContent: m.reaction }));
      if (m.buttons.length) {
        const box = Object.assign(document.createElement("div"), { className: "buttons" });
        buttonsFor(m.buttons, box);
        el.append(box);
      }
      list.append(el);
    }
    if (chat.typing) list.append(Object.assign(document.createElement("div"), { className: "msg quest typing", textContent: t("typing…") }));
    if (atEnd || !list.dataset.drawn) list.scrollTop = list.scrollHeight;
    list.dataset.drawn = "1";
  }
  // What Quest sends by itself next: skimmed here, and struck with its button before it goes.
  const out = chat.out?.lines ?? [];
  $("out").hidden = !out.length;
  const outKey = JSON.stringify(chat.out ?? null);
  if (out.length && outKey !== drawnOut) {
    $("out-sum").textContent = `${t("Going out soon")} · ${out.length + (chat.out.more || 0)}`;
    const list = $("out-list");
    list.replaceChildren();
    for (const l of out) {
      const li = document.createElement("li");
      const words = document.createElement("span");
      words.append(Object.assign(document.createElement("b"), { textContent: l.label }), ` ${l.words}`);
      const strike = Object.assign(document.createElement("button"), { type: "button", textContent: "✕", title: t("Strike") });
      strike.setAttribute("aria-label", t("Strike"));
      strike.addEventListener("click", () => press(l.strike, strike));
      li.append(words, strike);
      list.append(li);
    }
  }
  drawnOut = outKey;
  const line = chat.line ?? (ack && ack.until > Date.now() ? ack.text : null);
  $("line").hidden = !line;
  if (line) $("line").textContent = line;
  replyTo = chat.replyTo?.ref ?? null;
  $("words").placeholder = recording ? t("Recording… tap the mic to send") : t("Write to Quest");
  $("reply-to").hidden = !chat.replyTo;
  if (chat.replyTo) $("reply-to").textContent = chat.replyTo.text;
  if (wantsFocus && chat.replyTo) {
    wantsFocus = false;
    $("words").focus();
  }
}

$("gear").addEventListener("click", () => show(view === "settings" ? "chat" : "settings"));

async function refresh() {
  const res = await ask({ type: "chat" }).catch(() => null);
  if (res?.ok) {
    mark = res.chat.mark;
    draw(res.chat);
  }
}

/** Opens the chat, then waits on Quest's word (a long poll) for as long as the popup is open. */
async function talk() {
  talking = true;
  void ask({ type: "seen" });
  await refresh();
  for (;;) {
    const res = await ask({ type: "chat", after: String(mark ?? 0), wait: 20 }).catch(() => null);
    if (!res?.ok) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    mark = res.chat.mark;
    draw(res.chat);
  }
}

async function send(text) {
  const words = String(text).trim();
  if (!words) return;
  // Shown at once; the chat's next drawing puts it where the transcript has it.
  $("chat").append(Object.assign(document.createElement("div"), { className: "msg you", textContent: words }));
  $("chat").scrollTop = $("chat").scrollHeight;
  drawnKey = "";
  const res = await ask({ type: "say", text: words, replyTo }).catch(() => null);
  if (!res?.ok) {
    $("line").hidden = false;
    $("line").textContent = t("It didn't send. Try again.");
  }
}

$("say").addEventListener("submit", async (e) => {
  e.preventDefault();
  const box = $("words");
  const text = box.value;
  box.value = "";
  fit();
  await send(text);
});
$("words").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("say").requestSubmit();
  }
});
// The box grows with their words up to six lines, and only then scrolls; empty, the mic shows, else the send.
const fit = () => {
  const box = $("words");
  box.style.height = "";
  box.style.height = `${Math.min(140, box.scrollHeight)}px`;
  box.style.overflowY = box.scrollHeight > 140 ? "auto" : "hidden";
  $("say").classList.toggle("typed", box.value.trim() !== "");
};
$("words").addEventListener("input", fit);

// Someone new: Quest starts the conversation here, and this Chrome is theirs.
$("hello").addEventListener("click", async () => {
  $("error").hidden = true;
  $("hello").disabled = true;
  const res = await ask({ type: "hello", server: $("server").value.trim() }).catch(() => null);
  $("hello").disabled = false;
  if (res?.ok) return render();
  $("error").textContent = systemMessage(res?.message ?? "It didn't start. Try again in a minute.");
  $("error").hidden = false;
});

$("pair").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("error").hidden = true;
  const res = await ask({ type: "pair", code: $("code").value, server: $("server").value.trim() });
  if (res?.ok) return render();
  $("error").textContent = systemMessage(res?.message ?? "It didn't connect.");
  $("error").hidden = false;
});

// Quest on or off, the same switch as in the chat: the bar shows what the agent kept, so a press that did not reach it
// leaves the bar as it was. While the press is on its way a poll does not redraw it.
$("power").addEventListener("click", async () => {
  if (changing.has("power")) return;
  changing.add("power");
  $("power").disabled = true;
  const on = paused;
  try {
    const res = await ask({ type: "power", on }).catch(() => null);
    if (res?.ok) drawPower(!res.on);
  } finally {
    changing.delete("power");
    $("power").disabled = false;
  }
});

// The same Quest in Telegram, for whoever wants it there too: the agent makes the link, and it opens in a tab.
$("telegram").addEventListener("click", async () => {
  $("telegram-error").hidden = true;
  $("telegram").disabled = true;
  const res = await ask({ type: "telegram" }).catch(() => null);
  $("telegram").disabled = false;
  if (res?.ok) return void chrome.tabs.create({ url: res.url });
  $("telegram-error").hidden = false;
});

change("awake", async (e) => {
  const res = await ask({ type: "awake", on: e.target.checked });
  if (res?.ok) e.target.checked = res.awake;
});

$("disconnect").addEventListener("click", async () => {
  await ask({ type: "disconnect" });
  await render();
});

// Shows what the extension kept, never only the click: a switch that didn't save flips back.
change("visual", async (e) => {
  const on = e.target.checked;
  const res = await ask({ type: "visual", on }).catch(() => null);
  e.target.checked = res?.ok ? res.visual : !on;
});

change("front", async (e) => {
  const on = e.target.checked;
  const res = await ask({ type: "front", on }).catch(() => null);
  e.target.checked = res?.ok ? res.front : !on;
});

// An (i) shows its explanation while hovered or focused; a click keeps it open until Escape or a click elsewhere.
// Escape hides it even under the pointer or focus (`data-hush`), until the pointer or focus leaves.
const infos = [...document.querySelectorAll(".info")];
const pin = (open) => infos.forEach((b) => b.setAttribute("aria-expanded", String(b === open)));
infos.forEach((b) => {
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    b.removeAttribute("data-hush");
    pin(b.getAttribute("aria-expanded") === "true" ? null : b);
  });
  for (const leave of ["pointerleave", "blur"]) b.addEventListener(leave, () => b.removeAttribute("data-hush"));
});
document.addEventListener("click", () => pin(null));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  pin(null);
  infos.forEach((b) => b.toggleAttribute("data-hush", b.matches(":hover, :focus")));
});

await render();
setInterval(render, 2000);

/* ------------------------------------------------------------ voice messages */

// A voice message, recorded here and heard by Quest like Telegram's: a note on the card in front, or a message. A popup
// cannot ask for the microphone itself (Chrome closes the prompt), so the first time it opens mic.html, which asks once.
$("mic").addEventListener("click", async () => {
  if (recording) return recording.stop();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    await chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") });
    return;
  }
  const type = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: type });
  const started = Date.now();
  const about = replyTo;
  const cap = setTimeout(() => rec.state === "recording" && rec.stop(), 240000);
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    clearTimeout(cap);
    stream.getTracks().forEach((tr) => tr.stop());
    recording = null;
    $("mic").classList.remove("on");
    if (last) draw(last);
    const seconds = (Date.now() - started) / 1000;
    if (seconds < 0.7) return;
    const audio = await new Promise((done) => {
      const r = new FileReader();
      r.onload = () => done(String(r.result).replace(/^data:[^,]*,/, ""));
      r.readAsDataURL(new Blob(chunks, { type }));
    });
    $("line").hidden = false;
    $("line").textContent = t("Sending your voice message…");
    const res = await ask({ type: "voice", audio, mime: "audio/webm", seconds: Math.round(seconds), replyTo: about }).catch(() => null);
    $("line").textContent = res?.ok ? t("Sent. Quest is listening.") : t("It didn't send. Try again.");
    setTimeout(() => ($("line").hidden = true), 4000);
  };
  rec.start();
  recording = rec;
  $("mic").classList.add("on");
  $("words").placeholder = t("Recording… tap the mic to send");
});
