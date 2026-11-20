/**
 * A customer's Your move (asks/deck.ts) on dev: the line of what waits on them, as it ranks, and with `draw` their deck
 * drawn in their chat now, as the next change would draw it (a deck that is not the last message comes down to them).
 * `print` shows each ask as the deck would. Taps on it go to the dev agent `npm run dev` runs. Dev's database and bot only; without `draw`, nothing is sent.
 *
 *   node --experimental-strip-types scripts/try-deck.ts <customer id> [draw | print]
 *
 */
import { customerId, type Logger } from "@mq/core";
import { askActs, Deck } from "../apps/agent/src/asks/deck.ts";
import { ChannelRegistry } from "../apps/agent/src/conversation/channel-registry.ts";
import { createPool } from "../apps/agent/src/infra/db.ts";
import { PgCustomerRepository } from "../apps/agent/src/infra/pg-customers.ts";
import { PgDecks } from "../apps/agent/src/infra/pg-decks.ts";
import { PgDraftRepository } from "../apps/agent/src/infra/pg-drafts.ts";
import { PgFindRepository } from "../apps/agent/src/infra/pg-finds.ts";
import { PgIdeaRepository } from "../apps/agent/src/infra/pg-ideas.ts";
import { PgOutbox } from "../apps/agent/src/infra/pg-outbox.ts";
import { PgQuestionRepository } from "../apps/agent/src/infra/pg-questions.ts";
import { PgResultRepository } from "../apps/agent/src/infra/pg-results.ts";
import { PgTranscript } from "../apps/agent/src/infra/pg-transcript.ts";
import { PgTrustRepository } from "../apps/agent/src/infra/pg-trust.ts";
import { deckButtons, deckHtml } from "../apps/agent/src/telegram/deck-card.ts";
import { TelegramBotApi } from "../apps/agent/src/telegram/bot-api.ts";
import { TelegramChannel } from "../apps/agent/src/telegram/telegram-channel.ts";
import { checkStage, ENV_PATH, readEnvFile } from "./env-file.ts";

const [id, verb] = process.argv.slice(2);
if (!id || (verb && verb !== "draw" && verb !== "print")) throw new Error("usage: try-deck.ts <customer id> [draw | print]");
const env = readEnvFile();
await checkStage("dev", env, ENV_PATH);
const pool = createPool(env.get("DATABASE_URL")!, 2);
const log: Logger = { info: (e, d) => console.log(`  ${e} ${JSON.stringify(d ?? {})}`), warn: (e, d) => console.log(`  ! ${e} ${JSON.stringify(d ?? {})}`), error: (e, d) => console.log(`  !! ${e} ${JSON.stringify(d ?? {})}`) };
const customers = new PgCustomerRepository(pool);
const channel = new TelegramChannel(new TelegramBotApi(env.get("TELEGRAM_BOT_TOKEN")!), async (to) => (await customers.findByChannel(to))?.language ?? null);
const outbox = new PgOutbox(pool);
// A tap is the agent's to answer: this only draws.
const refused = async (): Promise<string> => "Tap it in the chat";
const deck = new Deck({
  customers,
  channels: new ChannelRegistry([channel]),
  store: new PgDecks(pool),
  finds: new PgFindRepository(pool),
  drafts: new PgDraftRepository(pool),
  questions: new PgQuestionRepository(pool),
  ideas: new PgIdeaRepository(pool),
  outbox: { waiting: (c) => outbox.active(c) },
  results: new PgResultRepository(pool),
  transcript: new PgTranscript(pool),
  trust: new PgTrustRepository(pool),
  acts: askActs(() => ({ finds: { act: refused }, drafts: { act: refused }, questions: { choose: refused }, ideas: { act: refused } })),
  clock: { now: () => new Date() },
  log,
});
const me = customerId(id);
const asks = await deck.asks(me);
console.log(`Your move for ${id}: ${asks.length}`);
for (const [i, a] of asks.entries()) {
  const what = a.kind === "find" ? `find ${a.find.source} ${a.find.author ?? ""}` : a.kind === "draft" ? `draft ${a.draft.kind} on ${a.draft.platform}${a.draft.status === "uncertain" ? " (held)" : ""}` : a.kind === "group" ? `${a.drafts.length} ${a.what}s on ${a.platform}` : a.kind === "question" ? `question: ${a.question.text.slice(0, 60)}` : a.kind === "trust" ? `offer to go alone: ${a.platform}` : `idea: ${a.idea.text.slice(0, 60)}`;
  console.log(`  ${String(i + 1).padStart(2)}. ${what}`);
}
if (verb === "print") {
  // Each ask as the deck would show it: its words in Telegram's HTML, and its buttons.
  const language = (await customers.get(me)).language;
  for (const [i, ask] of asks.entries()) {
    const view = { ask, position: i + 1, total: asks.length, prev: asks[i - 1]?.key ?? null, next: asks[i + 1]?.key ?? null, last: null };
    console.log(`\n--- ${i + 1} ---\n${deckHtml(view, new Date(), language)}`);
    console.log(deckButtons(view, language).map((row) => row.map((b) => `[${b.text}${"url" in b && b.url ? ` → ${b.url}` : ""}]`).join(" ")).join("\n"));
  }
}
if (verb === "draw") {
  await deck.changed(me);
  console.log(`Drawn: ${JSON.stringify(await new PgDecks(pool).get(me))}`);
}
await pool.end();
