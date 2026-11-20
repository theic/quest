import {
  askKeys,
  draftId,
  draftLabel,
  findId,
  questionId,
  NO_DECK,
  sourceLabel,
  type Ask,
  type Clock,
  type CustomerId,
  type CustomerRepository,
  type DeckState,
  type DeckStore,
  type DeckView,
  type Draft,
  type DraftAction,
  type DraftRepository,
  type Find,
  type FindAction,
  type FindRepository,
  type IdeaRepository,
  type Logger,
  type OutboxItem,
  type QuestionRepository,
  type ResultEntry,
  type Transcript,
  type TrustRepository,
} from "@mq/core";
import { platformName } from "../drafts/autopilot.ts";
import type { ChannelRegistry } from "../conversation/channel-registry.ts";
import { CARD_MARK, QUESTION_MARK } from "../conversation/messenger.ts";
import { talksWith } from "../drafts/warm-up.ts";
import { STALE_CARD_MS } from "../finds/find-service.ts";
import { groupOf, rankAsks, tierOf, TIERS } from "./rank.ts";

/** New decks a day that notify; past them a new deck comes silently. Someone waiting on them always notifies. */
export const DECK_NOTICES_A_DAY = 3;
/** Older decks a reply still counts for. */
const OLD_DECKS = 3;

/** What a tap on the deck's own buttons does to the ask's record: the services' own `act`. */
export interface AskActs {
  find(customerId: CustomerId, id: string, action: FindAction): Promise<string>;
  draft(customerId: CustomerId, id: string, action: DraftAction): Promise<string>;
  question(customerId: CustomerId, id: string, option: number): Promise<string>;
  idea(customerId: CustomerId, id: string, action: "yes" | "no"): Promise<string>;
  /** Their answer to Quest's offer to go alone on a platform (drafts/autopilot.ts). */
  trust?(customerId: CustomerId, platform: string, yes: boolean): Promise<string>;
}

/** The services behind the asks, read when a tap comes (they are made after the deck, which they tell). */
export interface AskServices {
  readonly finds: { act(customerId: CustomerId, id: ReturnType<typeof findId>, action: FindAction): Promise<string> };
  readonly drafts: { act(customerId: CustomerId, id: ReturnType<typeof draftId>, action: DraftAction): Promise<string> };
  readonly questions: { choose(customerId: CustomerId, id: ReturnType<typeof questionId>, option: number): Promise<unknown> };
  readonly ideas: { act(customerId: CustomerId, id: string, action: "yes" | "no"): Promise<string> };
  readonly autopilot?: { answer(customerId: CustomerId, platform: string, yes: boolean): Promise<string> };
}

/** What a tap does to each kind of ask: what its card's button did. */
export function askActs(services: () => AskServices): AskActs {
  return {
    find: (c, id, action) => services().finds.act(c, findId(id), action),
    draft: (c, id, action) => services().drafts.act(c, draftId(id), action),
    question: async (c, id, option) => ((await services().questions.choose(c, questionId(id), option)) ? "Got it" : "That one is already settled"),
    idea: (c, id, action) => services().ideas.act(c, id, action),
    trust: (c, platform, yes) => services().autopilot?.answer(c, platform, yes) ?? Promise.resolve("That one is settled already"),
  };
}

/** For a reply to the deck that no service took as a note: which ask it showed, for the manager. */
export function aboutDeck(a: Ask): string {
  switch (a.kind) {
    case "find":
      return `(Their reply to Your move, which showed the find of ${a.find.author ?? "a person"} on ${sourceLabel(a.find.source, a.find.url)}: find ${a.find.id}. The reply on it: "${a.find.reply}")`;
    case "draft":
      return `(Their reply to Your move, which showed ${draftLabel(a.draft)}: draft ${a.draft.id}, ${a.draft.status}. Its words: "${a.draft.text}")`;
    case "question":
      return `(Their reply to Your move, which showed the ${a.question.agent}'s question ${a.question.id}: "${a.question.text}")`;
    case "idea":
      return `(Their reply to Your move, which showed your idea for a post, idea ${a.idea.id}: "${a.idea.text}")`;
    case "trust":
      return `(Their reply to Your move, which showed your offer to do ${a.platform} by itself from now on. Their words say yes or no to it: a yes is "go ahead" there (the posting tool), a no "ask me first".)`;
    case "group":
      return a.what === "profile"
        ? `(Their reply to Your move, which showed the profile check on ${a.platform}: ${a.drafts.map((d) => `${d.target} "${d.text}" (draft ${d.id})`).join("; ")}. A note on it: edit_card each draft it is about.)`
        : `(Their reply to Your move, which showed ${a.drafts.length} ${a.what === "like" ? "likes" : "follows"} on ${a.platform}: drafts ${a.drafts.map((d) => d.id).join(", ")})`;
  }
}

/** What the services tell the deck. */
export interface AskDeck {
  /**
   * Something in the line changed: an ask joined, was answered, or its words changed. `last`: what became of the one
   * that changed, a line above the ask. `down`: sent anew at the bottom, silently, showing that ask (after their note under it).
   */
  changed(customerId: CustomerId, opts?: DeckChange): Promise<void>;
  /** The deck's message, to ask under it what should change. */
  ref(customerId: CustomerId): Promise<string | null>;
}

export interface DeckChange {
  readonly last?: string | null;
  readonly down?: string;
}

export interface DeckDeps {
  readonly customers: Pick<CustomerRepository, "primaryChannel">;
  readonly channels: ChannelRegistry;
  readonly store: DeckStore;
  readonly finds: Pick<FindRepository, "listFor">;
  readonly drafts: Pick<DraftRepository, "recent">;
  readonly questions: Pick<QuestionRepository, "listFor">;
  readonly ideas: Pick<IdeaRepository, "list">;
  /** Quest's offers to go alone on a platform, earned and waiting on their yes. */
  readonly trust?: Pick<TrustRepository, "offered">;
  /** What waits in the outbox is approved already: theirs to do no more. */
  readonly outbox: { waiting(customerId: CustomerId): Promise<readonly OutboxItem[]> };
  /** Who talks with them (mq.results): a reply to one of them waits on a person. */
  readonly results?: { list(customerId: CustomerId, limit: number): Promise<ResultEntry[]> };
  /** Where the deck's place in the chat is told from: their messages and Quest's. */
  readonly transcript: Transcript;
  /** Told once the deck is drawn after a change. */
  readonly drawn?: (customerId: CustomerId) => Promise<void>;
  readonly acts: AskActs;
  readonly clock: Clock;
  readonly log: Logger;
}

const who = (name: string | null | undefined, fallback: string): string => name?.trim() || fallback;

/** When an ask came into the line. */
const joinedAt = (a: Ask): number => {
  switch (a.kind) {
    case "find":
      return (a.find.shownAt ?? a.find.createdAt).getTime();
    case "draft":
      return a.draft.createdAt.getTime();
    case "question":
      return (a.question.askedAt ?? a.question.createdAt).getTime();
    case "idea":
      return a.idea.createdAt.getTime();
    case "trust":
      return 0;
    case "group":
      return Math.max(...a.drafts.map((d) => d.createdAt.getTime()));
  }
};

/** Asks that came within this long of each other came together: the first of them by rank is shown. */
const TOGETHER_MS = 60_000;

/**
 * What a new deck opens on: the ask that came last, which is what Quest just said is there (live, 2026-10-23: the X
 * post they dictated was 14th in their line). Those that came together, the first of them by rank.
 */
function newest(joined: readonly Ask[]): Ask | null {
  if (!joined.length) return null;
  const last = Math.max(...joined.map(joinedAt));
  return joined.find((a) => joinedAt(a) >= last - TOGETHER_MS) ?? null;
}

/** What became of a find, a line on the deck; null while it still waits on them. */
export function findLine(f: Find): string | null {
  const whom = f.source.startsWith("reddit") && f.author && !/^u\//i.test(f.author) ? `u/${f.author}` : who(f.author, sourceLabel(f.source, f.url));
  if (f.sentUrl) return f.sentAlone ? `Quest did it: your reply to ${whom}` : `Posted: your reply to ${whom}`;
  if (f.postState === "uncertain") return null;
  if (f.waiting) return `Waits for your Chrome: your reply to ${whom}`;
  if (f.postState === "posting") return `Going up: your reply to ${whom}`;
  if (f.status === "skipped") return `Skipped: ${whom}`;
  if (f.status === "kept") return `Kept: ${whom}`;
  if (f.status === "replied") return `You replied to ${whom}`;
  return null;
}

/** What became of a draft, a line on the deck; null while it still waits on them. */
export function draftLine(d: Draft): string | null {
  const what = draftLabel(d);
  if (d.status === "posted") return d.alone ? `Quest did it: ${what}` : d.kind === "message" ? `Sent: ${what}` : d.kind === "reply" || d.kind === "post" ? `Posted: ${what}` : `Done: ${what}`;
  if (d.status === "skipped") return `Skipped: ${what}`;
  if (d.status === "open" && d.waiting) return `Waits for your Chrome: ${what}`;
  if (d.status === "posting") return `Going up: ${what}`;
  return null;
}

/**
 * How an ask that joined is noted in the transcript, as its card was: the manager and the follow-ups read these. One
 * that had a card of its own was noted when that card went out (live, 2026-10-24: the first deck, 25 old cards, noted
 * again, filled the 16 lines of the chat the manager reads).
 */
function noted(a: Ask): string[] {
  switch (a.kind) {
    case "find":
      return a.find.cardRef ? [] : [`${CARD_MARK}${sourceLabel(a.find.source, a.find.url)}: ${a.find.url}`];
    case "draft":
      return a.draft.cardRef ? [] : [`${CARD_MARK}Draft, ${draftLabel(a.draft)}: ${a.draft.url}\n${a.draft.text}`];
    case "group":
      return a.drafts.filter((d) => !d.cardRef).map((d) => `${CARD_MARK}Draft, ${draftLabel(d)}: ${d.url}`);
    case "question":
      return a.question.askedRef ? [] : [`${QUESTION_MARK}${a.question.text}`];
    case "idea":
      return a.idea.cardRef ? [] : [`${CARD_MARK}Idea for a post: ${a.idea.text}`];
    case "trust": {
      const offer = trustOffer(a.platform);
      return [`${QUESTION_MARK}${offer.text.replace("{platform}", offer.platform)}`];
    }
  }
}

/** Quest's offer to go alone on a platform, as Your move says it: a template for each kind, and where. */
const OFFERS = {
  reply: "You've okayed a few replies on {platform}. Want me to post replies there myself from now on? Say \"ask me first\" anytime and I'll ask again.",
  post: "You've okayed a few posts on {platform}. Want me to put up posts there myself from now on? Say \"ask me first\" anytime and I'll ask again.",
  like: "You've okayed a few likes on {platform}. Want me to like posts there myself from now on? Say \"ask me first\" anytime and I'll ask again.",
  follow: "You've okayed a few follows on {platform}. Want me to follow people there myself from now on? Say \"ask me first\" anytime and I'll ask again.",
} as const;

export const trustOffer = (key: string): { readonly text: string; readonly platform: string } => {
  const kind = / likes$/.test(key) ? "like" : / follows$/.test(key) ? "follow" : / posts$/.test(key) ? "post" : "reply";
  return { text: OFFERS[kind], platform: platformName(key.replace(/ (posts|likes|follows)$/, "")) };
};

/**
 * "Your move" (the founder, 2026-10-23: "one deck message in the chat"): everything that waits on them in one ranked
 * line (rank.ts), shown one at a time in one message of their chat. The ask in front has its own buttons, the same as
 * its card had, so the services do the work; a tap answers it and the deck turns to the ask that took its place, in
 * the same message. A new deck goes at the bottom when there was none, when it had said nothing waits, when asks came
 * while it was no longer the last message, or when a person waits on them; otherwise it is redrawn in place, which
 * notifies nobody. Kept in mq.customers.deck, so a restart finds it.
 */
export class Deck implements AskDeck {
  readonly #d: DeckDeps;
  /** One draw at a time for each customer; calls that come while one waits to start join it. */
  readonly #running = new Map<CustomerId, Promise<void>>();
  readonly #pending = new Map<CustomerId, { opts: DeckChange; done: Promise<void> }>();

  constructor(deps: DeckDeps) {
    this.#d = deps;
  }

  /** Every ask waiting on them, first to last; `oneByOne`: the group they go through one at a time. */
  async asks(customerId: CustomerId, oneByOne: string | null = null): Promise<Ask[]> {
    return (await this.#line(customerId, oneByOne)).asks;
  }

  /** The line, and who talks with them already. */
  async #line(customerId: CustomerId, oneByOne: string | null): Promise<{ readonly asks: Ask[]; readonly talking: (person: string | null) => boolean }> {
    const d = this.#d;
    const [shown, drafts, questions, outbox, results] = await Promise.all([
      d.finds.listFor(customerId, ["shown"], 200),
      d.drafts.recent(customerId, 200),
      d.questions.listFor(customerId, ["asked"]),
      d.outbox.waiting(customerId),
      d.results ? d.results.list(customerId, 300).catch(() => []) : Promise.resolve([]),
    ]);
    const queued = new Set(outbox.flatMap((o) => [o.findId, o.draftId]).filter(Boolean) as string[]);
    // A card left for days no longer holds its place (finds/find-service.ts): its moment passed. A send that may have gone
    // up is not theirs to look at: Quest looks itself (drafts/held-check.ts).
    const fresh = d.clock.now().getTime() - STALE_CARD_MS;
    const asks: Ask[] = [
      ...shown
        .filter((f) => !f.sentAt && !queued.has(f.id) && f.postState !== "posting" && f.postState !== "uncertain" && (f.shownAt?.getTime() ?? 0) > fresh)
        .map((find): Ask => ({ kind: "find", key: askKeys.find(find.id), find })),
      // A reply goes stale with its post, the same as a find; a post, a message, a like or a profile change waits on.
      ...drafts
        .filter((x) => x.status === "open" && !queued.has(x.id) && (x.kind !== "reply" || x.createdAt.getTime() > fresh))
        .map((draft): Ask => ({ kind: "draft", key: askKeys.draft(draft.id), draft })),
      ...questions.map((question): Ask => ({ kind: "question", key: askKeys.question(question.id), question })),
    ];
    const talking = (person: string | null): boolean => talksWith(person, results);
    return { asks: rankAsks(asks, talking, oneByOne), talking };
  }

  /**
   * The deck as it stands, for a surface that draws it itself (the extension's popup): the ask it shows now, or the one
   * that took its place, and the line either side. Nothing is drawn or kept.
   */
  async view(customerId: CustomerId): Promise<DeckView> {
    const state = (await this.#d.store.get(customerId)) ?? NO_DECK;
    const { asks } = await this.#line(customerId, state.oneByOne);
    if (!asks.length) return { ask: null, position: 0, total: 0, prev: null, next: null, last: state.last };
    const keys = asks.map((a) => a.key);
    let at = state.showing ? keys.indexOf(state.showing) : -1;
    if (at < 0) at = Math.min(state.at, asks.length - 1);
    return { ask: asks[at]!, position: at + 1, total: asks.length, prev: keys[at - 1] ?? null, next: keys[at + 1] ?? null, last: state.last };
  }

  /** Every ask waiting on them, in rank: the panel shows them as a plain list. */
  async list(customerId: CustomerId): Promise<readonly Ask[]> {
    const state = (await this.#d.store.get(customerId)) ?? NO_DECK;
    return (await this.#line(customerId, state.oneByOne)).asks;
  }

  async ref(customerId: CustomerId): Promise<string | null> {
    return (await this.#d.store.get(customerId))?.ref ?? null;
  }

  /** The ask the deck message `ref` shows, now or before it was sent again further down; null when `ref` is no deck. */
  async shows(customerId: CustomerId, ref: string): Promise<Ask | null> {
    const state = await this.#d.store.get(customerId);
    if (!state?.showing || (state.ref !== ref && !state.old.includes(ref))) return null;
    return (await this.asks(customerId, state.oneByOne)).find((a) => a.key === state.showing) ?? null;
  }

  changed(customerId: CustomerId, opts: DeckChange = {}): Promise<void> {
    const waiting = this.#pending.get(customerId);
    if (waiting) {
      // Not started yet: it draws what is true when it starts, with what both asked for.
      waiting.opts = { down: opts.down ?? waiting.opts.down, last: opts.last !== undefined ? opts.last : waiting.opts.last };
      return waiting.done;
    }
    const before = this.#running.get(customerId) ?? Promise.resolve();
    const entry = { opts, done: Promise.resolve() };
    entry.done = before
      .catch(() => undefined)
      .then(() => {
        this.#pending.delete(customerId);
        return this.#draw(customerId, entry.opts);
      })
      .then(() => this.#d.drawn?.(customerId))
      .catch((e: unknown) => this.#d.log.warn("deck.draw_failed", { customerId, error: e instanceof Error ? e.message : String(e) }));
    this.#pending.set(customerId, entry);
    this.#running.set(customerId, entry.done);
    return entry.done;
  }

  /**
   * A tap that could not go (a rule held it): the deck turns to the next ask with why, and this one waits further on.
   * The founder, 2026-11-15: "Your move must never block any records, it has to move forward".
   */
  async past(customerId: CustomerId, key: string, why: string): Promise<void> {
    const state = (await this.#d.store.get(customerId)) ?? NO_DECK;
    const asks = await this.asks(customerId, state.oneByOne);
    const at = asks.findIndex((a) => a.key === key);
    if (at < 0 || asks.length < 2) return;
    const next = asks[(at + 1) % asks.length]!;
    await this.#d.store.save(customerId, { ...state, showing: next.key, at: (at + 1) % asks.length });
    await this.changed(customerId, { last: why });
  }

  /** ‹ and ›: another ask in front, nothing decided. */
  async move(customerId: CustomerId, key: string): Promise<string> {
    const state = (await this.#d.store.get(customerId)) ?? NO_DECK;
    const asks = await this.asks(customerId, state.oneByOne);
    const at = asks.findIndex((a) => a.key === key);
    if (at < 0) return "That one is done already";
    await this.#d.store.save(customerId, { ...state, showing: key, at });
    await this.changed(customerId);
    return "";
  }

  /** "Do all": every like, follow or profile change of the group, each as its own tap would (their day limits and the outbox hold). */
  async all(customerId: CustomerId, key: string): Promise<string> {
    const group = (await this.asks(customerId)).find((a) => a.key === key);
    if (!group || group.kind !== "group") return "Those are done already";
    let going = 0;
    const refused = new Set<string>();
    for (const d of group.drafts) {
      const ack = await this.#d.acts.draft(customerId, d.id, "post");
      if (/^(Posting|Queued|Sending|Scheduled)/.test(ack)) going++;
      else if (ack) refused.add(ack);
    }
    await this.changed(customerId);
    const done = group.what === "like" ? "{count} likes going" : group.what === "follow" ? "{count} follows going" : "{count} profile changes going";
    return [going ? done.replace("{count}", String(going)) : null, ...refused].filter(Boolean).join(". ") || "Nothing to do";
  }

  /** "One by one": the group's likes, follows or profile changes come one at a time. */
  async one(customerId: CustomerId, key: string): Promise<string> {
    const state = (await this.#d.store.get(customerId)) ?? NO_DECK;
    const asks = await this.asks(customerId, key);
    const first = asks.find((a) => a.kind === "draft" && groupOf(a.draft) === key);
    if (!first) return "Those are done already";
    await this.#d.store.save(customerId, { ...state, oneByOne: key, showing: first.key, at: asks.indexOf(first) });
    await this.changed(customerId);
    return "";
  }

  /** Yes to Quest's offer to go alone on a platform. */
  yes(customerId: CustomerId, key: string): Promise<string> {
    return this.#trust(customerId, key, true);
  }

  /** Not yet: it keeps asking there, and offers again after a few more. */
  no(customerId: CustomerId, key: string): Promise<string> {
    return this.#trust(customerId, key, false);
  }

  async #trust(customerId: CustomerId, key: string, yes: boolean): Promise<string> {
    const offer = (await this.asks(customerId)).find((a) => a.key === key);
    if (!offer || offer.kind !== "trust" || !this.#d.acts.trust) return "That one is settled already";
    const ack = await this.#d.acts.trust(customerId, offer.platform, yes);
    await this.changed(customerId, { last: ack });
    return ack;
  }

  /** "Skip all": none of the group. */
  async none(customerId: CustomerId, key: string): Promise<string> {
    const group = (await this.asks(customerId)).find((a) => a.key === key);
    if (!group || group.kind !== "group") return "Those are done already";
    for (const d of group.drafts) await this.#d.acts.draft(customerId, d.id, "skip");
    await this.changed(customerId, { last: group.what === "profile" ? "Skipped the profile check" : `Skipped all ${group.drafts.length} ${group.what === "like" ? "likes" : "follows"}` });
    return "Skipped";
  }

  /** Whether the deck is still the last message in their chat (by the chat's own numbering, which only goes up). */
  async #atBottom(customerId: CustomerId, ref: string): Promise<boolean> {
    const refs = (await this.#d.transcript.recent(customerId, 6)).map((e) => Number(e.ref)).filter((n) => Number.isFinite(n) && n > 0);
    return !refs.length || Math.max(...refs) <= Number(ref);
  }

  async #draw(customerId: CustomerId, opts: DeckChange): Promise<void> {
    const d = this.#d;
    const to = await d.customers.primaryChannel(customerId);
    if (!to) return;
    const channel = d.channels.get(to.kind);
    const state = (await d.store.get(customerId)) ?? NO_DECK;
    let { asks, talking } = await this.#line(customerId, state.oneByOne);
    // Their group, gone through to the end: back to the line as it is.
    const oneByOne = state.oneByOne && asks.some((a) => a.kind === "draft" && groupOf(a.draft) === state.oneByOne) ? state.oneByOne : null;
    if (oneByOne !== state.oneByOne) ({ asks, talking } = await this.#line(customerId, oneByOne));
    const keys = asks.map((a) => a.key);
    const joined = asks.filter((a) => !state.keys.includes(a.key));
    const last = opts.last !== undefined ? opts.last : state.last;
    const today = d.clock.now().toISOString().slice(0, 10);
    const notices = state.day === today ? state.notices : 0;

    if (!asks.length) {
      // Nothing waits: the deck says so, in place, and is sent anew when the next ask comes.
      if (state.ref && (!state.empty || last !== state.last)) await channel.showDeck(to, state.ref, { ask: null, position: 0, total: 0, prev: null, next: null, last });
      await d.store.save(customerId, { ...state, showing: null, at: 0, keys: [], oneByOne: null, last, empty: true, day: today, notices });
      return;
    }

    const person = joined.some((a) => tierOf(a, talking) === TIERS.person);
    // Never held for the first-day cards: what waits on them for those is the sweep's finds, which wait to be shown
    // (FindService.show). Live, 2026-10-23: held as well, the X post they dictated during a take never showed, after
    // Quest said "Your X post is on a card".
    let anew = !state.ref || Boolean(opts.down) || (joined.length > 0 && (state.empty || person || !(await this.#atBottom(customerId, state.ref))));
    // In front: the one asked for; on a new deck, what just came (else the top); the one it showed, while it waits
    // still; else the one that took its place.
    let at = opts.down ? keys.indexOf(opts.down) : anew ? Math.max(0, keys.indexOf(newest(joined)?.key ?? "")) : state.showing ? keys.indexOf(state.showing) : -1;
    if (at < 0) at = anew ? 0 : Math.min(state.at, asks.length - 1);
    const view: DeckView = { ask: asks[at]!, position: at + 1, total: asks.length, prev: keys[at - 1] ?? null, next: keys[at + 1] ?? null, last: anew && opts.last === undefined ? null : last };

    let ref = state.ref;
    let old = state.old;
    let sentNotice = false;
    if (!anew && ref) {
      const drawn = await channel.showDeck(to, ref, view);
      // They deleted it: a new one, quietly.
      if (drawn === null) anew = true;
    }
    if (anew) {
      const silent = Boolean(opts.down) || (!person && notices >= DECK_NOTICES_A_DAY);
      const sent = await channel.showDeck(to, null, view, { silent });
      if (!sent) return;
      if (ref) {
        await channel.removeMessage(to, ref).catch((e: unknown) => d.log.warn("deck.remove_failed", { customerId, error: e instanceof Error ? e.message : String(e) }));
        old = [ref, ...old.filter((r) => r !== ref)].slice(0, OLD_DECKS);
      }
      ref = sent;
      sentNotice = !silent;
    }
    for (const a of joined) for (const line of noted(a)) await d.transcript.recordOutgoing(customerId, to.kind, ref, line);
    await d.store.save(customerId, { ref, showing: view.ask!.key, at, keys, oneByOne, last: view.last, empty: false, day: today, notices: notices + (sentNotice ? 1 : 0), old });
    d.log.info("deck.drawn", { customerId, anew, total: asks.length, joined: joined.length, showing: view.ask!.key, ...(anew ? { silent: !sentNotice } : {}) });
  }
}
