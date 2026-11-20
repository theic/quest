/**
 * A first run with the real manager model, in memory: someone new opens the chat, picks a language (or not), says what
 * they build in their own words, connects Chrome, and answers. Nothing reaches Telegram, a Chrome or a database. Prints
 * what Quest said, the tools it used, the brief it wrote, and the cost.
 *
 *   MQ_ENV_FILE=<path to .env.local> node --experimental-strip-types scripts/try-first-run.ts ["line" | lang:<locale|auto> | connect | warm-up-over | tap:<card>:<choice> | brief:<words> ...]
 *
 * Without lines it plays a first run: the language kept, a founder's few words about their product, then Chrome connects.
 * `lang:pt` taps a language on the first card. `connect` connects their Chrome the way pairing does; `tap:take_1:me` taps a
 * take; `brief:<words>` sets the brief, as a researcher's report would have it written.
 */
import { modelsFor } from "../apps/agent/src/model-source.ts";
import { loadConfig } from "../apps/agent/src/config.ts";
import { WARM_UP_OVER } from "../apps/agent/src/conversation/intake.ts";
import { makeWorld, telegramSender } from "../apps/agent/test/world.ts";
import { readEnvFile } from "./env-file.ts";

const env = readEnvFile();
const lines = process.argv.length > 2 ? process.argv.slice(2) : ["lang:auto", "building tally.so, a free form builder. want devs on reddit and x to try it", "connect"];
const config = loadConfig({ ...process.env, ...Object.fromEntries(env) });
const models = await modelsFor(config);
const world = makeWorld({ manager: models.modelFor("manager", { session: `try-first-run:${Date.now()}` }) });
world.clock.t = Date.now();
world.chrome.state = { linked: false, online: false, device: null, lastSeenAt: null };
// Once the setup went out, the status says when, and it is held back for half a day, as ChromeLinkService does.
let setups = 0;
const offer = world.chrome.offer.bind(world.chrome);
world.chrome.offer = async (id, opts) => {
  const out = await offer(id, opts);
  if (out.sent) {
    setups++;
    if (!world.chrome.state.linked) world.chrome.state = { ...world.chrome.state, offeredAt: new Date(world.clock.t) };
  }
  return out;
};

let ref = 1000;
let sent = 0;
let journal = 0;
async function show(): Promise<void> {
  for (const line of world.tools.slice(journal)) console.log(`      · ${line.what.slice(0, 160)}`);
  journal = world.tools.length;
  for (const m of world.channel.sent.slice(sent)) console.log(`  Quest: ${m.text.replace(/\n+/g, " / ").slice(0, 400)}${m.answers ? `\n         [tap: ${m.answers.join(" | ")}]` : ""}`);
  sent = world.channel.sent.length;
  const them = await world.customers.findByChannel(telegramSender().channel);
  for (const t of them ? await world.tasks.list(them.id) : []) {
    if (shownTasks.has(t.id)) continue;
    shownTasks.add(t.id);
    console.log(`      + ${t.agent}${t.site ? ` on ${t.site}` : ""}: ${t.title}\n        ${t.instructions.replace(/\n+/g, " ").slice(0, 600)}`);
  }
}
const shownTasks = new Set<string>();

console.log("They: /start");
await world.inbound.handle({ type: "command", from: telegramSender(), command: "start", args: "", messageRef: String(++ref) });
await show();
const customer = (await world.customers.findByChannel(telegramSender().channel))!;
for (const line of lines) {
  const started = Date.now();
  world.clock.advance(40_000);
  if (line === "connect") {
    console.log("(their Chrome connects)");
    world.chrome.state = { linked: true, online: true, device: "Chrome 155 on Windows", lastSeenAt: new Date(world.clock.t) };
    await world.messenger.say(customer.id, "✅ Chrome connected (Chrome 155 on Windows). I read in a tab group of my own, behind your tabs, so you can keep working. Closing Chrome pauses me; I carry on when it opens again.");
    await world.events.push(customer.id, {
      kind: "system",
      topic: "chrome",
      text:
        "The customer connected their Chrome (Chrome 155 on Windows), and it has been told so. Your team can read and search the web now: " +
        "start whatever was waiting on it, and tell them with message_user, in a line, what you are starting and when they will hear back.",
    });
  } else if (line.startsWith("lang:")) {
    console.log(`They tap: ${line}`);
    await world.inbound.handle({ type: "language", from: telegramSender(), locale: line.slice(5), ackRef: `l${++ref}`, messageRef: "1" });
  } else if (line === "warm-up-over") {
    console.log("(the takes are over)");
    await world.events.push(customer.id, { kind: "system", topic: "about_them", text: WARM_UP_OVER });
  } else if (line.startsWith("brief:")) {
    console.log("(the brief is written)");
    await world.customers.update(customer.id, { brief: line.slice(6) });
  } else {
    console.log(`They: ${line}`);
    await world.inbound.handle({ type: "text", from: telegramSender(), text: line, messageRef: String(++ref), replyToRef: null });
  }
  while (await world.manager.serveNext()) {
    /* every turn due now */
  }
  await show();
  console.log(`  (${((Date.now() - started) / 1000).toFixed(0)} s)\n`);
}

const c = await world.customers.get(customer.id);
console.log(`brief: ${c.brief ? `"${c.brief.slice(0, 300)}"` : "(none)"}`);
if (c.plan) console.log(`plan: ${c.plan.replace(/\n+/g, " / ")}`);
const cost = world.spend.calls.reduce((n, x) => n + (x.usage.cost ?? 0), 0);
console.log(`Chrome setup sent ${setups} time(s), asked for ${world.chrome.offers.length} time(s).`);
console.log(`${world.spend.calls.length} model calls, ${cost.toFixed(4)}.`);
