/**
 * The writer, writing as a customer from what the database keeps of them (read only): their brief, their first-day
 * answers and sparring, their voice memories and their last messages. A few messages they would send, each with
 * what still gives it away, so their voice can be judged on real words after the warm-up. Nothing is written or sent.
 *
 *   MQ_ENV_FILE=<path to .env.local> node --experimental-strip-types scripts/try-voice.ts <customer id> ["their words to answer" ...]
 *
 * TRY_PLATFORM=x.com writes them as replies on X (default: Reddit, r/SaaS).
 *
 * TRY_RECENT=30 writes again the last 30 replies that went out, each on the real post and with the ones before it as what
 * it follows, and counts the shapes before and after: how long, how many with an emoji, how many opening by rating the
 * thing, how many of two sentences or more.
 *
 * Each line is something a person wrote to them; without lines it uses three a founder meets: a launch that got no
 * users, a pushback on price, a worry about bots posting as people.
 */
import { customerId, type Logger } from "@mq/core";
import { modelsFor } from "../apps/agent/src/model-source.ts";
import { loadConfig } from "../apps/agent/src/config.ts";
import { writingTells } from "../apps/agent/src/drafts/tells.ts";
import { voiceFrom, writerSystem, Writer } from "../apps/agent/src/drafts/writer.ts";
import { createPool } from "../apps/agent/src/infra/db.ts";
import { PgCustomerRepository } from "../apps/agent/src/infra/pg-customers.ts";
import { PgMemoryRepository } from "../apps/agent/src/infra/pg-memory.ts";
import { PgTranscript } from "../apps/agent/src/infra/pg-transcript.ts";
import { readEnvFile } from "./env-file.ts";

const id = process.argv[2];
if (!id) throw new Error("usage: try-voice.ts <customer id> [\"their words\" ...]");
const config = loadConfig({ ...process.env, ...Object.fromEntries(readEnvFile()) });
const models = await modelsFor(config);
const pool = createPool(config.databaseUrl, 2);
const quiet: Logger = { info: () => undefined, warn: (e, d) => console.log(`  ! ${e} ${JSON.stringify(d ?? {})}`), error: (e, d) => console.log(`  !! ${e} ${JSON.stringify(d ?? {})}`) };
const voice = voiceFrom({ customers: new PgCustomerRepository(pool), memory: new PgMemoryRepository(pool), transcript: new PgTranscript(pool), clock: { now: () => new Date() } });
const writer = new Writer({ models, voice, log: quiet });
const me = customerId(id);

const v = await voice(me);
const system = writerSystem(v);
console.log(`The writer reads (their part):\n${system.slice(system.indexOf("HOW ")).split("\n").map((l) => `   ${l}`).join("\n")}\n`);

/** How a set of messages reads, in numbers. */
const shapes = (texts: readonly string[]): string => {
  const words = texts.map((t) => t.trim().split(/\s+/).length).sort((a, b) => a - b);
  const pct = (test: (t: string) => boolean) => `${Math.round((100 * texts.filter(test).length) / texts.length)}%`;
  return [
    `${texts.length} replies`,
    `median ${words[words.length >> 1]} words`,
    `${pct((t) => t.trim().split(/\s+/).length <= 6)} under 7 words`,
    `${pct((t) => /\p{Extended_Pictographic}/u.test(t))} with an emoji`,
    `${pct((t) => /[.!?]\s+\S/.test(t))} two sentences or more`,
    `${pct((t) => /\?/.test(t))} asking`,
    `${pct((t) => /^[^.!?]{0,90}\b(is|are|sounds?|looks?|feels?)( like)? (a|an|such a|so|the|peak|my kind of)\b/i.test(t))} opening by rating it`,
  ].join(", ");
};

const recent = Number(process.env.TRY_RECENT ?? 0);
if (recent) {
  const { rows } = await pool.query<{ platform: string; author: string | null; quote: string | null; body: string }>(
    `select platform, author, quote, body from mq.drafts where customer_id = $1 and kind = 'reply' and body <> '' and quote is not null order by created_at desc limit $2`,
    [me, recent],
  );
  const lately: { platform: string; text: string }[] = [];
  const rewriter = new Writer({ models, voice, lately: async () => [...lately], log: quiet, roll: Math.random });
  const again: string[] = [];
  for (const r of rows.reverse()) {
    const out = await rewriter.write(me, { kind: "reply", platform: r.platform, place: null, author: r.author, quote: r.quote, draft: r.body, title: null });
    lately.unshift({ platform: r.platform, text: out.text });
    again.push(out.text);
    console.log(`${r.platform} "${(r.quote ?? "").slice(0, 70)}"\n  was: ${r.body}\n  now: ${out.text}${out.tells.length ? `\n  left: ${out.tells.join("; ")}` : ""}\n`);
  }
  console.log(`Before: ${shapes(rows.map((r) => r.body))}\nAfter:  ${shapes(again)}`);
  await pool.end();
  process.exit(0);
}

const lines = process.argv.slice(3).length
  ? process.argv.slice(3)
  : [
      "launched 3 weeks ago, 40 upvotes on PH and zero signups. how do you get your first 10 users?",
      "$420 a month? for a bot that writes replies? lol",
      "these AI tools that reply on reddit for you are just spam waiting to happen",
    ];
const platform = process.env.TRY_PLATFORM ?? "reddit";
for (const quote of lines) {
  const out = await writer.write(me, {
    kind: "reply",
    platform,
    place: platform === "reddit" ? "r/SaaS" : null,
    author: "someone",
    quote,
    draft: `Answer what they said, usefully and honestly, as the customer would. The facts, only from their brief:\n${(v.brief ?? "").slice(0, 900)}`,
    title: null,
  });
  const tells = writingTells(out.text, { kind: "reply", platform, language: v.language, linkAllowed: false, emoji: false });
  console.log(`They: "${quote}"\n  As them: ${out.text.replace(/\n+/g, " / ")}${tells.length ? `\n  Gives away: ${tells.join("; ")}` : ""}\n`);
}
await pool.end();
