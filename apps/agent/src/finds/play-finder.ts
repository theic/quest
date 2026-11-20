import { ReadError, SearchError, type CustomerId, type CustomerRepository, type Draft, type FoundPost, type Logger, type MemoryRepository, type ModelUsage, type PageReader, type PageText, type PostQuery, type PostSearch, type SearchLog, type SpendLog, type TaskId } from "@mq/core";
import type { ModelProvider } from "../agents/models.ts";
import { replySpot } from "../drafts/one-reply.ts";
import type { SearchStreak } from "../tasks/search-streak.ts";
import { quoteAppears } from "../tasks/seen-pages.ts";
import { SOURCE_SITES } from "../tasks/site-pin.ts";
import { BatchJudge, type Fit, type JudgedPost } from "./batch-judge.ts";
import type { FindLedger } from "./find-service.ts";
import { searchWords } from "./search-words.ts";

/**
 * People for a play, found by code (the founder, 2026-10-31: browsing and posting that cost pennies, not dollars). The
 * outreach teammate on X took 29 to 46 model steps a run, about 41,000 tokens each, to find the people a play names by
 * scrolling and opening pages: $0.087 a draft. The first sweep's pieces do that part here: the search words for the play
 * in one call, the site's own search cut into posts by code (`chrome/sites.ts`), the posts judged 40 at a time on the
 * volume seat against the play, the customer's decisions and an age limit, and each pick's post read before it is
 * quoted. The teammate's model keeps what needs its judgement: each person's background before a first word, and what
 * goes to the writer.
 *
 * It searches one query at a time and stops when it has enough people, or when a few searches in a row turned up
 * nobody new (the run's `SearchStreak`); a search the record says found nobody is not run again.
 */

/**
 * Who gets a like: a far wider net than the play, since a like asks nothing of them and costs next to nothing. Live,
 * 2026-11-06: 17 of 23 runs on X put nothing up, the play turning down every post of the few a search gave.
 */
const LIKE_PLAY = "Someone who makes things, sharing their own work, progress or struggle: a founder, indie maker or developer a fellow builder would give a friendly like. Not ads, giveaways, recruiters, news, tip threads, or people selling services to founders.";
/** Posts looked at for likes after the picks, and likes given back, at most. */
const LIKE_POOL = 40;
const LIKES_A_FIND = 10;

/** Searches it plans for a play, at most. */
const QUERIES = 12;
/** Posts kept of each search. */
const PER_SEARCH = 20;
/**
 * Searches in a row with no pick before the finder stops: twice a model's own (EMPTY_IN_A_ROW), since a search by code
 * costs a page and one cheap call. Live, 2026-11-11: an X run stopped after 3 searches that had 7 new posts between
 * them, a minute in (the founder: "it gives up early").
 */
const FINDER_EMPTY = 6;
/** How far back a person written to is not picked again. */
const WRITTEN_DAYS = 14;
/** How much of a read thread the second look sees: the post and the first replies under it. */
const READ_CHARS = 1_500;

export type Within = "day" | "week" | "month";
const WITHIN_DAYS: Readonly<Record<Within, number>> = { day: 2, week: 8, month: 31 };

export interface PlayAsk {
  readonly customerId: CustomerId;
  readonly taskId: TaskId | null;
  /** Who to find, in the manager's words: "founders who just shared what they built, a launch or a just-shipped post". */
  readonly play: string;
  /** The search source: "x", "linkedin", "reddit", "bluesky", … */
  readonly source: string;
  readonly within: Within;
  /** People wanted. */
  readonly want: number;
  readonly posts: PostSearch;
  readonly reader: PageReader;
  /** The run's searches: shared with search_posts, so a run stops searching once it turns up nobody new. */
  readonly streak: SearchStreak;
  /** Each search that ran, with the addresses it turned up: the run's trail, kept in `mq.searches`. */
  readonly searched?: (source: string, query: string, urls: readonly string[]) => void;
  /**
   * The gift: someone else's product, whose customers are sought (customers_for). The customer's own brief, decisions
   * and past searches then stay out of it, and nobody is picked for a like.
   */
  readonly about?: string;
  /** Each page read, for the run's seen pages: what the teammate quotes must be on one. */
  readonly read?: (url: string, page: PageText) => void;
}

export interface PlayPick {
  /** The post as read: its whole words, who and when. */
  readonly post: FoundPost;
  readonly fit: Fit;
  readonly quote: string;
  readonly why: string;
  /** The search that turned it up. */
  readonly query: string;
  /** The replies under it, as read (X): how many, and whether one is the customer's. */
  readonly replies: readonly FoundPost[];
}

/** A post worth a like, seen in a search: not read further, since nothing is written to them. */
export interface PlayLike {
  readonly post: FoundPost;
  readonly quote: string;
}

export interface PlayFound {
  readonly picks: readonly PlayPick[];
  /** Posts of other people worth a like. */
  readonly likes: readonly PlayLike[];
  /** Each search that ran: its words, the posts it gave, the people picked from it, or why it failed. */
  readonly searches: readonly { readonly query: string; readonly posts: number; readonly picks: number; readonly error?: string }[];
  /** Searches not run: the record says they found nobody before. */
  readonly skipped: readonly string[];
  /** Pages read in their Chrome: searches and the picks' posts. */
  readonly pages: number;
  /** Picks dropped once read: the quote not on the post, the second look, the customer already there. */
  readonly dropped: number;
  /** Why it stopped: enough people, a few searches with nobody new, no searches left, or their Chrome could not read. */
  readonly stopped: "enough" | "empty" | "searched" | "unreachable";
  readonly usage: ModelUsage;
  readonly ms: number;
}

export interface PlayFinderDeps {
  readonly models: ModelProvider;
  readonly customers: Pick<CustomerRepository, "get">;
  readonly memory: Pick<MemoryRepository, "list">;
  readonly finds: Pick<FindLedger, "known">;
  readonly searches?: Pick<SearchLog, "recent">;
  /** The customer's latest drafts: a post already answered, or a person already written to, is not picked again. */
  readonly drafts?: { recent(customerId: CustomerId, limit: number): Promise<Draft[]> };
  /** The shared cache of people (mq.known_people): everyone a search turns up is kept there, picked or not. */
  readonly known?: { saw(posts: readonly (FoundPost & { side: "ask" | "launch" })[]): Promise<void> };
  readonly spend?: SpendLog;
  readonly log: Logger;
  readonly now?: () => Date;
}

/** A post that says its author made something: kept in the pool as a launch, anything else as someone asking or saying. */
const MADE = /\b(launched|shipped|built|released|made|introducing|my (app|tool|game|bot|site|startup|saas|side project|product)|beta testers|first users|show hn|now live|is live)\b/i;

const NO_USAGE: ModelUsage = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0 };
const add = (a: ModelUsage, b: ModelUsage | null): ModelUsage =>
  b ? { input: a.input + b.input, cached: a.cached + b.cached, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output, reasoning: a.reasoning + b.reasoning, cost: (a.cost ?? 0) + (b.cost ?? 0) } : a;

/** A person as a site knows them: an X post's handle from its address, else the author's name. */
export function personOf(url: string, author: string | null): string | null {
  const x = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\//i.exec(url)?.[1];
  const who = x ?? author;
  return who ? who.replace(/^@|^u\//i, "").toLowerCase() : null;
}

export class PlayFinder {
  readonly #d: PlayFinderDeps;
  readonly #now: () => Date;

  constructor(deps: PlayFinderDeps) {
    this.#d = deps;
    this.#now = deps.now ?? (() => new Date());
  }

  async find(ask: PlayAsk): Promise<PlayFound> {
    const d = this.#d;
    const started = Date.now();
    const id = ask.customerId;
    const customer = await d.customers.get(id);
    const other = ask.about?.trim();
    const brief = other
      ? `For this play the product is not the customer's own. It is someone else's, and the people sought are those who would use it:\n${other}`
      : customer.brief?.trim() || `Their site: ${customer.siteUrl ?? "not given"}.`;
    const kept = await d.memory.list(id, 60);
    const rules = other ? "" : kept.filter((m) => m.kind === "decision" || m.kind === "lesson").map((m) => `- ${m.text}`).join("\n");
    const maxAgeDays = WITHIN_DAYS[ask.within];
    const oldest = this.#now().getTime() - maxAgeDays * 86_400_000;
    let usage = NO_USAGE;

    // What earlier runs searched on this site: none is written again, and the words that found people come after this
    // play's own. Live, 2026-11-01: put first, founder searches from other plays turned up only people already met, three
    // in a row, and "just launched my expense tracker" never ran.
    const site = SOURCE_SITES[ask.source] ?? ask.source;
    const past = other ? [] : (await d.searches?.recent(id, { site, days: 30, limit: 300 }).catch(() => [])) ?? [];
    const worked = [...new Set(past.filter((s) => s.hits > 0 && !/^https?:/.test(s.query)).sort((a, b) => b.hits - a.hits).map((s) => s.query))];
    const words = await searchWords(d.models, { customerId: id, brief, play: ask.play, rules, tried: [...new Set(past.map((s) => s.query).filter((q) => !/^https?:/.test(q)))].slice(0, 30).join("\n") }, "volume", QUERIES);
    usage = add(usage, words.usage);
    if (words.usage) d.spend?.record({ customerId: id, taskId: ask.taskId, agent: "finder", model: null, ms: Date.now() - started, usage: words.usage });
    const queries = [...new Set([...words.queries, ...worked.slice(0, 3)])];

    // Who not to pick again: posts already answered, people written to lately, finds they already have.
    const drafts = (await d.drafts?.recent(id, 200).catch(() => [])) ?? [];
    const answered = new Set(drafts.map((x) => replySpot(x.url)).filter((s): s is string => s !== null));
    const since = this.#now().getTime() - WRITTEN_DAYS * 86_400_000;
    const written = new Set(drafts.filter((x) => x.createdAt.getTime() >= since && x.kind !== "post" && x.kind !== "profile").map((x) => personOf(x.url, x.author ?? x.target)).filter((s): s is string => s !== null));

    const judge = new BatchJudge({ models: d.models, ...(d.spend ? { spend: d.spend } : {}), log: d.log, now: this.#now });
    const judging = { customerId: id, taskId: ask.taskId, brief, play: ask.play, rules, maxAgeDays };
    const searches: { query: string; posts: number; picks: number; error?: string }[] = [];
    const skipped: string[] = [];
    const waiting: (JudgedPost & { query: string })[] = [];
    const picks: PlayPick[] = [];
    const people = new Set<string>();
    const pool = new Map<string, FoundPost>();
    let me: string | null = null;
    let pages = 0;
    let dropped = 0;
    // Why each pick was dropped once read, for the log: a site whose picks all go one way has a reader to fix.
    const drops: Record<string, number> = {};
    const drop = (why: string): void => {
      dropped++;
      drops[why] = (drops[why] ?? 0) + 1;
    };
    let stopped: PlayFound["stopped"] = "searched";
    let next = 0;
    // Empty searches count for this site and play: founders on X running dry says nothing of Reddit, or of who wants their tool.
    const lane = `${ask.source}|${ask.play.trim().toLowerCase()}`;

    const order = (j: JudgedPost) => (j.fit === "strong" ? 0 : 1);
    while (picks.length < ask.want) {
      // 1. Search until there are a few more candidates than people still wanted.
      while (waiting.length < ask.want - picks.length + 1 && next < queries.length) {
        if (ask.streak.spent(lane, FINDER_EMPTY)) break;
        const query = queries[next++]!;
        const q: PostQuery = { source: ask.source, query, within: ask.within, limit: PER_SEARCH };
        if (await ask.streak.triedBefore(q)) {
          skipped.push(query);
          continue;
        }
        let found: FoundPost[];
        try {
          found = await ask.posts.search(q);
          pages++;
        } catch (e) {
          const reason = e instanceof SearchError ? e.reason : "error";
          searches.push({ query, posts: 0, picks: 0, error: `${reason}: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}` });
          ask.streak.turnedUp(lane, false);
          d.log.info("finder.search_failed", { customerId: id, taskId: ask.taskId, source: ask.source, reason });
          // Their Chrome gone, its day's pages spent or the site refusing: no other search would fare better.
          if (reason === "offline" || reason === "rate_limited" || reason === "refused") {
            stopped = "unreachable";
            next = queries.length;
          } else pages++;
          continue;
        }
        ask.searched?.(ask.source, query, found.map((p) => p.url));
        // Everyone browsed is remembered (the founder, 2026-11-12: "if a person doesn't fit, put it into the pool and
        // continue searching, the contacts can later be used for connection"): the matcher reads them later.
        void d.known?.saw(found.map((p) => ({ ...p, side: MADE.test(`${p.title ?? ""} ${p.text}`) ? ("launch" as const) : ("ask" as const) }))).catch(() => undefined);
        for (const p of found) {
          const who = personOf(p.url, p.author);
          const spot = replySpot(p.url);
          if (who && !pool.has(who) && !(spot && answered.has(spot)) && !(p.postedAt && p.postedAt.getTime() < oldest)) pool.set(who, p);
        }
        const known = await d.finds.known(id, found.map((p) => p.url));
        const fresh = ask.streak.fresh(found).filter((p) => {
          const who = personOf(p.url, p.author);
          const spot = replySpot(p.url);
          return !known.has(p.url) && !(spot && answered.has(spot)) && !(who && (written.has(who) || people.has(who))) && !(p.postedAt && p.postedAt.getTime() < oldest);
        });
        const out = fresh.length ? await judge.judge({ ...judging, posts: fresh }) : null;
        if (out) usage = add(usage, out.usage);
        const mine = (out?.judged ?? []).filter((j) => {
          const who = personOf(j.post.url, j.post.author);
          if (who && (people.has(who) || waiting.some((w) => personOf(w.post.url, w.post.author) === who))) return false;
          return true;
        });
        waiting.push(...mine.map((j) => ({ ...j, query })));
        waiting.sort((a, b) => order(a) - order(b) || (b.post.postedAt?.getTime() ?? 0) - (a.post.postedAt?.getTime() ?? 0));
        searches.push({ query, posts: found.length, picks: mine.length });
        ask.streak.turnedUp(lane, mine.length > 0);
      }
      if (!waiting.length) {
        if (ask.streak.spent(lane, FINDER_EMPTY) && stopped !== "unreachable") stopped = "empty";
        break;
      }

      // 2. Read the best before anyone is quoted, and look again with the whole post and what is under it.
      const batch = waiting.splice(0, ask.want - picks.length + 1);
      const reads = await Promise.all(
        batch.map(async (j) => {
          try {
            const page = await ask.reader.readPage(j.post.url);
            pages++;
            ask.read?.(j.post.url, page);
            me = page.account?.toLowerCase() ?? me;
            return { j, page };
          } catch (e) {
            d.log.info("finder.read_failed", { customerId: id, taskId: ask.taskId, reason: e instanceof ReadError ? e.reason : "error" });
            return { j, page: null };
          }
        }),
      );
      const looked: { j: JudgedPost & { query: string }; post: FoundPost; replies: FoundPost[] }[] = [];
      for (const { j, page } of reads) {
        if (!page) {
          drop("unread");
          continue;
        }
        // A LinkedIn post with no address of its own points at its author's activity, where every post has that
        // address: the one that holds the quote is theirs (live, 2026-11-11: all three LinkedIn picks of a run were
        // dropped, each checked against the first post on that page).
        const there = (page.posts ?? []).filter((p) => replySpot(p.url) === replySpot(j.post.url));
        const own = there.find((p) => quoteAppears(j.quote, p.text)) ?? there[0] ?? null;
        const words = own?.text ?? page.text;
        const replies = (page.posts ?? []).filter((p) => p !== own);
        // The quote must be on the post as read, and the customer must not be there already.
        if (!quoteAppears(j.quote, [j.post.title, words].filter(Boolean).join("\n"))) {
          drop("quote");
          continue;
        }
        if ((page.account && replies.some((r) => personOf(r.url, r.author) === page.account!.toLowerCase())) || (page.account && personOf(j.post.url, j.post.author) === page.account.toLowerCase())) {
          drop("theirs");
          continue;
        }
        const thread = [words, ...replies.slice(0, 5).map((r) => `Reply by ${r.author ?? "someone"}: ${r.text}`)].join("\n").slice(0, READ_CHARS);
        looked.push({ j, post: { ...j.post, text: thread, author: own?.author ?? j.post.author, postedAt: own?.postedAt ?? j.post.postedAt, replies: own?.replies ?? j.post.replies, preview: false }, replies });
      }
      const again = looked.length ? await judge.judge({ ...judging, posts: looked.map((l) => l.post) }) : null;
      if (again) usage = add(usage, again.usage);
      for (const l of looked) {
        const held = again?.judged.find((a) => a.post === l.post);
        if (!held || picks.length >= ask.want) {
          if (!held) drop("second look");
          continue;
        }
        const who = personOf(l.j.post.url, l.post.author);
        if (who) people.add(who);
        // The quote is the first look's, already found on the post as read: never words from a reply under it.
        picks.push({ post: { ...l.post, text: l.post.text.split("\nReply by ")[0]! }, fit: held.fit, quote: l.j.quote, why: held.why || l.j.why, query: l.j.query, replies: l.replies });
      }
      if (picks.length >= ask.want) stopped = "enough";
      if (stopped === "unreachable") break;
    }

    const likes: PlayLike[] = [];
    const rest = [...pool].filter(([who]) => who !== me && !people.has(who)).map(([, p]) => p).slice(0, LIKE_POOL);
    if (rest.length && !other) {
      const liked = await judge.judge({ ...judging, play: LIKE_PLAY, wide: true, posts: rest }).catch(() => null);
      if (liked) usage = add(usage, liked.usage);
      likes.push(...(liked?.judged ?? []).slice(0, LIKES_A_FIND).map((j) => ({ post: j.post, quote: j.quote })));
    }

    const out: PlayFound = { picks, likes, searches, skipped, pages, dropped, stopped, usage, ms: Date.now() - started };
    d.log.info("finder.done", { customerId: id, taskId: ask.taskId, source: ask.source, picks: picks.length, likes: likes.length, searches: searches.length, skipped: skipped.length, pages, dropped, drops, stopped, cost: usage.cost ?? 0, ms: out.ms });
    return out;
  }
}

const day = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : "date unknown");

/** What the teammate reads: each person with their own words, then what it searched, and what to do next. */
export function foundText(f: PlayFound, ask: Pick<PlayAsk, "source" | "within">): string {
  const head =
    f.picks.length
      ? `${f.picks.length} ${f.picks.length === 1 ? "person" : "people"} for the play on ${ask.source}, found by code (${f.searches.length} searches, ${f.pages} pages read; each post below was read in full):`
      : `Nobody for the play on ${ask.source} this time (${f.searches.length} searches, ${f.pages} pages read).`;
  const picks = f.picks.map((p, i) =>
    [
      `${i + 1}. ${p.post.author ?? "someone"}, ${day(p.post.postedAt)}${p.post.replies !== null ? `, ${p.post.replies} replies` : ""} (${p.fit})`,
      `   ${p.post.url}`,
      `   Their words: "${p.post.text.replace(/\s+/g, " ").slice(0, 500)}"`,
      `   Quote: "${p.quote}"`,
      `   Why: ${p.why}`,
    ].join("\n"),
  );
  const tried = f.searches.map((s) => `"${s.query}": ${s.error ? `failed (${s.error})` : `${s.posts} posts, ${s.picks} picked`}`);
  const why = {
    enough: "",
    empty: "It stopped after searches in a row that turned up nobody new: there is no more searching in this run.",
    searched: "Every search it planned ran.",
    unreachable: "Their Chrome could not search the site (offline, its day's pages spent, or the site refused): no more searching in this run.",
  }[f.stopped];
  const likes = f.likes.map((l) => `- ${l.post.author ?? "someone"}: ${l.post.url}\n  Quote: "${l.quote}"`);
  return [
    head,
    ...picks,
    ...(likes.length ? ["", `Worth a like, seen in the search (outreach_draft kind like, this address and quote; no check needed; leave out any post of the customer's own):`, ...likes] : []),
    "",
    `Searched: ${tried.join("; ") || "nothing"}.${f.skipped.length ? ` Not run, since they found nobody before: ${f.skipped.map((q) => `"${q}"`).join(", ")}.` : ""}${f.dropped ? ` ${f.dropped} dropped once read.` : ""} ${why}`.trim(),
    f.picks.length
      ? "Now check each one before a first word: their profile (read_page their profile's address: its bio, site and recent posts), their site (read_site, pages 2) and what the post says, keep it with note_person, then connect (a like on their post, a follow when they fit well) and write only where it helps, with outreach_draft, quoting their words above. Skip anyone the check rules out, and say why in your report."
      : `${likes.length ? "Like those, then report" : "Report that"}, with what was searched; do not go looking another way.`,
  ].join("\n");
}
