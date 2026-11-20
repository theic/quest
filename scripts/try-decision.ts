/**
 * How each model decides, on a real ask: one manager turn with the real prompt and tools, in the
 * in-memory world the tests use (no database, no Chrome, no Telegram), with the model live on
 * OpenRouter. Prints what it started (teammate, site, title, instructions), every tool it called,
 * its reply, its calls and what they cost. A few cents a model.
 *
 *   node --experimental-strip-types scripts/try-decision.ts [model id …]
 *   MQ_ASK="Find people on LinkedIn who …" …   (another ask)
 *   MQ_ENV_FILE=<path to .env.local> …   (when the key lives in another checkout)
 */
import { OpenRouterModels, type ModelSeat } from "../apps/agent/src/agents/models.ts";
import { makeWorld, telegramSender } from "../apps/agent/test/world.ts";
import { ENV_PATH, readEnvFile } from "./env-file.ts";

const env = readEnvFile(ENV_PATH);
const key = env.get("OPENROUTER_API_KEY");
if (!key) throw new Error("OPENROUTER_API_KEY missing from .env.local");
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ["xiaomi/mimo-v2.6-pro"];
const ask =
  process.env["MQ_ASK"] ?? "Find someone looking to get customers on X and comment about messaging quest, without adding a link, just the name - Messaging Quest.";

const BRIEF = `Messaging Quest (messaging.quest): a free AI you hire in Telegram. You tell it who you need (customers, work, hires); it finds the people online who are asking for that right now and writes to them from your own Chrome, with your OK.
Who it is for: solo founders and indie makers looking for their first customers, freelancers looking for clients.
What they want: real users for Messaging Quest. Comments name it plainly as the founder's product. No links unless asked.
Not wanted: spam, bulk posting, fake bystander voices.`;

const PLAN = `Goal: advertise messaging.quest and get real users.
Where things stand: brief settled, 16 finds waiting. Reddit replies are working; r/Entrepreneur removed one reply.
Next: more founders asking how to get their first users.`;

for (const id of ids) {
  const seat: ModelSeat = { id, fallbacks: [], maxTokens: 8_000, temperature: 0.4, reasoning: false, cheapest: true };
  const models = new OpenRouterModels(key, { manager: seat, researcher: seat, volume: seat, writer: seat, vision: seat });
  const world = makeWorld({ manager: models.modelFor("manager", { session: `decision:${id}:${Date.now()}` }) });
  const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Serhii", language: "en" });
  await world.customers.update(c.id, { status: "active", siteUrl: "https://messaging.quest/", brief: BRIEF, plan: PLAN });
  await world.inbound.handle({ type: "text", from: telegramSender(), text: ask, messageRef: "100", replyToRef: null });

  const started = Date.now();
  let error: string | null = null;
  try {
    await world.manager.serveNext();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const tasks = await world.tasks.list(c.id);
  const calls = world.spend.calls;
  const cost = calls.reduce((s, x) => s + (x.usage?.cost ?? 0), 0);
  console.log(`\n=== ${id}: ${((Date.now() - started) / 1000).toFixed(0)} s, ${calls.length} model calls, $${cost.toFixed(4)}${error ? `, failed: ${error}` : ""}`);
  console.log("tools:", world.tools.filter((l) => l.who === "Quest").map((l) => l.what.split(" · ")[0]).join(", ") || "(none)");
  for (const t of tasks) {
    const site = (t as { site?: string | null }).site;
    console.log(`task: ${t.agent}${site ? ` on ${site}` : ""} · "${t.title}"\n  ${t.instructions.replace(/\s+/g, " ").slice(0, 400)}`);
  }
  console.log("said:", world.channel.sent.map((m) => m.text).join(" | ").slice(0, 400) || "(nothing)");
}
