/**
 * Whether the manager understands what the founder means: the moments it got wrong on 2026-10-14 (prod
 * chat of customer 9898ee37), replayed with the real prompt and tools in the in-memory world, one fresh
 * world per model and moment. Prints what each model said, the tools it called and the tasks it started.
 *
 *   node --experimental-strip-types scripts/try-understanding.ts [model[:effort|off] …]
 *   MQ_ONLY=marc-voice,card-voice …   (some moments only)
 *   MQ_ENV_FILE=<path to .env.local> …
 *
 * What a good answer does, per moment:
 *   marc-voice   a voice note heard as "…to fit the Mark Lou. ...": a bio in Marc Lou's style (his products
 *                and their numbers), not "your message cut off"
 *   marc-typed   the same, typed after Quest said the message was cut off
 *   marc-photo   "This is him" with a screenshot of Marc Lou's profile: he is the example, not the founder
 *   card-voice   a voice reply to a card, "Say nothing about messaging question": the card loses the product
 *   english      "English please" after a Portuguese answer: English from now on, said in English
 */
import type { CustomerId, DraftId } from "@mq/core";
import { OpenRouterModels, type ModelSeat } from "../apps/agent/src/agents/models.ts";
import { makeWorld, telegramSender } from "../apps/agent/test/world.ts";
import { ENV_PATH, readEnvFile } from "./env-file.ts";

const key = readEnvFile(ENV_PATH).get("OPENROUTER_API_KEY");
if (!key) throw new Error("OPENROUTER_API_KEY missing from .env.local");
const SPECS = process.argv.slice(2).length ? process.argv.slice(2) : ["anthropic/claude-haiku-5.5:off"];
const ONLY = (process.env["MQ_ONLY"] ?? "").split(",").filter(Boolean);

const BRIEF = `Messaging Quest (messaging.quest): a free AI you hire in Telegram. It finds the people online asking for what you offer and writes to them from your own Chrome, with your OK.
Who it is for: solo founders and indie makers looking for their first customers, freelancers looking for clients.
What they want: real users for Messaging Quest. Comments name it plainly as the founder's product. No links unless asked.`;

const VOICE_HINT = "\n(heard from a voice message: names and words may be misheard)";
const MARC_PICTURE =
  "This is him\n\n(They sent a picture. It shows: a screenshot of the X profile of Marc Lou (@marclou), verified, 38.2K posts, 410.6K followers. His bio is a list of his products with their monthly revenue: ⭐ TrustMRR.com $53K/m, 📈 DataFa.st $31K/m, CodeFa.st $7K/m, SHIPORDIE.com $3K/m, ShipFa.st $2K/m, IndiePa.ge $1K/m, Stalkr.AI, then \"+30 marclou.com\" and \"My 37 startups →\". The header reads BUILD, SHIP, EARN? next to a revenue chart.)";

type Line = readonly ["in" | "out", string];
const EARLIER: readonly Line[] = [
  ["in", "Find someone looking to get customers on X and comment about messaging quest, without adding a link, just the name - Messaging Quest."],
  ["out", "Found 3 people wanting customers on X. Short comments naming Messaging Quest, no link, are coming to your cards shortly."],
  ["in", 'Do 3 more posts on X, but use simple language and short like "keep it up".'],
  ["out", "Got it, short ones. I've started the search for 3 people on X asking for customers. Each comment goes on a card for you to tap."],
  ["out", "🔎 Draft, your reply to Ari @Panlytics_ai on x.com: https://x.com/Panlytics_ai/status/2110184412830892047\nKeep it up. Messaging Quest helped me find people asking for exactly this."],
  ["out", "3 X comments are ready: Erna first (best fit), then Ari."],
];
const CUT_OFF = 'Entendi. Sua mensagem cortou em "Mark Lou. ...", então não sei qual é a bio que você quer. Manda o texto completo e eu troco o seu perfil no X na hora.';

interface Moment {
  readonly id: string;
  readonly language: string;
  readonly before: readonly Line[];
  readonly said: string;
  /** Replies to the Ari card. */
  readonly onCard?: boolean;
}

const MOMENTS: readonly Moment[] = [
  { id: "marc-voice", language: "en", before: EARLIER, said: `update the description on my x.com account profile to fit the Mark Lou. ...${VOICE_HINT}` },
  {
    id: "marc-typed",
    language: "en",
    before: [...EARLIER, ["in", `update the description on my x.com account profile to fit the Mark Lou. ...${VOICE_HINT}`], ["out", "Your message cut off at \"Mark Lou. ...\", so I can't tell what you want it to say. Send the full text and I'll change it."]],
    said: "Update the description to my X account to fit the typical solo-founder stats, like form marc lou.",
  },
  {
    id: "marc-photo",
    language: "en",
    before: [...EARLIER, ["in", "Update the description to my X account to fit the typical solo-founder stats, like form marc lou."], ["out", "I'll update your X bio once you send the full text. Your message cut off at \"Mark Lou. ...\"."]],
    said: MARC_PICTURE,
  },
  { id: "card-voice", language: "en", before: EARLIER, said: `Say nothing about messaging question.${VOICE_HINT}`, onCard: true },
  { id: "english", language: "pt", before: [...EARLIER, ["in", `update the description on my x.com account profile to fit the Mark Lou. ...${VOICE_HINT}`], ["out", CUT_OFF]], said: "English please" },
];

async function run(spec: string, m: Moment): Promise<string> {
  const [id, effort = "off"] = spec.split(/:(?=[a-z]+$)/);
  const seat: ModelSeat = { id: id!, fallbacks: [], maxTokens: 8_000, temperature: 0.4, reasoning: effort !== "off", ...(effort !== "off" ? { effort: effort as ModelSeat["effort"] } : {}), cheapest: true };
  const models = new OpenRouterModels(key!, { manager: seat, researcher: seat, volume: seat, writer: seat, vision: seat });
  const problems: string[] = [];
  const log = { info: () => undefined, warn: (e: string, f?: Record<string, unknown>) => void problems.push(`${e} ${JSON.stringify(f ?? {}).slice(0, 300)}`), error: (e: string, f?: Record<string, unknown>) => void problems.push(`${e} ${JSON.stringify(f ?? {}).slice(0, 300)}`) };
  const world = makeWorld({ manager: models.modelFor("manager", { session: `understanding:${spec}:${m.id}:${Date.now()}` }) }, { log });
  world.clock.t = Date.parse("2026-10-14T13:00:00Z");
  const from = { ...telegramSender(), displayName: "Serhii", language: m.language };
  const c = await world.customers.create({ channel: from.channel, userRef: "42", displayName: "Serhii", language: m.language });
  await world.customers.update(c.id, { status: "active", siteUrl: "https://messaging.quest/", brief: BRIEF, timezone: "Europe/Lisbon" });
  await world.memory.add(c.id, { kind: "decision", text: "Comments name Messaging Quest plainly as his product, without a link, just the name.", source: [] } as never).catch(() => undefined);
  let ref = 100;
  for (const [dir, text] of m.before) {
    world.clock.t += 60_000;
    if (dir === "in") await world.transcript.recordIncoming(c.id, "telegram", String(ref++), text);
    else await world.transcript.recordOutgoing(c.id, "telegram", String(ref++), text);
  }
  let replyToRef: string | null = null;
  let draftId: DraftId | null = null;
  if (m.onCard) {
    const d = await world.draftStore.add({ customerId: c.id as CustomerId, kind: "reply", platform: "x.com", url: "https://x.com/Panlytics_ai/status/2110184412830892047", target: "Ari @Panlytics_ai", title: null, author: "Ari @Panlytics_ai", quote: "Building Panlytics alone. 3 months in, finally got my first 5 users. Now how do I find the next 50?", text: "Keep it up. Messaging Quest helped me find people asking for exactly this." });
    await world.draftStore.markShown(d.id, "131");
    replyToRef = "131";
    draftId = d.id;
  }
  world.clock.t += 120_000;
  await world.inbound.handle({ type: "text", from, text: m.said, messageRef: String(ref++), replyToRef });
  const started = Date.now();
  let error = "";
  try {
    await world.manager.serveNext();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const cost = world.spend.calls.reduce((s, x) => s + (x.usage?.cost ?? 0), 0);
  const tools = world.tools.filter((l) => l.who === "Quest").map((l) => l.what.slice(0, 160));
  const tasks = (await world.tasks.list(c.id)).map((t) => `${t.agent}: "${t.title}" ${t.instructions.replace(/\s+/g, " ").slice(0, 300)}`);
  const said = world.channel.sent.map((x) => x.text).join(" ⏎ ");
  const card = draftId ? (await world.draftStore.get(draftId))?.text : null;
  const language = (await world.customers.get(c.id)).language;
  return [
    `--- ${m.id} · ${spec} · ${((Date.now() - started) / 1000).toFixed(0)} s · ${world.spend.calls.length} calls · $${cost.toFixed(4)}${error ? ` · FAILED ${error.slice(0, 120)}` : ""}`,
    `  said: ${said || "(nothing)"}`,
    tools.length ? `  tools: ${tools.join(" | ")}` : "",
    ...tasks.map((t) => `  task ${t}`),
    card ? `  card now: ${card}` : "",
    m.id === "english" ? `  language now: ${language}` : "",
    ...problems.slice(0, 4).map((p) => `  ! ${p}`),
  ]
    .filter(Boolean)
    .join("\n");
}

const moments = MOMENTS.filter((m) => !ONLY.length || ONLY.includes(m.id));
const outputs = await Promise.all(SPECS.map(async (spec) => {
  const out: string[] = [];
  for (const m of moments) out.push(await run(spec, m).catch((e) => `--- ${m.id} · ${spec} · CRASHED ${e instanceof Error ? e.message : e}`));
  return out;
}));
for (const m of moments.keys()) for (const o of outputs) console.log(o[m]);
