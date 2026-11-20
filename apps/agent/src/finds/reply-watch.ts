import {
  postingRoute,
  ReadError,
  sourceLabel,
  type ResultRepository,
  type RouteRepository,
  type Clock,
  type CustomerId,
  type DraftRepository,
  type EventSink,
  type FindRepository,
  type Logger,
  type MemoryRepository,
  type PageComment,
  type PageText,
  type WatchedDraft,
  type WatchedFind,
  type WebReach,
} from "@mq/core";
import { commentPermalink, commentRef } from "../chrome/reddit.ts";
import type { Autopilot } from "../drafts/autopilot.ts";
import { offersIt, saysYes } from "../drafts/warm-up.ts";
import { saysNo } from "../contacts/said-no.ts";
import type { Loop } from "../lifecycle/idle-sleeper.ts";
import { clip } from "../lib/sleeper.ts";
import { drawnOn, platformOf } from "../platforms.ts";
import { quoteAppears } from "../tasks/seen-pages.ts";
import type { AnswerReader, Heard } from "./answer-reader.ts";
import { blueskyAnswers, blueskyPost } from "./bluesky-answers.ts";
import { modelRest } from "../lib/model-rest.ts";

/**
 * When Quest looks at a posted reply again, counted from when it went up: fifteen minutes (a
 * community's filter removes a new account's comment at once: live in r/test, 2026-09-28),
 * six hours, a day, three days, a week.
 */
export const WATCH_AFTER_HOURS = [0.25, 6, 24, 72, 168] as const;
const HOUR_MS = 3_600_000;

/** How soon a look their minimised or covered window could not draw is tried again. */
export const HIDDEN_RETRY_MS = 15 * 60_000;
/**
 * How often a page of their notifications is read, whatever is due there (the founder, 2026-11-18: "would it be more
 * efficient to behave like humans and only open the notification bar to see the replies?"). Each send has its own clock,
 * so on a busy site one was due every few minutes and the same list was read again for it.
 */
export const SITE_LOOK_MS = 30 * 60_000;
/** A page's lines with their numbers taken out ("2h", "3 likes"), so the same page an hour later reads the same. */
const linesOf = (text: string): string[] => text.split("\n").map((l) => l.replace(/\d+/g, "").replace(/\s+/g, " ").trim()).filter((l) => l.length >= 3);
/**
 * What a reading must show again for a look to be nothing new. A list cut into posts (X's mentions) is known by its
 * newest posts: a second reading draws more old rows and other trends beside them, and an answer is always on top.
 * Read twice ten minutes apart, 2026-11-18: X's page had 9 new lines and Threads' 21 with nobody new, LinkedIn's none.
 */
const NEWEST = 10;
const shownOn = (page: PageText): { all: string[]; top: string[] } => {
  const posts = (page.posts ?? []).map((post) => post.text.replace(/\s+/g, " ").trim().toLowerCase()).filter(Boolean);
  if (posts.length) return { all: posts, top: posts.slice(0, NEWEST) };
  const lines = linesOf(page.text);
  return { all: lines, top: lines };
};
/** Pages whose last reading is kept, to know a look that shows nothing new. */
const SHOWN_KEPT = 300;
/** Sends looked at in one look: those of a site share one page, so many cost one read. */
const DUE_A_LOOK = 60;

/** Accounts that answer every comment by themselves. */
const BOTS = /^(automoderator)$/i;

const same = (a: string | null | undefined, b: string | null | undefined): boolean => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/** When the look after `checks` looks falls due, or null when the watch is over. */
export function nextLook(sentAt: Date, checks: number): Date | null {
  const hours = WATCH_AFTER_HOURS[checks];
  return hours === undefined ? null : new Date(sentAt.getTime() + hours * HOUR_MS);
}

/**
 * The answers to what the customer posted, by anyone but them or a bot. To a reply: comments whose
 * parent is it (known by its address, or else by the account it went out as). To a post of theirs:
 * the comments on the post itself, and those under any comment of theirs in its thread.
 */
export function answersTo(page: PageText, account: string | null, url: string, kind: "reply" | "post" = "reply"): PageComment[] {
  const comments = page.comments ?? [];
  const ref = kind === "reply" ? commentRef(url) : null;
  const mine = new Set(comments.filter((c) => (ref ? c.ref === ref : same(c.author, account))).flatMap((c) => (c.ref ? [c.ref] : [])));
  if (ref) mine.add(ref);
  const answers = (c: PageComment): boolean => (c.parentRef ? mine.has(c.parentRef) : kind === "post");
  return comments.filter((c) => c.ref && answers(c) && !same(c.author, account) && !BOTS.test(c.author ?? ""));
}

/**
 * Where the answers to something that went up on a site other than Reddit show, read as their own account: the
 * notifications of a site that has a page for them (one read covers everything of theirs there), else the post
 * itself, with the replies under it. Read in their dev Chrome, 2026-11-18: Instagram's, Tumblr's and Substack's lists
 * show in a background tab; Facebook's says only that someone commented, Peerlist's draws nothing in the background, and
 * TikTok and YouTube have no such page, so those stay on the post.
 */
export function answersPage(url: string): string {
  switch (platformOf(url)?.key) {
    case "x":
      return "https://x.com/notifications/mentions";
    case "threads":
      return "https://www.threads.com/activity";
    case "linkedin":
      return "https://www.linkedin.com/notifications/";
    case "instagram":
      return "https://www.instagram.com/notifications/";
    case "tumblr":
      return "https://www.tumblr.com/activity";
    case "substack":
      return "https://substack.com/activity";
    default:
      return url;
  }
}

const words = (s: string): string => s.replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
/**
 * One answer, as the watch remembers it was told: its first words. Not by whom: the model names the same person by
 * their handle one look and by their display name the next (live, 2026-11-04: "@SamBuilds16", then "Sam Okafor"),
 * and the same 13 answers on X were told twice, three hours apart. Keys from before keep "author|" in front.
 */
const heardKey = (h: Pick<Heard, "text">): string => `|${words(h.text).slice(0, 80)}`;
const byWords = (key: string): string => key.slice(key.indexOf("|"));
/** Under this many characters an answer is a "thanks!", which two people say: only its own send's memory knows it. */
const TELLING_CHARS = 12;
/** Whether an answer is on record already: a conversation whose evidence, or a reply's quote, has its first words. */
const onRecord = (h: Pick<Heard, "text">, evidence: readonly string[]): boolean => {
  const start = words(h.text).slice(0, 60);
  return start.length >= TELLING_CHARS && evidence.some((e) => words(e).includes(start));
};

/**
 * On a post's own page (not a list of their notifications), whether words are an answer to the customer at all. Live,
 * 2026-11-13: of 19 answers told overnight, the watch had taken the post itself for one (it stands above their reply),
 * someone else's reply to the post's author ("@reubengoulart ...") for another, and their own reply for a third. An
 * answer comes after their reply on the page, and does not open by naming the author of the post instead of them.
 */
export function answersThem(pageText: string, heard: string, sent: readonly { kind: "reply" | "post"; said: string; author: string | null }[], account: string | null): boolean {
  const hay = words(pageText);
  const start = words(heard).replace(/…$/, "").slice(0, 40);
  const flat = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const named = /^@([\w.-]+)/.exec(heard.trim())?.[1];
  if (named && sent.some((s) => s.kind === "reply" && s.author && flat(s.author).includes(flat(named))) && !(account && flat(account).includes(flat(named)))) return false;
  const spots = sent.map((s) => ({ kind: s.kind, at: hay.indexOf(words(s.said).slice(0, 50)) }));
  const found = spots.filter((s) => s.at >= 0);
  // Their own words are not on the page as read: under a post of theirs everything is an answer; under someone's post, nothing can be told.
  if (!found.length) return sent.every((s) => s.kind === "post");
  return found.some((s) => hay.indexOf(start, s.at + 1) > s.at);
}

/** Their name as a person on that site would write it: u/name on Reddit, @handle elsewhere. */
const handle = (author: string): string => (/^(@|u\/)/.test(author) || /\s/.test(author) ? author : `@${author}`);

/** Something that went up with Post it, from a find's card or a draft's, as the watch sees it. */
interface Posted {
  readonly id: string;
  readonly customerId: CustomerId;
  /** A reply under someone's post or comment, or a post of their own. */
  readonly kind: "reply" | "post";
  /** The platform's key (platforms.ts): "reddit", "x", "threads"; "other" for a site Quest knows nothing about. */
  readonly platform: string;
  /** The post a reply went under, or the post itself. */
  readonly url: string;
  /** Where, in words: "Reddit (r/SaaS)". */
  readonly where: string;
  readonly sentUrl: string;
  readonly sentAt: Date;
  readonly sentAs: string | null;
  /** Whose words a reply answered. */
  readonly author: string | null;
  /** What went up, as the customer would recognise it. */
  readonly said: string;
  readonly checks: number;
  readonly seen: readonly string[];
  /** Records the look: when the next one falls due (null: never), after how many, and the answers told. */
  readonly save: (next: Date | null, checks: number, seen: readonly string[]) => Promise<void>;
}

/** "Reddit (r/nocode)", from a Reddit address. */
const redditWhere = (url: string): string => {
  const community = /\/r\/([A-Za-z0-9_]+)/.exec(url)?.[1];
  return sourceLabel(community ? `reddit:r/${community}` : "reddit", url);
};

export interface ReplyWatchDeps {
  readonly finds: FindRepository;
  /** Drafts that went up on a tap are looked at too (a private message is not: its answers go to their inbox). */
  readonly drafts?: Pick<DraftRepository, "dueWatches" | "watch"> & Partial<Pick<DraftRepository, "recent" | "toldAnswers">>;
  readonly reach: WebReach;
  /** Whether the customer's Chrome is open: the thread is read there. */
  readonly online: (customerId: CustomerId) => boolean;
  /** Whose Chrome is open now: only their sends are asked for. Without it, everyone's. */
  readonly onlineCustomers?: () => CustomerId[];
  readonly events: EventSink;
  /** A reply taken down is a lesson the whole team keeps. */
  readonly memory: Pick<MemoryRepository, "add">;
  /** A reply taken down sends Quest back to asking before it posts there. */
  readonly autopilot?: Pick<Autopilot, "removed" | "note">;
  /** An answer is a conversation on record: a result, with the person and their words. */
  readonly results?: Pick<ResultRepository, "record"> & Partial<Pick<ResultRepository, "list">>;
  /** Each look is a try on the posting route: taken down is a miss, answered a win. */
  readonly routes?: Pick<RouteRepository, "log">;
  /** The plan kept on the record of whoever wrote this post (note_person's plan, the introducer's), or null: their answer is met with its next step. */
  readonly plan?: (customerId: CustomerId, postUrl: string, author?: string) => Promise<string | null>;
  /**
   * Every word that went up as them in the week a watch lasts, and the words each answered. The last 300 drafts are
   * three hours of a busy account, likes included, so an older reply of theirs was read off a page as the other person's
   * answer, and a post they had replied to as an answer to them (live, 2026-11-13: step two of a plan went to someone
   * who had said nothing).
   */
  readonly sentWords?: (customerId: CustomerId) => Promise<{ own: string[]; quotes: string[] }>;
  /** Writes the plan's next step as a reply to their answer, by code; true when it was drafted. */
  readonly nextStep?: (customerId: CustomerId, answer: { url: string; author: string; quote: string; plan: string }) => Promise<boolean>;
  /** A like on an answer that asked nothing, at the answer's own address; whether it was offered. */
  readonly likeAnswer?: (customerId: CustomerId, answer: { url: string; author: string; quote: string }) => Promise<boolean>;
  /** Someone answered: a second message is planned for two days on (follow-ups.ts). */
  readonly followUp?: (customerId: CustomerId, answer: { person: string; url: string; quote: string }) => Promise<void>;
  /** Someone answered that they want to be left alone: kept for good, and what waits for them is skipped (contacts/said-no.ts). */
  readonly saidNo?: (customerId: CustomerId, answer: { url: string; author: string; words: string }) => Promise<unknown>;
  /** Every new answer, as it is read: for signs that are bad news whatever else it says (someone asks if they are a bot). */
  readonly heard?: (customerId: CustomerId, answer: { url: string; author: string; words: string }) => Promise<unknown>;
  /** Reads the answers off a page of their account on the other sites; without it, only Reddit is watched. */
  readonly answers?: Pick<AnswerReader, "read">;
  readonly wakeManager: () => void;
  readonly clock: Clock;
  readonly log: Logger;
}

/**
 * Looks again at the threads where something went up with Post it (a find's reply, or a reply or
 * post Quest drafted), for a week, and tells the manager when someone answered it, so the customer
 * hears while the conversation is warm, or when a reply was taken down, so they are not left talking
 * to nobody. The thread is read in the customer's Chrome like any page, only while it is open: then
 * the agent is awake anyway (its long poll is a request in flight), so nothing has to wake it for a look.
 */
export class ReplyWatch implements Loop {
  readonly #d: ReplyWatchDeps;
  readonly #everyMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #running: Promise<number> | null = null;
  /** When each customer's page of notifications was last read. In memory: a restart reads each once more. */
  readonly #lookedAt = new Map<string, number>();
  /** The lines each page showed when a model last read it: a look that shows no new line needs no model. */
  readonly #shown = new Map<string, Set<string>>();

  constructor(deps: ReplyWatchDeps, options: { everyMs: number }) {
    this.#d = deps;
    this.#everyMs = options.everyMs;
  }

  get busy(): boolean {
    return this.#running !== null;
  }

  start(): void {
    this.#timer ??= setInterval(() => void this.tick(), this.#everyMs);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#running;
  }

  /** Looks at everything posted that is due and whose customer's Chrome is open; returns how many answers were told. */
  tick(): Promise<number> {
    this.#running ??= this.#lookAtDue().finally(() => (this.#running = null));
    return this.#running;
  }

  async #lookAtDue(): Promise<number> {
    let told = 0;
    try {
      const now = this.#d.clock.now();
      // Only of customers whose Chrome is open, and first looks first: the limit went to the oldest due rows of anyone,
      // and 17 of the 20 were sends of customers set aside weeks before, whose Chrome never opens, so 3 rows moved a look
      // (live, 2026-11-15: 386 looks overdue, the oldest by 27 hours, and their launch post of that morning, with nine
      // comments under it, had not had its first).
      const only = this.#d.onlineCustomers?.();
      const drafts = this.#d.drafts ? await this.#d.drafts.dueWatches(now, DUE_A_LOOK, only) : [];
      const due = [...(await this.#d.finds.dueWatches(now, 20, only)).map((w) => this.#fromFind(w)), ...drafts.map((w) => this.#fromDraft(w))];
      // A draft with no words up (a like, a follow, a message) has no answers to look for: its watch ends, or it would
      // come due again on every look and keep the rest waiting.
      for (const w of drafts) if (!this.#fromDraft(w)) await this.#d.drafts?.watch(w.draft.id, null, w.checks, w.seen);
      // The other sites: everything of a customer's whose answers show on one page is looked at with one read.
      const elsewhere = new Map<string, Posted[]>();
      for (const p of due) {
        if (!p || !this.#d.online(p.customerId)) continue;
        if (p.platform === "reddit") {
          told += await this.#look(p);
          continue;
        }
        const key = `${p.customerId} ${answersPage(p.url)}`;
        elsewhere.set(key, [...(elsewhere.get(key) ?? []), p]);
      }
      // The page that answers for the most sends first: one read of their X mentions covers dozens, a post's own page one.
      for (const [key, group] of [...elsewhere.entries()].sort((a, b) => b[1].length - a[1].length)) {
        // A list of their notifications is read on its own clock; what is due there waits for it.
        const list = answersPage(group[0]!.url) !== group[0]!.url;
        if (list && now.getTime() - (this.#lookedAt.get(key) ?? 0) < SITE_LOOK_MS) continue;
        told += await this.#lookElsewhere(group);
      }
    } catch (e) {
      this.#d.log.error("watch.failed", { error: e instanceof Error ? e.message : String(e) });
    }
    return told;
  }

  #fromFind({ find, checks, seen }: WatchedFind): Posted | null {
    if (!find.sentUrl || !find.sentAt) return null;
    return {
      id: find.id,
      customerId: find.customerId,
      kind: "reply",
      platform: platformOf(find.url)?.key ?? "other",
      url: find.url,
      where: sourceLabel(find.source, find.url),
      sentUrl: find.sentUrl,
      sentAt: find.sentAt,
      sentAs: find.sentAs,
      author: find.author,
      said: find.reply,
      checks,
      seen,
      save: (next, n, s) => this.#d.finds.watch(find.id, next, n, s),
    };
  }

  #fromDraft({ draft, checks, seen }: WatchedDraft): Posted | null {
    const drafts = this.#d.drafts;
    // Only what put words up is watched for answers: a message goes to their inbox, and a like, a follow or a profile has none.
    if (!drafts || !draft.sentUrl || !draft.sentAt || (draft.kind !== "reply" && draft.kind !== "post")) return null;
    const platform = platformOf(draft.url) ?? platformOf(draft.platform);
    return {
      id: draft.id,
      customerId: draft.customerId,
      kind: draft.kind,
      platform: platform?.key ?? "other",
      // A reply's answers are under the post it went to (its own address is often their replies page: Threads, 2026-11-04).
      url: draft.kind === "post" ? draft.sentUrl : draft.url,
      where: platform?.key === "reddit" ? redditWhere(draft.url) : (platform?.name ?? draft.platform),
      sentUrl: draft.sentUrl,
      sentAt: draft.sentAt,
      sentAs: draft.sentAs,
      author: draft.author,
      said: draft.kind === "post" && draft.title ? `${draft.title}: ${draft.text}` : draft.text,
      checks,
      seen,
      save: (next, n, s) => drafts.watch(draft.id, next, n, s),
    };
  }

  async #look(p: Posted): Promise<number> {
    let page: PageText;
    try {
      // As a visitor: logged in, Reddit shows the customer their own removed comment as if it were up.
      page = await this.#d.reach.forCustomer(p.customerId).reader.readPage(p.sentUrl, { asVisitor: true, check: true });
    } catch (e) {
      // Chrome closed or its day's looks spent: the same look, next time. Anything else counts as a look.
      if (e instanceof ReadError && (e.reason === "offline" || e.reason === "limit")) {
        // Their Chrome's looks for the day are spent: said, since every look after it waits for tomorrow.
        if (e.reason === "limit") this.#d.log.warn("watch.limit", { error: e.message });
        return 0;
      }
      this.#d.log.warn("watch.read_failed", { id: p.id, error: e instanceof Error ? e.message : String(e) });
      this.#d.autopilot?.note(p.customerId, "watch", `could not open ${p.kind === "post" ? "the post" : "the reply"} on ${p.where} as a stranger: ${e instanceof ReadError ? e.reason : "error"}`);
      await p.save(nextLook(p.sentAt, p.checks + 1), p.checks + 1, p.seen);
      return 0;
    }
    // How a post looks to a stranger is not measured yet for a removed one: each look is logged until it is.
    if (p.kind === "post") {
      this.#d.log.info("watch.post_seen", { id: p.id, check: p.checks + 1, post: page.post ?? null, comments: page.comments?.length ?? 0, head: page.text.slice(0, 400) });
    }
    this.#d.autopilot?.note(
      p.customerId,
      "watch",
      `looked at ${p.kind === "post" ? "the post" : "the reply"} on ${p.where} as a stranger${page.post ? "" : ": no post on the page"}`,
    );
    // A reply taken down: nobody else sees it, so there is nothing to wait for. The customer hears why.
    // To a visitor its own address shows it as deleted (live, 2026-09-28), or shows the thread
    // without it at all (live, 2026-10-03: r/test's filter, "zero comments").
    const ref = commentRef(p.sentUrl);
    const hidden = Boolean(ref && (page.gone?.includes(ref) || (page.post && !(page.comments ?? []).some((c) => c.ref === ref))));
    // A post taken down shows a stranger its title and no words, with a line saying so (reddit.ts, `notice`).
    const down = p.kind === "reply" ? hidden : Boolean(page.post?.notice);
    if (down) {
      const what = p.kind === "reply" ? "reply" : "post";
      await p.save(null, p.checks + 1, p.seen);
      const route = await this.#d.routes?.log(p.customerId, postingRoute("Reddit"), "failed", `${what} taken down on ${p.where}`).catch(() => null);
      await this.#d.memory.add(p.customerId, {
        kind: "lesson",
        source: "system",
        text:
          `${p.where} took down a ${what} posted on ${p.sentAt.toISOString().slice(0, 10)}, as it went up. ` +
          `Likely its filter on new or low-karma accounts: a ${what} there is not seen until the account has some history.`,
      });
      await this.#d.events.push(p.customerId, {
        kind: "system",
        topic: "removed",
        text: [
          `The ${what} the customer posted on ${p.where} (${p.sentUrl}) no longer shows to anyone else:`,
          p.kind === "reply"
            ? "Reddit shows it as deleted or removed. Most often a community's automatic filter takes down comments from new or low-karma accounts as they go up."
            : `To a stranger it shows its title and no words: "${page.post?.notice ?? "removed"}". Most often a community's filter takes down posts from new or low-karma accounts.`,
          `Their ${what} was: "${clip(p.said, 240)}"`,
          ...(this.#d.autopilot ? ["Until they approve a few more, every post on Reddit waits for their tap again."] : []),
          ...(route?.status === "spent"
            ? [
                `That is ${route.misses} in a row taken down on Reddit: the route "${route.name}" is spent. Say plainly that it didn't get anywhere, ` +
                  "and change course now (another place, another way to reach these people, or building the account's history first) without waiting to be told.",
              ]
            : []),
          "Tell them now (see ANSWERS).",
        ].join("\n"),
      });
      await this.#d.autopilot?.removed(p.customerId, "reddit");
      this.#d.autopilot?.note(p.customerId, "watch", `${what} taken down on ${p.where}: ${p.sentUrl}`);
      this.#d.wakeManager();
      this.#d.log.info("watch.removed", { id: p.id });
      return 0;
    }
    const fresh = answersTo(page, p.sentAs, p.sentUrl, p.kind).filter((c) => !p.seen.includes(c.ref!));
    await p.save(nextLook(p.sentAt, p.checks + 1), p.checks + 1, [...p.seen, ...fresh.map((c) => c.ref!)]);
    if (!fresh.length) return 0;

    // Someone talking back is a conversation: a result on record, and the posting route working.
    await this.#d.routes?.log(p.customerId, postingRoute("Reddit"), "worked", `answered on ${p.where}`).catch(() => null);
    for (const c of fresh) {
      if (!c.author) continue;
      await this.#d.results
        ?.record(p.customerId, {
          stage: "conversation",
          person: `u/${c.author}`,
          count: 1,
          url: commentPermalink(p.sentUrl, c.ref!),
          evidence: `answered ${p.kind === "post" ? "their post" : "their reply"} on ${p.where}: "${clip(c.text.replace(/\s+/g, " "), 160)}"`,
          source: "system",
        })
        .catch(() => null);
    }
    const who = (c: PageComment): string => `u/${c.author ?? "someone"}${same(c.author, p.author) ? " (the person they answered)" : ""}`;
    const what = p.kind === "post" ? `the post the customer put up with Post it on ${p.where}` : `the reply the customer posted with Post it on ${p.where}`;
    await this.#d.events.push(p.customerId, {
      kind: "system",
      topic: "answers",
      text: [
        `${fresh.length === 1 ? "Someone answered" : `${fresh.length} people answered`} ${what} (${p.sentUrl}).`,
        `${p.kind === "post" ? "Their post was" : "Their reply was"}: "${clip(p.said, 240)}"`,
        ...fresh.map((c) => `- ${who(c)}${c.postedAt ? ` on ${c.postedAt.toISOString().slice(0, 10)}` : ""} (${commentPermalink(p.sentUrl, c.ref!)}): "${clip(c.text, 500)}"`),
        "Tell them now (see ANSWERS).",
      ].join("\n"),
    });
    this.#d.autopilot?.note(p.customerId, "watch", `${fresh.length} new ${fresh.length === 1 ? "answer" : "answers"} on ${p.where}: ${p.sentUrl}`);
    this.#d.wakeManager();
    this.#d.log.info("watch.answers", { id: p.id, answers: fresh.length });
    return fresh.length;
  }

  /**
   * One customer's sends on a site other than Reddit whose answers show on one page (their notifications there, or the
   * post): read once as their own account, drawn where the site shows its words only on screen, and its answers read
   * off by the model. Each answer is told once, whichever of the group it came to.
   */
  /** What went up as them lately, from cards and finds, on any site, and the words their replies answer, up or on a card. */
  async #theirs(customerId: CustomerId): Promise<{ own: string[]; answered: string[] }> {
    const drafts = (await this.#d.drafts?.recent?.(customerId, 300).catch(() => [])) ?? [];
    const finds = await this.#d.finds.listFor(customerId, ["replied"], 200).catch(() => []);
    const week = (await this.#d.sentWords?.(customerId).catch(() => null)) ?? { own: [], quotes: [] };
    return {
      own: [...week.own, ...drafts.filter((d) => d.sentAt && d.text.trim()).map((d) => d.text), ...finds.filter((f) => f.sentAt && f.reply.trim()).map((f) => f.reply)],
      answered: [...week.quotes, ...drafts.filter((d) => d.kind === "reply" && (d.status !== "skipped" || d.answeredAt)).flatMap((d) => (d.quote ? [d.quote] : [])), ...finds.map((f) => f.quote)],
    };
  }

  /**
   * The answers told for anything of theirs on a site. A list of their notifications shows the same answers look after
   * look, and each send has a memory of its own: live, 2026-11-05, Md Sikandar's one question was told ten times in a
   * day, each time a send with nothing told yet came due.
   */
  async #toldOn(customerId: CustomerId, platform: string): Promise<string[]> {
    const lists = await Promise.all([this.#d.finds.toldAnswers(customerId), this.#d.drafts?.toldAnswers?.(customerId) ?? []]).catch(() => []);
    return lists
      .flat()
      .filter((t) => (platformOf(t.url)?.key ?? "other") === platform)
      .flatMap((t) => t.seen.map(byWords))
      .filter((key) => key.length > TELLING_CHARS);
  }

  async #lookElsewhere(group: readonly Posted[]): Promise<number> {
    const first = group[0]!;
    const where = answersPage(first.url);
    const next = async (seen: readonly string[] = []): Promise<void> => {
      for (const p of group) await p.save(nextLook(p.sentAt, p.checks + 1), p.checks + 1, [...new Set([...p.seen, ...seen])]);
    };
    if (!this.#d.answers) return (await next(), 0);
    // Bluesky says who replied to what by its public API: no page, no model, and no yes is missed (bluesky-answers.ts).
    const sky = blueskyPost(where) ? await blueskyAnswers(where, group.map((p) => p.said)).catch(() => null) : null;
    // No model to read the answers off the page: the page is not opened either (live, 2026-11-14: 63 looks read their
    // notifications during a two-hour rest, each for nothing).
    if (!sky && modelRest.until()) return 0;
    let page: PageText;
    if (sky) page = sky.page;
    else try {
      page = await this.#d.reach.forCustomer(first.customerId).reader.readPage(where, { check: true, drawn: drawnOn(where) });
    } catch (e) {
      if (e instanceof ReadError && (e.reason === "offline" || e.reason === "limit")) {
        // Their Chrome's looks for the day are spent: said, since every look after it waits for tomorrow.
        if (e.reason === "limit") this.#d.log.warn("watch.limit", { error: e.message });
        return 0;
      }
      this.#d.log.warn("watch.read_failed", { id: first.id, page: where, error: e instanceof Error ? e.message : String(e) });
      // Their window minimised or covered, and the page shows its posts only on screen: nothing was seen, so the same look
      // a little later, unless the next is due by then. Live, 2026-11-04: X's mentions spent a reply's 15-minute look so.
      if (e instanceof ReadError && e.reason === "hidden") {
        const later = new Date(this.#d.clock.now().getTime() + HIDDEN_RETRY_MS);
        for (const p of group) {
          const after = nextLook(p.sentAt, p.checks + 1);
          if (after && after > later) await p.save(later, p.checks, p.seen);
          else await p.save(after, p.checks + 1, p.seen);
        }
        return 0;
      }
      await next();
      return 0;
    }
    // The page was read: its clock starts. A look that saw nothing (a covered window, a failed read) starts none.
    if (where !== first.url) this.#lookedAt.set(`${first.customerId} ${where}`, this.#d.clock.now().getTime());
    let heard: Heard[];
    try {
      const sent = group.map((p) => ({ kind: p.kind, to: p.author, said: p.said, at: p.sentAt, url: p.url }));
      // Nothing on the page that was not there when it was last read: nobody new answered, and no model is asked.
      const shownKey = `${first.customerId} ${where}`;
      const shown = sky ? { all: [], top: [] } : shownOn(page);
      const before = this.#shown.get(shownKey);
      if (!sky && before && shown.top.length > 0 && shown.top.every((l) => before.has(l))) {
        this.#d.log.info("watch.nothing_new", { id: first.id, site: first.platform, sent: group.length });
        heard = [];
      } else {
        heard = sky ? sky.heard : await this.#d.answers.read(first.customerId, page, sent, page.account ?? null);
        if (!sky) {
          this.#shown.delete(shownKey);
          this.#shown.set(shownKey, new Set(shown.all));
          if (this.#shown.size > SHOWN_KEPT) this.#shown.delete(this.#shown.keys().next().value!);
        }
      }
      // Their own words are never an answer, whichever of their sends they are: a page of their activity lists their other
      // replies too, often with no name over them. Live, 2026-11-05: their reply to @alexanderthedev, not due in that look,
      // was told to them as his answer, and "Congrats on the Germany launch" as lalibnu's.
      const { own, answered } = await this.#theirs(first.customerId);
      // Nor is what a reply of theirs already answers news, up or waiting on its card.
      heard = heard.filter((h) => !own.some((said) => quoteAppears(h.text, said)) && !onRecord(h, answered));
      // A post's own page shows the post, their reply and everyone else's: only what answers them counts.
      if (!sky && where === first.url) {
        const before = heard.length;
        heard = heard.filter((h) => answersThem(page.text, h.text, group, page.account ?? first.sentAs));
        if (heard.length < before) this.#d.log.info("watch.not_to_them", { id: first.id, page: where, dropped: before - heard.length });
      }
    } catch (e) {
      // No model answered: the same look, next time.
      this.#d.log.warn("watch.answers_failed", { id: first.id, error: e instanceof Error ? e.message : String(e) });
      return 0;
    }
    // Told before: by a look at these sends, or on record from a look at others of theirs.
    const told = new Set([...group.flatMap((p) => p.seen).map(byWords), ...(await this.#toldOn(first.customerId, first.platform))]);
    const evidence = ((await this.#d.results?.list?.(first.customerId, 300).catch(() => [])) ?? []).filter((r) => r.stage === "conversation").map((r) => r.evidence);
    const fresh = heard.filter((h) => !told.has(heardKey(h)) && !onRecord(h, evidence));
    await next(fresh.map(heardKey));
    this.#d.autopilot?.note(first.customerId, "watch", `looked for answers on ${first.where} (${where}): ${fresh.length ? `${fresh.length} new` : "none new"}`);
    if (!fresh.length) return 0;

    // The answer's own address, where the page cuts its rows into posts (X's mentions): a reply to it goes there, never to the list.
    // The very words by the same person first: quoteAppears wants 12 characters, and the plainest yes is shorter (live,
    // 2026-11-15: a maker's "Yeah, sure" to an introduction had no address, so neither the introductions nor a like followed).
    const flat = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
    const addressOf = (h: Heard): string | null =>
      (page.posts?.find((post) => flat(post.text) === flat(h.text) && (!post.author || handle(post.author) === handle(h.author))) ?? page.posts?.find((post) => quoteAppears(h.text, post.text)))?.url ?? null;
    const line = (h: Heard, extra = ""): string => `- ${handle(h.author)}${extra}${addressOf(h) ? ` (${addressOf(h)})` : ""}: "${clip(h.text, 500)}"`;
    await this.#d.routes?.log(first.customerId, postingRoute(first.where), "worked", `answered on ${first.where}`).catch(() => null);
    // A no is the end of it (the founder, 2026-11-18: "if someone asks not to do it, don't"): kept, and nothing below is owed them.
    for (const h of fresh) await this.#d.heard?.(first.customerId, { url: addressOf(h) ?? (h.to === null ? page.url : group[h.to]!.url), author: handle(h.author), words: clip(h.text.replace(/\s+/g, " "), 300) }).catch(() => undefined);
    const no = new Set(fresh.filter((h) => saysNo(h.text)));
    for (const h of no) {
      const url = addressOf(h) ?? (h.to === null ? page.url : group[h.to]!.url);
      await this.#d.saidNo?.(first.customerId, { url, author: handle(h.author), words: clip(h.text.replace(/\s+/g, " "), 300) }).catch((e: unknown) => this.#d.log.warn("watch.said_no_failed", { error: e instanceof Error ? e.message : String(e) }));
      this.#d.log.info("watch.said_no", { id: first.id, site: first.platform, person: handle(h.author) });
    }
    for (const h of fresh) {
      const p = h.to === null ? null : group[h.to]!;
      await this.#d.results
        ?.record(first.customerId, {
          stage: "conversation",
          person: handle(h.author),
          count: 1,
          url: addressOf(h) ?? p?.url ?? page.url,
          evidence: `${no.has(h) ? "asked to be left alone, answering" : "answered"} ${!p ? "them" : p.kind === "post" ? "their post" : "their reply"} on ${first.where}: "${clip(h.text.replace(/\s+/g, " "), 160)}"`,
          source: "system",
        })
        .catch(() => null);
    }
    // A warm conversation is planned ahead: a second message two days on, shown in their feed until it is written.
    for (const h of fresh) {
      if (no.has(h)) continue;
      // An answer read off their notifications with no address of its own is planned on that page: the message goes to their profile.
      const url = addressOf(h) ?? (h.to === null ? page.url : group[h.to]!.url);
      if (url) await this.#d.followUp?.(first.customerId, { person: handle(h.author), url, quote: clip(h.text.replace(/\s+/g, " "), 160) }).catch(() => undefined);
    }
    // Asked by who answered, not by the post the reader tied the answer to: it ties one to the wrong reply of theirs at times.
    const planOf = new Map<Heard, string>();
    for (const h of fresh) {
      if (no.has(h)) continue;
      const plan = this.#d.plan ? await this.#d.plan(first.customerId, page.url, h.author).catch(() => null) : null;
      if (plan) planOf.set(h, plan);
    }
    // Where the answer has an address of its own, the next step is written now, with no model turn deciding whether to.
    const stepped = new Set<Heard>();
    for (const h of planOf.keys()) {
      const url = addressOf(h);
      if (url && this.#d.nextStep && (await this.#d.nextStep(first.customerId, { url, author: h.author, quote: clip(h.text.replace(/\s+/g, " "), 160), plan: planOf.get(h)! }).catch(() => false))) stepped.add(h);
    }
    // Everyone who answered hears back (live, 2026-11-13: of about 60 answers in three days some 45 got nothing, questions
    // among them, while the manager was left to choose). A question is owed words, which the turn writes from what it knows;
    // anything else gets a like on the answer, by code, where the answer has an address of its own to put it on.
    // A yes to "want the link?" is owed the link, never only a like.
    const yes = (h: Heard): boolean => h.to !== null && offersIt(group[h.to]!.said) && saysYes(h.text);
    const asks = (h: Heard): boolean => yes(h) || /\?/.test(h.text) || /^\W*(how|what|why|where|when|which|who|do|does|did|is|are|can|could|would|will|any)\b/i.test(h.text.trim());
    const liked = new Set<Heard>();
    for (const h of fresh) {
      const url = addressOf(h);
      if (no.has(h) || stepped.has(h) || planOf.has(h) || asks(h) || !url || !this.#d.likeAnswer) continue;
      if (await this.#d.likeAnswer(first.customerId, { url, author: h.author, quote: clip(h.text.replace(/\s+/g, " "), 160) }).catch(() => false)) liked.add(h);
    }
    const owedWords = fresh.filter((h) => !no.has(h) && !stepped.has(h) && !planOf.has(h) && asks(h));
    const owed = (h: Heard): string =>
      stepped.has(h)
        ? `  ${handle(h.author)} was sent people before and answered: the plan's next step is already drafted as a reply to this answer. Draft nothing more for them.`
        : `  The plan kept for ${handle(h.author)}: ${planOf.get(h)} They answered, so take its next step now, as a reply to their answer (helps true): never only a like.`;
    const lines = group.flatMap((p, i) => {
      const theirs = fresh.filter((h) => h.to === i);
      if (!theirs.length) return [];
      const what = p.kind === "post" ? `Their post on ${p.where} (${p.url})` : `Their reply on ${p.where}${p.author ? ` to ${handle(p.author)}` : ""} (${p.url})`;
      return [
        `${what} was: "${clip(p.said, 240)}"`,
        ...theirs.map((h) => line(h, same(h.author, p.author) ? " (the person they answered)" : "")),
        ...theirs.filter((h) => planOf.has(h)).map(owed),
      ];
    });
    // Answers to them there that come to none of these (an older reply of theirs, a mention): theirs too, said as such.
    const other = fresh.filter((h) => h.to === null);
    if (other.length) lines.push(`Answering them there, to something older of theirs (${page.url}):`, ...other.flatMap((h) => [line(h), ...(planOf.has(h) ? [owed(h)] : [])]));
    await this.#d.events.push(first.customerId, {
      kind: "system",
      topic: "answers",
      text: [
        `${fresh.length === 1 ? "Someone answered" : `${fresh.length} answers came to`} what went up as the customer on ${first.where}, read on ${where}:`,
        ...lines,
        ...(no.size ? [`ASKED TO BE LEFT ALONE: ${[...no].map((h) => handle(h.author)).join(", ")}. Kept for good, and what waited for them is skipped by code. Draft nothing for them, not an apology either, and name them under nobody's post.`] : []),
        ...(liked.size ? [`Already liked by code, nothing more owed: ${[...liked].map((h) => handle(h.author)).join(", ")}.`] : []),
        ...(owedWords.length
          ? [`OWED AN ANSWER, each of them, in this turn: ${owedWords.map((h) => handle(h.author)).join(", ")} asked something${owedWords.some(yes) ? `, or said yes to the link they were offered (${owedWords.filter(yes).map((h) => handle(h.author)).join(", ")}: the reply is their site's link, the product's name and that the first run is free, in a line)` : ""}. Draft a reply (kind reply, the answer's own address, a short quote of it) that answers what they asked, truly and from what you know; the product's name and link only if they asked where or what it is, or said yes to that offer. Never leave one of them with nothing.`]
          : []),
        "Tell them now (see ANSWERS).",
      ].join("\n"),
    });
    this.#d.wakeManager();
    this.#d.log.info("watch.answers", { id: first.id, site: first.platform, answers: fresh.length });
    return fresh.length;
  }
}
