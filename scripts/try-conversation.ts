/**
 * A conversation with the real manager model, in memory: a customer's state is read (only read) from
 * the database, the chat runs against in-memory stores and a clock the script moves, and nothing
 * reaches Telegram, the customer's Chrome or the database. Prints what Quest said, the reactions it
 * put on, what it promised and when, the tools it used, and what the model calls cost.
 *
 *   node --experimental-strip-types scripts/try-conversation.ts <customer id> ["line" | wait ...]
 *
 * Without lines it plays the founder's test of 2026-10-07: "How's it going?", "Who should we try
 * next?", a wait until the first promise falls due, then "No Reddit today please." `wait` moves the
 * clock to the next thing Quest owes and lets it run.
 */
import { customerId, type CustomerId, type MemoryKind } from "@mq/core";
import { modelsFor } from "../apps/agent/src/model-source.ts";
import { loadConfig } from "../apps/agent/src/config.ts";
import { createPool } from "../apps/agent/src/infra/db.ts";
import { PgTaskStore } from "../apps/agent/src/infra/pg-tasks.ts";
import { makeWorld, telegramSender } from "../apps/agent/test/world.ts";
import { readEnvFile } from "./env-file.ts";

const env = readEnvFile();
const id = process.argv[2];
if (!id) throw new Error("usage: try-conversation.ts <customer id> [line | wait ...]");
const lines = process.argv.length > 3 ? process.argv.slice(3) : ["How's it going?", "Who should we try next?", "wait", "No Reddit today please."];
const config = loadConfig({ ...process.env, ...Object.fromEntries(env) });
const models = await modelsFor(config);
const world = makeWorld({ manager: models.modelFor("manager", { session: `try-conversation:${id}:${Date.now()}` }) });
world.clock.t = Date.now();

// The customer as the database has it, read only.
const pool = createPool(config.databaseUrl, 1);
const one = async <T,>(sql: string): Promise<T[]> => (await pool.query(sql, [id])).rows as T[];
const [row] = await one<{
  display_name: string | null;
  quest: "founder" | "career" | "recruiting" | null;
  brief: string | null;
  plan: string | null;
  timezone: string | null;
  site_url: string | null;
  profile: Record<string, { choice: string | null; answer: string | null }>;
}>(`select display_name, quest, brief, plan, timezone, site_url, profile from mq.customers where id = $1`);
if (!row) throw new Error(`no customer ${id}`);
const memories = await one<{ kind: MemoryKind; body: string }>(`select kind, body from mq.memories where customer_id = $1 and retired_at is null order by id`);
const routes = await one<{ name: string; status: "trying" | "working" | "spent"; tries: number; wins: number; misses: number; last_note: string | null }>(
  `select name, status, tries, wins, misses, last_note from mq.routes where customer_id = $1`,
);
const finds = await one<{ source: string; url: string; author: string | null; title: string | null; quote: string; posted_at: Date | null; why: string; reply: string; strength: "strong" | "maybe" }>(
  `select source, url, author, title, quote, posted_at, why, reply, strength from mq.finds
    where customer_id = $1 and status in ('new', 'shown', 'kept') order by (strength = 'strong') desc, created_at desc limit 20`,
);
const paces = await new PgTaskStore(pool).paces(new Date(Date.now() - 14 * 86_400_000));
await pool.end();

const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: row.display_name, language: "en" });
const me: CustomerId = c.id;
await world.customers.update(me, { brief: row.brief, plan: row.plan, timezone: row.timezone, siteUrl: row.site_url, status: "active" });
await world.trust.set(me, "reddit", 0, true); // as the live account stands: ask first on Reddit
// Their first-day answers as they gave them, so no first-day card goes out in the replay.
for (const [key, entry] of Object.entries(row.profile ?? {})) {
  await world.customers.profileAsked(me, key, null, new Date());
  if (entry.choice) await world.customers.profileAnswered(me, key, { choice: entry.choice, answer: entry.answer, at: new Date() });
}
for (const m of memories) await world.memory.add(me, { kind: m.kind, text: m.body, source: "manager" });
for (const r of routes) world.routes.rows.push({ id: String(world.routes.rows.length + 1), customerId: me, name: r.name, status: r.status, tries: r.tries, wins: r.wins, misses: r.misses, lastNote: r.last_note, updatedAt: new Date() });
for (const f of finds) {
  await world.finds.save({ customerId: me, taskId: null, source: f.source, url: f.url, author: f.author, title: f.title, quote: f.quote, postedAt: f.posted_at, why: f.why, reply: f.reply, strength: f.strength });
}
world.taskStore.pace = paces;
console.log(`Replaying ${customerId(id)}: ${memories.length} memories, ${routes.length} routes, ${finds.length} finds, paces of ${paces.map((p) => p.agent).join(", ")}.\n`);

const clock = (t: number): string => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: row.timezone ?? "UTC" });
let ref = 1000;
let sent = 0;
let journal = 0;
let reactions = 0;

async function show(): Promise<void> {
  for (const line of world.tools.slice(journal)) console.log(`      · ${line.what.slice(0, 160)}`);
  journal = world.tools.length;
  for (const r of world.channel.reactions.slice(reactions)) console.log(`  Quest reacts ${r.emoji}`);
  reactions = world.channel.reactions.length;
  for (const m of world.channel.sent.slice(sent)) console.log(`  [${clock(world.clock.t)}] Quest: ${m.text}`);
  sent = world.channel.sent.length;
  for (const p of await world.commitments.open(me)) console.log(`  owes #${p.id} (${p.source}): "${p.what.slice(0, 90)}" due ${clock(p.dueAt.getTime())}, woken ${clock(p.checkAt.getTime())}`);
}

for (const line of lines) {
  const started = Date.now();
  if (line === "wait") {
    const next = (await world.commitments.open(me)).map((p) => p.checkAt.getTime()).sort((a, b) => a - b)[0];
    if (next === undefined) {
      console.log("(nothing owed to wait for)\n");
      continue;
    }
    console.log(`(the clock moves ${Math.round((next - world.clock.t) / 60_000)} min on)`);
    world.clock.t = Math.max(world.clock.t, next);
  } else {
    console.log(`[${clock(world.clock.t)}] They: ${line}`);
    await world.inbound.handle({ type: "text", from: telegramSender(), text: line, messageRef: String(++ref), replyToRef: null });
  }
  while (await world.manager.serveNext()) {
    /* every turn due now */
  }
  await show();
  console.log(`  (${((Date.now() - started) / 1000).toFixed(0)} s)\n`);
}

const cost = world.spend.calls.reduce((n, x) => n + (x.usage.cost ?? 0), 0);
console.log(`${world.spend.calls.length} model calls, $${cost.toFixed(4)}.`);
