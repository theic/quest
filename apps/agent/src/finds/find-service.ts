import { promotes, type WarmUp } from "../drafts/warm-up.ts";
import {
  AlreadyAnswered,
  askKeys,
  ChromeError,
  TooLong,
  placeKeys,
  SKIP_REASON_WORDS,
  sourceLabel,
  platformFor,
  type Ask,
  type BrowserView,
  type ChromePosted,
  type Clock,
  type CustomerId,
  type DraftRepository,
  type EventSink,
  type Find,
  type FindAction,
  type FindCounts,
  type FindDecision,
  type FindId,
  type OutboxItem,
  type FindRepository,
  type Logger,
  type NewFind,
  type PlaceRepository,
  type ReplyPoster,
  type TaskId,
} from "@mq/core";
import { findLine, type AskDeck } from "../asks/deck.ts";
import { bodyShown } from "../chrome/posted-body.ts";
import type { Messenger } from "../conversation/messenger.ts";
import type { Autopilot } from "../drafts/autopilot.ts";
import { noteApplied, type WriterPort } from "../drafts/writer.ts";
import { QUEUED, type Outbox, type OutboxSender, type SendOutcome } from "../drafts/outbox.ts";
import type { Errands } from "../lifecycle/errands.ts";
import { normalizeUrl } from "../lib/urls.ts";
import { nextLook } from "./reply-watch.ts";

const DAY_MS = 86_400_000;
/** How long an undecided card holds its place among the few open at once. */
export const STALE_CARD_MS = 3 * DAY_MS;

export interface ShowOutcome {
  readonly shown: number;
  /** Where the shown ones came from, e.g. "2 from Hacker News, 1 from Bluesky". */
  readonly sources: string;
  /** Cards in front of the customer, waiting for a decision. */
  readonly open: number;
  /** Finds not shown yet. */
  readonly waiting: number;
  /** Of the shown, the replies going up by themselves. */
  readonly alone?: number;
}

/** Where a customer's finds stand, for the manager's turn. */
export interface FindBoard {
  readonly counts: FindCounts;
  /** The next finds to be shown, best first. */
  readonly waiting: readonly Find[];
  readonly recent: readonly Find[];
}

/** What the scout needs from the finds: saving them, and knowing what the customer thought of earlier ones. */
export interface FindLedger {
  save(input: NewFind): Promise<Find | null>;
  known(customerId: CustomerId, urls: readonly string[]): Promise<Set<string>>;
  feedback(customerId: CustomerId): Promise<string>;
  /** What a task saved, from the record: the manager reads this rather than the task's own count. */
  taskFacts(customerId: CustomerId, taskId: TaskId): Promise<string>;
  /** Drops the finds not shown yet from a place (by its key) that turned out to forbid such messages; returns how many. */
  dropWaitingFrom(customerId: CustomerId, key: string): Promise<number>;
}

/** "2 from Hacker News, 1 from Bluesky". */
export function bySource(finds: readonly Find[]): string {
  const counts = new Map<string, number>();
  for (const f of finds) {
    const label = sourceLabel(f.source, f.url);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, n]) => `${n} from ${label}`).join(", ");
}

const ACK: Readonly<Record<FindDecision, string>> = {
  kept: "Kept",
  skipped: "Skipped. Why? (optional)",
  replied: "Nice. Noted that you replied",
};

/** What stopped a post ("your reply to dana on Reddit", "your post in r/nocode"), in words the customer can act on. */
export function notPosted(e: unknown, which: string, platform = "Reddit"): string {
  if (e instanceof TooLong) return `Too long: ${which} has ${e.length} characters, and the field takes ${e.limit}. Tap Edit to make it shorter, or post it yourself.`;
  const reason = e instanceof ChromeError ? e.reason : "unavailable";
  const said = e instanceof Error ? e.message : String(e);
  switch (reason) {
    case "offline":
      return `I couldn't post ${which}: your Chrome isn't connected right now. Open Chrome, then tap Post it again.`;
    case "login":
      return platform === "Reddit" ? `I couldn't post ${which}: this Chrome isn't logged in to Reddit. Log in at reddit.com in Chrome, then tap Post it again.` : `I couldn't post ${which}: your Chrome isn't signed in to ${platform}. Sign in there and tap Post it again, or skip it if you have no account there.`;
    case "rate_limited":
      return `${platform} wants a pause before your next comment, so ${which} is still waiting for you ("${said}"). Tap Post it again in a few minutes.`;
    case "refused":
      return `${platform} didn't take ${which}: "${said}". The text is still waiting in Your move if you'd rather post it yourself.`;
    case "outdated":
      return "Your Quest extension is older than this. Open chrome://extensions, reload Messaging Quest, then tap Post it again.";
    case "timeout":
      return `Your Chrome didn't finish posting ${which} in time. Check the thread before you tap Post it again, so it doesn't go up twice.`;
    // Quest's own failure on the page, not the site's answer: what went wrong inside is for the log (live, 2026-10-13,
    // "x.com didn't take your post: That picture is stale" blamed the site for a picture id the model got wrong).
    case "unavailable":
      return `I couldn't post ${which}, and nothing was sent. Tap Post it to try again, or post it yourself.`;
    default:
      return `Posting ${which} didn't work (${said}). The text is still waiting in Your move if you'd rather post it yourself.`;
  }
}

/** How a find's reply is named in the chat ("your reply to u/ana on Reddit"). */
const replyLabel = (find: Find): string => `your reply to ${find.author ?? "that post"} on ${sourceLabel(find.source, find.url)}`;

/** The same for a like, a follow or a profile edit, whose card's button is `button` ("Like it"). */
export function notDone(e: unknown, which: string, platform: string, button: string): string {
  if (e instanceof TooLong) return `Too long: ${which} has ${e.length} characters, and the field takes ${e.limit}. Tap Edit to make it shorter.`;
  const reason = e instanceof ChromeError ? e.reason : "unavailable";
  const said = e instanceof Error ? e.message : String(e);
  switch (reason) {
    case "offline":
      return `I couldn't do ${which}: your Chrome isn't connected right now. Open Chrome, then tap ${button} again.`;
    case "login":
      return `I couldn't do ${which}: sign in to ${platform} in your browser, then tap ${button} again.`;
    case "rate_limited":
      return `${platform} wants a short pause, so ${which} is still waiting. Tap ${button} again in a few minutes.`;
    case "refused":
      return `${platform} didn't let me do ${which}: "${said}". It's still waiting in Your move.`;
    case "outdated":
      return `Your Quest extension is older than this. Open chrome://extensions, reload Messaging Quest, then tap ${button} again.`;
    case "timeout":
      return `Your Chrome didn't finish ${which} in time. Check the page before you tap ${button} again.`;
    default:
      return `I couldn't do ${which}, and nothing changed. Tap ${button} to try again.`;
  }
}

const decisionLine = (f: Find): string => {
  const what = f.status === "skipped" ? `skipped${f.skipReason ? ` (${SKIP_REASON_WORDS[f.skipReason].toLowerCase()})` : ""}` : f.status;
  return `- ${what}: ${sourceLabel(f.source, f.url)}${f.author ? `, ${f.author}` : ""}: "${f.quote.slice(0, 140)}"`;
};

/** What the writer needs for a find's reply: the post it answers, where, and the words as drafted. */
const findJob = (f: Find, draft: string): Parameters<WriterPort["write"]>[1] => ({
  kind: "reply",
  platform: platformFor(f.url),
  place: f.source.includes(":") ? f.source.slice(f.source.indexOf(":") + 1) : null,
  author: f.author,
  quote: f.quote,
  draft,
  title: null,
});

export interface FindServiceDeps {
  /**
   * Whether a first-day card waits on them: no find card goes out meanwhile, since the takes answer the first sweep's
   * finds one at a time and the rest come after.
   */
  readonly cardsWait?: (customerId: CustomerId) => Promise<boolean>;
  /** Your move (asks/deck.ts): a find goes there, not on a card of its own. Without it, each find is its own card. */
  readonly deck?: AskDeck;
  readonly finds: FindRepository;
  readonly events: EventSink;
  readonly messenger: Messenger;
  /** Posts a reply in the customer's Chrome, for "Post it". */
  readonly poster: ReplyPoster;
  /** Where a post runs after its tap is acknowledged. */
  readonly errands: Errands;
  /** Where everything that goes out waits its turn, and their Chrome (drafts/outbox.ts). */
  readonly outbox: Outbox;
  /** Drafts Quest wrote, posted on taps too: they count against the same daily limit. */
  readonly drafts?: Pick<DraftRepository, "sentSince">;
  /** The customer's places: a find from one filed as avoid is never shown. */
  readonly places: Pick<PlaceRepository, "listFor">;
  /** Whether Quest posts a strong find's reply by itself yet. Without it, every reply waits for a tap. */
  readonly autopilot?: Autopilot;
  /** Puts a find's reply in their voice just before its card shows: only the replies they see are written. */
  readonly writer?: WriterPort;
  /** The product comes last (drafts/warm-up.ts): a find's reply is written plain while it is too soon. */
  readonly warmUp?: WarmUp;
  readonly cardsAtOnce: number;
  readonly clock: Clock;
  readonly log: Logger;
}

/**
 * The finds between the scout and the customer. The scout saves them; the manager
 * decides when they are shown; the customer keeps, skips or replies on each card
 * (by hand, or with "Post it", which posts it from their own account in their
 * Chrome), and the next waiting card follows on its own, a few at a time. When
 * the last one is decided, the manager hears so it can look for more.
 */
export class FindService implements FindLedger, OutboxSender {
  readonly #finds: FindRepository;
  readonly #events: EventSink;
  readonly #messenger: Messenger;
  readonly #poster: ReplyPoster;
  readonly #errands: Errands;
  readonly #outbox: Outbox;
  readonly #drafts: Pick<DraftRepository, "sentSince"> | null;
  readonly #places: Pick<PlaceRepository, "listFor">;
  readonly #autopilot: Autopilot | null;
  readonly #writer: WriterPort | null;
  readonly #warmUp: WarmUp | null;
  readonly #cardsAtOnce: number;
  readonly #cardsWait: ((customerId: CustomerId) => Promise<boolean>) | null;
  readonly #deck: AskDeck | null;
  readonly #clock: Clock;
  readonly #log: Logger;

  constructor(deps: FindServiceDeps) {
    this.#finds = deps.finds;
    this.#events = deps.events;
    this.#messenger = deps.messenger;
    this.#poster = deps.poster;
    this.#errands = deps.errands;
    this.#outbox = deps.outbox;
    this.#drafts = deps.drafts ?? null;
    this.#places = deps.places;
    this.#autopilot = deps.autopilot ?? null;
    this.#writer = deps.writer ?? null;
    this.#warmUp = deps.warmUp ?? null;
    this.#cardsAtOnce = deps.cardsAtOnce;
    this.#cardsWait = deps.cardsWait ?? null;
    this.#deck = deps.deck ?? null;
    this.#clock = deps.clock;
    this.#log = deps.log;
  }

  /** Saves under the address's one spelling, so the same post is never shown twice. */
  save(input: NewFind): Promise<Find | null> {
    return this.#finds.add({ ...input, url: normalizeUrl(input.url) });
  }

  /** Of these addresses (however spelled), the ones the customer already has a find for. */
  async known(customerId: CustomerId, urls: readonly string[]): Promise<Set<string>> {
    const pairs = urls.map((u) => [u, normalizeUrl(u)] as const);
    const hits = await this.#finds.known(customerId, pairs.map(([, n]) => n));
    return new Set(pairs.filter(([, n]) => hits.has(n)).map(([u]) => u));
  }

  /**
   * Puts the best waiting finds in front of the customer, never more open cards than the chat should
   * hold. Where Quest posts by itself, a strong find's reply goes up too, and its card shows it.
   */
  async show(customerId: CustomerId, max = this.#cardsAtOnce): Promise<ShowOutcome> {
    await this.#dropAvoided(customerId);
    const counts = await this.#finds.counts(customerId);
    // A card left undecided for days no longer holds its place (live, 2026-10-04: three week-old cards for a
    // product they dropped held every place, and 136 new finds could not be shown).
    const fresh = this.#clock.now().getTime() - STALE_CARD_MS;
    const open = (await this.#finds.listFor(customerId, ["shown"], 100)).filter((f) => (f.shownAt?.getTime() ?? 0) > fresh).length;
    const budget = (await this.#cardsWait?.(customerId)) ? 0 : Math.min(max, this.#cardsAtOnce - open);
    const shown: Find[] = [];
    let alone = 0;
    if (budget > 0) {
      // Written side by side, shown in order: a few seconds for the lot rather than for each.
      const next = await Promise.all((await this.#finds.nextToShow(customerId, budget)).map((f) => this.#inTheirVoice(f)));
      for (const { find: f, sells } of next) {
        const ref = this.#deck ? null : await this.#messenger.showFind(customerId, f);
        await this.#finds.markShown(f.id, ref);
        shown.push(f);
        const platform = platformFor(f.url);
        const trusted = Boolean(await this.#autopilot?.alone(customerId, platform));
        // A reply that still names the product too soon waits for their tap: never up by itself.
        if (trusted && !sells && (f.replyTo || platform !== "reddit") && f.strength === "strong" && (await this.#start({ ...f, status: "shown", cardRef: ref }, f.replyTo ?? f.url, true)) === null) alone++;
      }
      if (shown.length) await this.#deck?.changed(customerId);
    }
    return { shown: shown.length, sources: bySource(shown), open: open + shown.length - alone, waiting: counts.new - shown.length, ...(alone ? { alone } : {}) };
  }

  /**
   * The best finds not shown yet, leaving these out: what the takes answer. The first sweep's own (saved by no task)
   * come first, strong first within them, so the takes answer what it just found.
   */
  async waiting(customerId: CustomerId, leave: ReadonlySet<string>, limit: number): Promise<Find[]> {
    await this.#dropAvoided(customerId);
    const next = (await this.#finds.nextToShow(customerId, limit + leave.size + 50)).filter((f) => !leave.has(f.id));
    return [...next.filter((f) => f.taskId === null), ...next.filter((f) => f.taskId !== null)].slice(0, limit);
  }

  /**
   * A find whose reply they said is them in a take: its card, with those words as they approved them, to post with a
   * tap. False when it moved on meanwhile.
   */
  async offer(customerId: CustomerId, id: FindId, reply: string): Promise<boolean> {
    const f = await this.#finds.get(id);
    if (!f || f.customerId !== customerId || f.status !== "new") return false;
    const revised = (await this.#finds.revise(id, reply.trim())) ?? f;
    const ref = this.#deck ? null : await this.#messenger.showFind(customerId, revised);
    await this.#finds.markShown(id, ref);
    // Their word on a take is a tap: its card comes now, though the first-day cards go on.
    await this.#deck?.changed(customerId);
    this.#autopilot?.note(customerId, "Quest", `offered the reply to ${f.author ?? "a post"} on ${sourceLabel(f.source, f.url)} they approved in a take`);
    return true;
  }

  /**
   * Their note on a find's card whose reply is not up yet (a reply to the card, typed or said, or their answer to
   * Edit): the writer puts it into the reply, and the card comes back under the note, the older copy without its
   * buttons. What the manager should know of it; null when the message is no such card or the writer could not do it.
   */
  async applyNote(customerId: CustomerId, ref: string, note: string): Promise<string | null> {
    const f = await this.#finds.byCard(customerId, ref);
    return f ? this.#note(customerId, f, note) : null;
  }

  /** The same for the find the deck shows (Your move), when they replied to the deck. */
  async noteOnAsk(customerId: CustomerId, ask: Ask, note: string): Promise<string | null> {
    if (ask.kind !== "find" || ask.find.customerId !== customerId) return null;
    const f = await this.#finds.get(ask.find.id);
    return f ? this.#note(customerId, f, note) : null;
  }

  async #note(customerId: CustomerId, f: Find, note: string): Promise<string | null> {
    if (!this.#writer || f.sentAt || (f.postState ?? "open") !== "open" || !f.reply.trim() || this.#errands.running(`post:${f.id}`)) return null;
    await this.#outbox.drop({ findId: f.id }, "their note changes it");
    const w = await this.#writer.write(customerId, { ...findJob(f, f.reply), note });
    if (!w.rewritten) return null;
    const revised = await this.#finds.revise(f.id, w.text);
    if (!revised) return null;
    this.#autopilot?.note(customerId, "Quest", `rewrote the reply to ${f.author ?? "a post"} on ${sourceLabel(f.source, f.url)} from their note`);
    // The card (or the deck showing it) comes back under the note.
    const shown = f.cardRef || !this.#deck ? await this.#messenger.showFind(customerId, revised, true) : null;
    if (shown) {
      await this.#finds.moveCard(f.id, shown);
      if (f.cardRef) await this.#messenger.closeCard(customerId, f.cardRef);
    } else if (!f.cardRef && this.#deck) await this.#deck.changed(customerId, { down: askKeys.find(f.id), last: null });
    else await this.#redraw(revised);
    return noteApplied(`the card of ${f.author ?? "a person"} on ${sourceLabel(f.source, f.url)} (find ${f.id})`, revised.reply);
  }

  /** For a reply to a find's card: which find it was, what the person said and the reply on it now, for the manager. */
  async aboutCard(customerId: CustomerId, ref: string): Promise<string | null> {
    const f = await this.#finds.byCard(customerId, ref);
    return f ? this.#about(f) : null;
  }

  async aboutAsk(customerId: CustomerId, ask: Ask): Promise<string | null> {
    if (ask.kind !== "find" || ask.find.customerId !== customerId) return null;
    const f = await this.#finds.get(ask.find.id);
    return f ? this.#about(f) : null;
  }

  #about(f: Find): string {
    return (
      `(Their reply to the card of ${f.author ?? "a person"} on ${sourceLabel(f.source, f.url)}: find ${f.id}${f.sentAt ? ", already posted" : ""}. ` +
      `The person wrote: "${f.quote.slice(0, 400)}". The reply on the card now: "${f.reply}")`
    );
  }

  /**
   * The find with its reply in their voice, saved; as it was when there is no writer, it failed, or the find moved on.
   * While the product may not come up yet (warm-up.ts), the writer keeps it plain; `sells` when it still names the
   * product or carries a link all the same, so it waits for their tap.
   */
  async #inTheirVoice(f: Find): Promise<{ readonly find: Find; readonly sells: boolean }> {
    const warm = this.#warmUp && f.reply.trim() ? await this.#warmUp.check(f.customerId, platformFor(f.url), f.author ?? "the person", f.quote) : null;
    const sells = (find: Find): boolean => Boolean(warm?.why && promotes(find.reply, warm.names));
    if (!this.#writer || !f.reply.trim()) return { find: f, sells: sells(f) };
    const w = await this.#writer.write(f.customerId, { ...findJob(f, f.reply), ...(warm?.why ? { plain: true } : {}) });
    if (!w.rewritten || w.text === f.reply) return { find: f, sells: sells(f) };
    const revised = (await this.#finds.revise(f.id, w.text)) ?? f;
    return { find: revised, sells: sells(revised) };
  }

  /**
   * New words for a find's reply still on its card; the card shows them at once. Their own words (`theirs`) go on as
   * they wrote them; words rewritten from their note go through the writer, which reads that note among their last messages.
   */
  async revise(customerId: CustomerId, id: FindId, reply: string, theirs = false): Promise<Find | string> {
    const find = await this.#finds.get(id);
    if (!find || find.customerId !== customerId) return "there is no such card";
    if (find.sentAt) return "it is already up";
    if (find.postState === "posting" || find.postState === "uncertain") return "inspect the held send before changing its words";
    if (this.#errands.running(`post:${find.id}`)) return "it is going up right now";
    await this.#outbox.drop({ findId: id }, "its words changed");
    const words = !theirs && this.#writer ? (await this.#writer.write(customerId, findJob(find, reply.trim()))).text : reply.trim();
    const revised = await this.#finds.revise(id, words);
    if (!revised) return "that card is closed";
    this.#autopilot?.note(customerId, "Quest", `rewrote the reply to ${find.author ?? "a post"} on ${sourceLabel(find.source, find.url)}`);
    await this.#redraw(revised);
    return revised;
  }

  /** A button on a card. Returns the few words the press is acknowledged with. */
  async act(customerId: CustomerId, id: FindId, action: FindAction): Promise<string> {
    const find = await this.#finds.get(id);
    if (!find || find.customerId !== customerId) return "That one is no longer here";

    if ((action.kind === "retry_post" || action.kind === "post") && this.#autopilot?.switchedOff(customerId)) return "Quest is off: switch it on to post";
    if (action.kind === "retry_post") {
      if (this.#errands.running(`post:${id}`)) return "Still sending; wait for its outcome";
      if (find.postState !== "posting" && find.postState !== "uncertain") return "That reply is not held";
      await this.#finds.endPost(id, false);
      return this.#post({ ...find, postState: "open" });
    }

    if (action.kind === "post") return this.#post(find);

    if (action.kind === "edit") {
      if (find.sentAt) return "Already posted";
      if (this.#errands.running(`post:${find.id}`)) return "Already posting it";
      // Changing it takes it out of the line: what goes up is what they settle on, on a tap.
      if (await this.#outbox.drop({ findId: id }, "they are editing it")) await this.#redraw(find);
      const under = find.cardRef ?? (await this.#deck?.ref(customerId)) ?? null;
      const asked = under ? await this.#messenger.askEdit(customerId, under) : null;
      if (!asked) return "Reply to it with your changes";
      await this.#finds.addRef(id, asked);
      return "";
    }

    if (action.kind === "reason") {
      const updated = await this.#finds.giveReason(id, action.reason);
      if (!updated) return "Already noted";
      await this.#redraw(updated);
      return "Thanks, that helps the next search";
    }

    // Skipped, or replied by hand: its reply does not go up from the line. Kept, it still may.
    if (action.decision !== "kept") await this.#outbox.drop({ findId: id }, action.decision);
    const decided = await this.#finds.decide(id, action.decision);
    if (!decided) return "Already decided";
    await this.#redraw(decided);
    await this.#next(customerId);
    return ACK[action.decision];
  }

  async board(customerId: CustomerId): Promise<FindBoard> {
    const [counts, waiting, recent] = await Promise.all([
      this.#finds.counts(customerId),
      this.#finds.nextToShow(customerId, 10),
      this.#finds.listFor(customerId, ["kept", "skipped", "replied"], 6),
    ]);
    return { counts, waiting, recent };
  }

  /**
   * The best people found so far, for a shortlist: the ones they kept or replied to, then strong ones on a
   * card or waiting, then the rest; each with its link. Skipped ones are never on it.
   */
  async best(customerId: CustomerId, count: number): Promise<Find[]> {
    const [decided, shown, waiting] = await Promise.all([
      this.#finds.listFor(customerId, ["kept", "replied"], 20),
      this.#finds.listFor(customerId, ["shown"], 30),
      this.#finds.nextToShow(customerId, 30),
    ]);
    const open = [...shown, ...waiting];
    const ranked = [...decided, ...open.filter((f) => f.strength === "strong"), ...open.filter((f) => f.strength !== "strong")];
    return ranked.filter((f, i) => ranked.findIndex((g) => g.id === f.id) === i).slice(0, count);
  }

  /** The finds by these people (names with or without "u/"), decided ones first: for their links when Quest names them. */
  async byAuthors(customerId: CustomerId, authors: readonly string[]): Promise<Find[]> {
    const bare = (a: string): string => a.replace(/^u\//, "").toLowerCase();
    const wanted = new Set(authors.map(bare));
    if (!wanted.size) return [];
    const [decided, shown, waiting] = await Promise.all([
      this.#finds.listFor(customerId, ["kept", "replied"], 100),
      this.#finds.listFor(customerId, ["shown"], 200),
      this.#finds.nextToShow(customerId, 100),
    ]);
    return [...decided, ...shown, ...waiting].filter((f) => f.author && wanted.has(bare(f.author)));
  }

  /** What the customer thought of earlier finds, for the scout to steer by. */
  async feedback(customerId: CustomerId): Promise<string> {
    const [counts, decided] = await Promise.all([
      this.#finds.counts(customerId),
      this.#finds.listFor(customerId, ["kept", "skipped", "replied"], 20),
    ]);
    const total = counts.new + counts.shown + counts.kept + counts.skipped + counts.replied;
    if (!total) return "No finds yet: this is the first search for this customer.";
    return [
      `Finds so far: ${total} (${counts.kept} kept, ${counts.replied} replied to, ${counts.skipped} skipped, ${counts.shown} on cards now, ${counts.new} not shown yet).`,
      decided.length ? `What the customer decided, most recent first:\n${decided.map(decisionLine).join("\n")}` : "The customer has not decided on any yet.",
    ].join("\n");
  }

  /**
   * What they ruled out (a product they dropped, a kind of person): the waiting finds whose words name it go,
   * and its open cards close as skipped (live, 2026-10-04: "Drop the old Tally cards completely" was kept as
   * a memory while 83 Tally finds waited, and one came up on a card the same evening).
   */
  async dropAbout(customerId: CustomerId, about: string): Promise<{ dropped: number; closed: number }> {
    const word = about.trim().toLowerCase();
    const names = (f: Find): boolean => [f.quote, f.reply, f.url, f.title ?? "", f.why].some((s) => s.toLowerCase().includes(word));
    const waiting = (await this.#finds.listFor(customerId, ["new"], 1000)).filter(names);
    const dropped = await this.#finds.dropWaiting(customerId, waiting.map((f) => f.id));
    let closed = 0;
    for (const f of (await this.#finds.listFor(customerId, ["shown"], 200)).filter(names)) {
      const skipped = await this.#finds.decide(f.id, "skipped");
      if (!skipped) continue;
      closed++;
      await this.#redraw(skipped);
    }
    this.#autopilot?.note(customerId, "Quest", `dropped ${dropped} waiting finds about "${about}" and closed ${closed} cards`);
    return { dropped, closed };
  }

  /**
   * A place ruled out: its waiting finds go, and its cards still open close as skipped (live, 2026-11-05: Reddit ruled
   * out, a Reddit reply kept from the takes still waited on them in People, and its Skip said "Already decided").
   */
  async dropWaitingFrom(customerId: CustomerId, key: string): Promise<number> {
    const there = (f: Find): boolean => placeKeys(f.url).includes(key);
    const waiting = await this.#finds.listFor(customerId, ["new"], 500);
    const dropped = await this.#finds.dropWaiting(customerId, waiting.filter(there).map((f) => f.id));
    let closed = 0;
    for (const f of (await this.#finds.listFor(customerId, ["shown", "kept"], 200)).filter(there)) {
      if (f.sentAt || f.postState !== "open" || this.#errands.running(`post:${f.id}`)) continue;
      await this.#outbox.drop({ findId: f.id }, "its place was ruled out");
      const skipped = await this.#finds.decide(f.id, "skipped");
      if (!skipped) continue;
      closed++;
      await this.#redraw(skipped);
    }
    return dropped + closed;
  }

  async taskFacts(customerId: CustomerId, taskId: TaskId): Promise<string> {
    const all = await this.#finds.listFor(customerId, ["new", "shown", "kept", "skipped", "replied"], 500);
    const mine = all.filter((f) => f.taskId === taskId);
    if (!mine.length) return "this task saved no finds.";
    const strong = mine.filter((f) => f.strength === "strong").length;
    const n = mine.length;
    return `this task saved ${n} ${n === 1 ? "find" : "finds"} (${strong} strong, ${n - strong} maybe): ${bySource(mine)}.`;
  }

  /**
   * "Post it": the tap is acknowledged at once, and the reply goes up from the
   * customer's own account in their Chrome. The card then shows where it went;
   * whatever stops it is said in the chat, in words they can act on.
   */
  async #post(find: Find): Promise<string> {
    if (find.sentAt) return "Already posted";
    if (find.postState === "posting") return "Already posting it";
    if (find.postState === "uncertain") return "It may have gone up: look first";
    if (find.status !== "shown" && find.status !== "kept") return "That one is closed";
    const parent = find.replyTo;
    if (!parent && platformFor(find.url) === "reddit") return "Give the exact Reddit thread or comment before posting";
    return (await this.#start(find, parent ?? find.url, false)) ?? "Posting it from your Chrome…";
  }

  /**
   * Puts its reply in line to go up (drafts/outbox.ts): null when it is on its way, or waits there on trust; `QUEUED`
   * when their Chrome is not there and it waits for it; otherwise why not, in the words a tap is answered with.
   */
  async #start(find: Find, parent: string, alone: boolean): Promise<string | null> {
    const avoided = (await this.#places.listFor(find.customerId)).find((p) => placeKeys(find.url).includes(p.key) && p.verdict === "avoid");
    if (avoided) return `${avoided.name} is on your avoid list`;
    // A find's card is a reply, and replies have no day limit (the founder, 2026-10-16); they still go up a person's pace apart.
    const queued = await this.#outbox.enqueue({ customerId: find.customerId, ref: { findId: find.id }, target: parent, site: platformFor(find.url), approved: alone ? "trust" : "tap" });
    if (typeof queued === "string") return queued;
    if (!queued.waits || alone) {
      // On its way: the deck turns past it now, not once it is up (a post can take half a minute).
      if (!alone && this.#deck) {
        const now = (await this.#finds.get(find.id)) ?? find;
        await this.#deck.changed(find.customerId, { last: findLine(now.sentAt ? now : { ...now, postState: "posting" }) });
      }
      return null;
    }
    await this.#redraw({ ...find, waiting: true });
    return QUEUED;
  }

  errand(item: OutboxItem): string {
    return `post:${item.findId}`;
  }

  /** Its turn in the line: still on its card, unsent, Quest still trusted there when it goes by itself; then it goes up. */
  async send(item: OutboxItem, stopping: AbortSignal): Promise<SendOutcome> {
    const find = item.findId ? await this.#finds.get(item.findId) : null;
    if (!find || find.sentAt || (find.postState && find.postState !== "open") || (find.status !== "shown" && find.status !== "kept")) return "dropped";
    const alone = item.approved === "trust";
    if (alone && !(await this.#autopilot?.alone(find.customerId, platformFor(find.url)))) return "dropped";
    return this.#postNow(find, item.target ?? find.replyTo ?? find.url, alone, stopping);
  }

  async back(item: OutboxItem): Promise<void> {
    await this.#deck?.changed(item.customerId);
  }

  /** Out of line after waiting days for their Chrome: its card is as it was, buttons and all. */
  async expired(item: OutboxItem): Promise<void> {
    const find = item.findId ? await this.#finds.get(item.findId) : null;
    if (!find || find.sentAt) return;
    this.#autopilot?.note(find.customerId, "Quest", `took ${replyLabel(find)} out of the outbox: their Chrome was away for days`);
    await this.#redraw(find);
  }

  /**
   * At start: a reply still claimed as posting was being posted by a machine that stopped before it knew how it went,
   * so it turns uncertain, its card offers "Not there, post again", and they hear it once. Never posted again by itself.
   */
  async recoverPosts(): Promise<number> {
    const left = await this.#finds.leftPosting();
    for (const find of left) {
      try {
        await this.#finds.endPost(find.id, true);
        this.#log.warn("finds.post_lost", { findId: find.id, customerId: find.customerId });
        const held = await this.#finds.get(find.id);
        if (held) await this.#redraw(held);
      } catch (e) {
        this.#log.error("finds.recover_failed", { findId: find.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return left.length;
  }

  async #postNow(find: Find, parent: string, alone: boolean, stopping?: AbortSignal): Promise<SendOutcome> {
    if (!(await this.#finds.beginPost(find.id, alone))) return "dropped";
    const platform = platformFor(find.url);
    const which = replyLabel(find);
    let posted: ChromePosted;
    try {
      posted = await this.#poster.post(find.customerId, platform === "reddit" ? { platform: "reddit", url: find.url, parent, text: find.reply } : { platform: "browser", kind: "reply", url: find.url, target: parent, text: find.reply, title: null, quote: find.quote, author: find.author }, stopping);
    } catch (e) {
      const reason = e instanceof ChromeError ? e.reason : "error";
      const uncertain = reason === "uncertain" || reason === "timeout" || reason === "error";
      await this.#finds.endPost(find.id, uncertain);
      this.#log.warn("finds.post_failed", { findId: find.id, reason, error: String(e) });
      // Their Chrome is not there: nothing went out, and it waits in line for the Chrome to come back, no word said.
      if (reason === "offline") {
        if (!alone) await this.#redraw({ ...find, postState: "open", waiting: true });
        return "waits";
      }
      // They answered there themselves: what the card asked is done, by them, and nothing went up.
      if (e instanceof AlreadyAnswered) {
        this.#autopilot?.note(find.customerId, "Quest", `left ${which}: they already answered there`);
        const done = await this.#finds.decide(find.id, "replied");
        if (!alone) await this.#messenger.say(find.customerId, `You already answered there yourself, so ${which} didn't go up.`);
        if (done) await this.#redraw(done);
        return "dropped";
      }
      // It can never go up (comments off, the post deleted): the card goes.
      if (reason === "gone") {
        const why = e instanceof Error ? e.message : "";
        this.#autopilot?.note(find.customerId, "Quest", `dropped ${which}: ${why}`);
        const done = await this.#finds.decide(find.id, "skipped");
        if (!alone) await this.#messenger.say(find.customerId, `I dropped ${which}, it can't go up: ${why}`);
        if (done) await this.#redraw(done);
        return "dropped";
      }
      this.#autopilot?.note(find.customerId, "Chrome", `could not post ${which}: ${reason}`);
      // Going up by itself, a failure says nothing: the card keeps Post it, and a tap asks again.
      // One it could not see land says nothing and waits on nobody: Quest looks at its page later itself (HeldCheck).
      if (!uncertain && !alone) await this.#messenger.say(find.customerId, notPosted(e, which, platform === "reddit" ? "Reddit" : sourceLabel(find.source, find.url)));
      const held = await this.#finds.get(find.id);
      if (held) await this.#redraw(held);
      return uncertain ? "held" : "failed";
    }
    this.#log.info("finds.posted", { findId: find.id, customerId: find.customerId, alone });
    const sent = await this.#finds.markSent(find.id, posted.url, posted.account, alone);
    if (!sent) return "sent";
    this.#autopilot?.note(find.customerId, "Chrome", `posted ${which}${alone ? " by itself" : " on your tap"}: ${posted.url}`);
    // Quest looks again for answers (ReplyWatch), on Reddit in the thread, elsewhere on their notifications or the post.
    await this.#finds.watch(sent.id, nextLook(sent.sentAt ?? this.#clock.now(), 0), 0, []);
    await this.#redraw(sent);
    if (alone) return "sent"; // one show_finds, a few posts: a reply that went up by itself does not pull the next card up
    await this.#autopilot?.approved(find.customerId, platform);
    if (find.status === "shown") await this.#next(find.customerId);
    return "sent";
  }

  /** Confirm a held find-card reply from its real destination without resending it. */
  async verifySent(customerId: CustomerId, id: FindId, view: BrowserView): Promise<Find | string> {
    const f = await this.#finds.get(id);
    if (!f || f.customerId !== customerId) return "No such find.";
    if (f.sentAt) return f;
    if (!f.postState || !["posting", "uncertain"].includes(f.postState)) return "That find is not a held send.";
    if (this.#errands.running(`post:${id}`)) return "Its posting executor is still running; do not interfere.";
    if (view.visualText) return "Visual text can include an unsent draft. Keep this send held; a transcript alone is not a receipt.";
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
    if (platformFor(view.url) !== platformFor(f.url) || !bodyShown(view.text, f.reply) || view.controls.some((c) => c.value !== null && normalize(c.value) === normalize(f.reply))) return "The posted reply is not verified outside an empty composer. Keep it held.";
    const sent = await this.#finds.markSent(id, view.url, "connected account", f.sentAlone);
    if (!sent) return "Its state changed; inspect it again.";
    await this.#finds.watch(id, nextLook(sent.sentAt ?? this.#clock.now(), 0), 0, []);
    await this.#redraw(sent);
    return sent;
  }

  /** After a decision: the next waiting card, or word to the manager that they have seen everything. */
  async #next(customerId: CustomerId): Promise<void> {
    const out = await this.show(customerId, 1);
    if (out.shown || out.open || out.waiting) return;
    await this.#events.push(customerId, {
      kind: "system",
      topic: "finds",
      text: "The customer has decided on every find you showed, and none are waiting. Their decisions are on your board.",
    });
  }

  /**
   * Waiting finds from a place now filed as avoid (by the explorer, or because the customer said so)
   * are dropped before anything is shown: whenever the place was filed, a card from a community they
   * ruled out never reaches them (live, 2026-09-29: one saved before its community was filed).
   */
  async #dropAvoided(customerId: CustomerId): Promise<void> {
    const avoid = new Set((await this.#places.listFor(customerId)).filter((p) => p.verdict === "avoid").map((p) => p.key));
    if (!avoid.size) return;
    const waiting = await this.#finds.listFor(customerId, ["new"], 500);
    const out = waiting.filter((f) => placeKeys(f.url).some((k) => avoid.has(k))).map((f) => f.id);
    if (out.length) await this.#finds.dropWaiting(customerId, out);
  }

  /** Its card shows what became of it, and the deck turns past it (or shows what it came to). */
  async #redraw(find: Find): Promise<void> {
    try {
      if (find.cardRef) await this.#messenger.updateFind(find.customerId, find.cardRef, find);
      await this.#deck?.changed(find.customerId, { last: findLine(find) });
    } catch (e) {
      this.#log.warn("finds.redraw_failed", { findId: find.id, error: String(e) });
    }
  }
}
