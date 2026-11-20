// Live test of Quest's tab group in a real Chrome for Testing: a stand-in Quest server feeds the unpacked
// extension jobs, and CDP reads Chrome's windows, tabs and groups from the extension's service worker. It
// opens example.com, Wikipedia, Hacker News, Reddit, X and httpbin.org's form (typed into, never sent).
// Usage: node scripts/try-tab-group.mjs <copy of apps/extension> <profile dir>
// Keep both paths short (~/.cache/mq-cft/…): under a long path the extension's worker never starts (FACTS.md).
// The first run sets the profile up; the 20 checks print as PASS/FAIL, then a summary. About 5 minutes.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const [EXT, PROFILE] = process.argv.slice(2);
const CHROME = process.env.CFT_CHROME ?? `${process.env.USERPROFILE ?? process.env.HOME}/.cache/mq-cft/chrome/win64-152.0.7977.82/chrome-win64/chrome.exe`;
const PORT = 8799, DEBUG = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = [];
const log = (name, data) => { report.push({ name, ...data }); console.log(`\n## ${name}\n${JSON.stringify(data, null, 1)}`); };
const check = (name, ok, detail) => { report.push({ check: name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`); };

/* ---------------------------------------------------------- stand-in Quest */
const queue = [];
const waiting = new Map();
const shots = [];
let polls = 0;
let nextId = 1;
const job = (j) => new Promise((resolve) => { const id = `j${nextId++}`; waiting.set(id, resolve); queue.push({ id, ...j }); });
const server = createServer(async (req, res) => {
  const body = await new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/chrome/pair") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: "rig-token", device: "Chrome for Testing" }));
  if (url.pathname === "/chrome/me") return res.writeHead(200).end("{}");
  if (url.pathname === "/chrome/disconnect") return res.writeHead(200).end("{}");
  if (url.pathname === "/chrome/shots") { shots.push({ at: Date.now(), bytes: body.length, host: req.headers["x-mq-host"] }); return res.writeHead(200).end("{}"); }
  if (url.pathname === "/chrome/next") {
    polls++;
    for (let i = 0; i < 20 && !queue.length; i++) await sleep(100);
    const j = queue.shift();
    return j ? res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(j)) : res.writeHead(204).end();
  }
  const done = /^\/chrome\/jobs\/(.+)$/.exec(url.pathname);
  if (done) { waiting.get(decodeURIComponent(done[1]))?.(JSON.parse(body.toString() || "{}")); return res.writeHead(200).end("{}"); }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

/* ------------------------------------------------------------------ Chrome */
// A profile already set up (developer mode on, extension enabled) starts the extension's worker at launch.
const chrome = spawn(CHROME, [`--user-data-dir=${PROFILE}`, `--load-extension=${EXT}`, `--remote-debugging-port=${DEBUG}`, "--no-first-run", "--no-default-browser-check", "--disable-sync", "--window-position=40,40", "--window-size=1200,900", "about:blank"], { stdio: "ignore" });
let version;
for (let i = 0; i < 60 && !version; i++) { await sleep(500); version = await fetch(`http://127.0.0.1:${DEBUG}/json/version`).then((r) => r.json()).catch(() => null); }
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const evalIn = async (sessionId, expression) => {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const pageSession = async (url) => {
  const { targetId } = await cdp("Target.createTarget", { url });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await sleep(1500);
  return { targetId, sessionId };
};

// The unpacked extension starts off in this Chrome: developer mode on, then enable it.
const ext = await pageSession("chrome://extensions/");
await evalIn(ext.sessionId, "chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true})");
await sleep(500);
const extId = await evalIn(ext.sessionId, `(async () => { const all = await chrome.management.getAll(); const me = all.find((e) => e.installType === "development"); if (!me.enabled) await chrome.management.setEnabled(me.id, true); return me.id; })()`);
await cdp("Target.closeTarget", { targetId: ext.targetId });
log("extension", { extId });
let workerUp = false;
for (let i = 0; i < 20 && !workerUp; i++) { await sleep(500); workerUp = (await cdp("Target.getTargets")).targetInfos.some((x) => x.type === "service_worker" && x.url.startsWith(`chrome-extension://${extId}/`)); }
if (!workerUp) { console.log("NO WORKER: run again with the same profile (it is set up now)"); chrome.kill(); process.exit(3); }

let sw = null;
const worker = async () => {
  const { targetInfos } = await cdp("Target.getTargets");
  const t = targetInfos.find((x) => x.type === "service_worker" && x.url.startsWith(`chrome-extension://${extId}/`));
  if (!t) return null;
  if (sw?.targetId === t.targetId) return sw.sessionId;
  const { sessionId } = await cdp("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  sw = { targetId: t.targetId, sessionId };
  return sessionId;
};
const STATE = `(async () => {
  const wins = await chrome.windows.getAll({ populate: true });
  const groups = await chrome.tabGroups.query({});
  const s = await chrome.storage.session.get(["questTabs", "questGroup", "giveBack"]);
  return { wins: wins.map((w) => ({ id: w.id, focused: w.focused, state: w.state, tabs: w.tabs.map((t) => ({ id: t.id, active: t.active, group: t.groupId, url: (t.url || t.pendingUrl || "").slice(0, 50) })) })), groups: groups.map((g) => ({ id: g.id, title: g.title, windowId: g.windowId })), ...s };
})()`;
const state = async () => evalIn(await worker(), STATE);

// The customer's own tabs, in the window Chrome opened: about:blank becomes example.com, plus Wikipedia in front.
const own1 = await pageSession("https://example.com/");
const own2 = await pageSession("https://en.wikipedia.org/wiki/Tab_(interface)");
await sleep(1500);
for (const t of (await cdp("Target.getTargets")).targetInfos) if (t.type === "page" && t.url === "about:blank") await cdp("Target.closeTarget", { targetId: t.targetId });
await sleep(800);

// Connected as a pairing leaves it (a tab page pairs only with its own origin): the alarm starts the loop within 30 s.
await evalIn(await worker(), `chrome.storage.local.set({ server: "http://127.0.0.1:${PORT}", token: "rig-token", device: "Chrome for Testing" })`);
for (let i = 0; i < 90 && !polls; i++) await sleep(500);
const paired = { polls };
// Their Wikipedia tab in front again, as a person would have it.
await cdp("Target.activateTarget", { targetId: own2.targetId });
await sleep(800);
log("paired", { paired });
const before = await state();
log("before", before);
const ownIds = before.wins.flatMap((w) => w.tabs).map((t) => t.id);
const theirActive = () => before.wins[0].tabs.find((t) => t.active)?.id;
const activeIn = (s) => s.wins.flatMap((w) => w.tabs).find((t) => t.active && t.group === -1 ? true : t.active)?.id;
const frontTab = (s, windowId) => s.wins.find((w) => w.id === windowId)?.tabs.find((t) => t.active)?.id;
const W = before.wins[0].id;

/* --------------------------------------------------------------- scenarios */
// 1. A plain read: in the background of a "Quest" group in their window.
const hn = await job({ url: "https://news.ycombinator.com/", take: { text: true, links: true } });
let s = await state();
log("1 read HN", { ok: hn.ok, textChars: hn.read?.text?.length, visible: hn.read?.visible, state: s });
check("read works in a background tab", hn.ok && hn.read.text.length > 1000, `${hn.read?.text?.length} chars`);
check("one window, no new one", s.wins.length === 1);
check("a group titled Quest in their window", s.groups.length === 1 && s.groups[0].title === "Quest" && s.groups[0].windowId === W);
check("their tab stays in front during a read", frontTab(s, W) === theirActive());

// 2. Reddit and X, read in the background, then drawn (the tab comes to the front, and goes back).
for (const [name, url] of [["reddit", "https://www.reddit.com/r/SaaS/new/"], ["x", "https://x.com/marclou"]]) {
  const bg = await job({ url, take: { text: true }, settleMs: 4000 });
  let settled = false;
  const drawnJob = job({ url, take: { text: true }, settleMs: 4000, drawn: true }).then((r) => { settled = true; return r; });
  // Watched the whole job: was Quest's tab ever the one in front?
  let mid = null;
  while (!settled) { const now = await state(); if (now.questTabs?.includes(frontTab(now, W))) mid = now; await sleep(300); }
  mid ??= await state();
  const dr = await drawnJob;
  const after = await state();
  log(`2 ${name}`, { background: { ok: bg.ok, chars: bg.read?.text?.length, visible: bg.read?.visible, reason: bg.reason, msg: bg.message }, drawn: { ok: dr.ok, chars: dr.read?.text?.length, visible: dr.read?.visible, reason: dr.reason, msg: dr.message }, midFront: frontTab(mid, W), afterFront: frontTab(after, W) });
  check(`${name}: Quest's tab in front while a drawn page renders`, mid.questTabs?.includes(frontTab(mid, W)));
  check(`${name}: their tab back in front after`, frontTab(after, W) === theirActive());
}

// 3. A read with a picture asked for: only while Quest's tab is in front, of Quest's tab only.
const shotsBefore = shots.length;
await job({ url: "https://news.ycombinator.com/newest", take: { text: true }, shot: true });
await sleep(1500);
log("3 picture of a background read", { shots: shots.length - shotsBefore });
check("no picture of a background read (it would show their tab)", shots.length === shotsBefore);

// 4. The visitor tab: a second tab in the group.
const visitor = await job({ url: "https://news.ycombinator.com/item?id=1", take: { text: true }, asVisitor: true });
s = await state();
log("4 visitor", { ok: visitor.ok, groupTabs: s.wins[0].tabs.filter((t) => t.group === s.groups[0]?.id).length });
check("visitor tab joins the same group", s.groups.length === 1 && s.wins[0].tabs.filter((t) => t.group === s.groups[0].id).length === 2);

// 5. A browser session: its tab comes to the front while it works; closing gives their tab back.
const open = await job({ kind: "browser", url: "https://httpbin.org/forms/post", browser: { session: "rig1", url: "https://httpbin.org/forms/post", action: { kind: "snapshot" } } });
s = await state();
const comments = open.view?.controls?.find((c) => c.role === "textbox" && /comments|delivery instructions/i.test(c.label));
log("5a session open", { ok: open.ok, reason: open.reason, msg: open.message, controls: open.view?.controls?.length, comments, front: frontTab(s, W), state: s });
check("session tab in the group, in front", open.ok && s.questTabs?.includes(frontTab(s, W)));
const filled = comments ? await job({ kind: "browser", url: "https://httpbin.org/forms/post", browser: { session: "rig1", action: { kind: "fill", ref: comments.ref, text: "Leave it at the door\nthanks" } } }) : null;
log("5b fill", { ok: filled?.ok, reason: filled?.reason, msg: filled?.message, value: filled?.view?.controls?.find((c) => c.ref.endsWith(comments?.ref.split(":").slice(-1)[0] ?? "x"))?.value });
check("fill types into the fronted tab", Boolean(filled?.ok && filled.view.controls.some((c) => c.value === "Leave it at the door\nthanks")));
const shot = await job({ kind: "browser", url: "https://httpbin.org/forms/post", browser: { session: "rig1", action: { kind: "screenshot" } } });
log("5c screenshot", { ok: shot.ok, reason: shot.reason, msg: shot.message, size: shot.view?.screen ? `${shot.view.screen.width}x${shot.view.screen.height}` : null });
check("a picture of the session tab", Boolean(shot.ok && shot.view.screen));
await job({ kind: "browser", url: "https://httpbin.org/forms/post", browser: { session: "rig1", action: { kind: "close" } } });
s = await state();
log("5d session closed", { front: frontTab(s, W), state: s });
check("closing the session gives their tab back", frontTab(s, W) === theirActive());
check("their tabs untouched", ownIds.every((id) => s.wins.flatMap((w) => w.tabs).some((t) => t.id === id)));

// 6. Idle: after ~90 s with nothing to do, Quest's tabs close and the group goes.
const t0 = Date.now();
let idleState;
for (;;) {
  await sleep(10_000);
  idleState = await state();
  if (!idleState.groups.length || Date.now() - t0 > 180_000) break;
}
log("6 idle", { afterSeconds: Math.round((Date.now() - t0) / 1000), state: idleState });
check("group gone after idle", idleState.groups.length === 0, `${Math.round((Date.now() - t0) / 1000)} s`);
check("only their tabs left, same window", idleState.wins.length === 1 && idleState.wins[0].tabs.map((t) => t.id).sort().join() === [...ownIds].sort().join());

// 7. Disconnect closes Quest's tabs only (before 0.9.3 it closed Quest's whole window).
await job({ url: "https://news.ycombinator.com/", take: { text: true } });
s = await state();
check("a read opens the group again", s.groups.length === 1);
const pop2 = await pageSession(`chrome-extension://${extId}/popup.html`);
await evalIn(pop2.sessionId, `chrome.runtime.sendMessage({ type: "disconnect" })`);
await cdp("Target.closeTarget", { targetId: pop2.targetId });
await sleep(1500);
s = await state();
log("7 disconnect", { state: s });
check("disconnect closes the group, not their window", s.groups.length === 0 && s.wins.length === 1 && ownIds.every((id) => s.wins[0].tabs.some((t) => t.id === id)));

// 8. The window of an older version, grouped "Quest is reading", closes on the update.
const old = await evalIn(await worker(), `(async () => { const w = await chrome.windows.create({ url: ["https://example.org/", "https://example.net/"], focused: false }); const g = await chrome.tabs.group({ tabIds: w.tabs.map((t) => t.id), createProperties: { windowId: w.id } }); await chrome.tabGroups.update(g, { title: "Quest is reading" }); return w.id; })()`);
await sleep(1500);
await evalIn(await worker(), "chrome.runtime.reload()").catch(() => null);
sw = null;
await sleep(6000);
s = await state().catch((e) => ({ error: String(e) }));
log("8 old window after update", { oldWindow: old, state: s });
check("the old Quest window closed, theirs kept", Array.isArray(s.wins) && !s.wins.some((w) => w.id === old) && ownIds.every((id) => s.wins.flatMap((w) => w.tabs).some((t) => t.id === id)));

console.log("\n## SUMMARY");
for (const r of report.filter((r) => "check" in r)) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.check}`);
ws.close();
chrome.kill();
server.close();
process.exit(0);
