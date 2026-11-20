/**
 * Someone new in Quest's side panel, by its own routes, against an agent on this computer (the local edition's
 * http://localhost:8787 unless given): "Start talking", then their words, then what Quest said. No Chrome is paired
 * for reading, so nothing is browsed; it shows the conversation and the asks as the panel would draw them.
 *
 *   node --experimental-strip-types scripts/try-panel.ts ["their words" ...] [--server http://localhost:8787] [--wait 90]
 */
const args = process.argv.slice(2);
const flag = (name: string, dflt: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args.splice(i, 2)[1] ?? dflt) : dflt;
};
const server = flag("--server", "http://localhost:8787");
const wait = Number(flag("--wait", "90")) * 1000;
const lines = args.length ? args : ["I built tallyreport.dev, it turns Stripe exports into a monthly revenue report for indie SaaS founders. First users, mostly from X."];

const hello = await fetch(`${server}/chrome/hello`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ device: "Chrome on Windows (try-panel)", language: "en", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
});
const { token } = (await hello.json()) as { token?: string };
if (!token) throw new Error(`hello answered ${hello.status}`);
const auth = { authorization: `Bearer ${token}` };

type Chat = { messages?: { id: number; from: string; text: string }[]; asks?: unknown[] };
const read = async (): Promise<Chat> => (await fetch(`${server}/chrome/chat`, { headers: auth })).json() as Promise<Chat>;
let shown = 0;
const show = (c: Chat) => {
  for (const m of (c.messages ?? []).slice(shown)) console.log(`${m.from === "quest" ? "  Quest" : "They"}: ${m.text}`);
  shown = c.messages?.length ?? shown;
  if (c.asks?.length) console.log(`  (${c.asks.length} waiting on them)`);
};
show(await read());
for (const line of lines) {
  const t0 = Date.now();
  await fetch(`${server}/chrome/chat`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ text: line }) });
  // Quest answers in a turn of its own: wait for words after theirs.
  for (;;) {
    const c = await read();
    const after = (c.messages ?? []).slice(shown);
    if (after.some((m) => m.from === "quest") || Date.now() - t0 > wait) {
      show(c);
      console.log(`  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
