/**
 * Does the writer keep a reply plain when the product may not come up yet (drafts/warm-up.ts)? The writer seat
 * (Claude Sonnet 5.5, as deployed) on the three find replies the dev bot showed on 2026-10-21, each of which named
 * Messaging Quest to a stranger: once as before, once with `plain`. Prints the words, and whether they still promote.
 *
 *   node --experimental-strip-types scripts/try-plain.ts
 *   MQ_ENV_FILE=<path to .env.local> …   (when the key lives in another checkout)
 */
import type { CustomerId } from "@mq/core";
import { OpenRouterModels, type ModelSeat } from "../apps/agent/src/agents/models.ts";
import { productNames, promotes } from "../apps/agent/src/drafts/warm-up.ts";
import { Writer, type Voice, type WritingJob } from "../apps/agent/src/drafts/writer.ts";
import { ENV_PATH, readEnvFile } from "./env-file.ts";

const key = readEnvFile(ENV_PATH).get("OPENROUTER_API_KEY");
if (!key) throw new Error("OPENROUTER_API_KEY missing from the env file");

const VOICE: Voice = {
  name: "Serhii",
  language: "en",
  brief:
    "Messaging Quest (messaging.quest): an AI you hire in Telegram that builds your brand while you build the product. It learns your work once, then posts on your social networks in your voice, answers people and your mentions, and reports each evening. For solo founders and indie makers. Free tier, no card.",
  rules: [],
  asked: [],
};

const JOBS: readonly WritingJob[] = [
  {
    kind: "reply", platform: "reddit", place: "r/DigitalMarketing", author: "ClaudiaFlorina_", title: null,
    quote: "Is there an app or website that builds a social media strategy and generates content based on your answers to a few questions?",
    draft: "I make Messaging Quest, so I'm biased, but it's close to what you describe. You teach it your work once instead of prompting every time, then it posts from your own accounts in your own voice. It works in your Chrome where you're already signed in, and there's a free tier with no card.",
  },
  {
    kind: "reply", platform: "indiehackers.com", place: null, author: "B Dunfee", title: null,
    quote: "I can keep building and maintaining my apps, but getting them in front of the right people is a different job! … I'm trying to figure out when bringing in marketing help makes sense.",
    draft: "I can't say when the right moment is for you, but I'd hire help once the same marketing task keeps eating the hours you'd spend on BubbaCode. Until then, a small daily habit like posting what you shipped and replying to people who ask for something like your app usually covers a lot. I'm Serhii, I make Messaging Quest, which handles some of that posting.",
  },
  {
    kind: "reply", platform: "reddit", place: "r/buildinpublic", author: "mariykastory", title: null,
    quote: "How do you market a startup on Reddit without becoming “that guy” who constantly promotes?",
    draft: "Answering people who already asked for something like what you built works better than posting a link. Search the sub for \"looking for\" or \"any tool for\" threads, read the rules first, and give a real answer before you mention yours. I make Messaging Quest, which does some of that for me, but by hand is fine at the start.",
  },
];

const seat: ModelSeat = { id: "anthropic/claude-sonnet-5.5", fallbacks: [], maxTokens: 1_200, temperature: 0.6, reasoning: true, effort: "low" };
const unused: ModelSeat = { id: "unused", fallbacks: [], maxTokens: 100, temperature: 0, reasoning: false };
const models = new OpenRouterModels(key, { manager: unused, researcher: unused, volume: unused, writer: seat, vision: unused });
const quiet = { info: () => {}, debug: () => {}, error: () => {}, warn: () => {} } as never;
const writer = new Writer({ models, voice: async () => VOICE, log: quiet });
const names = productNames("https://messaging.quest/");

for (const job of JOBS) {
  for (const plain of [false, true]) {
    const w = await writer.write("try" as CustomerId, { ...job, ...(plain ? { plain } : {}) });
    console.log(`\n${job.place ?? job.platform} · ${plain ? "plain" : "as before"} · ${promotes(w.text, names) ? "PROMOTES" : "plain"}\n${w.text}`);
  }
}
