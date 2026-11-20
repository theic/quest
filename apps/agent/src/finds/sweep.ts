import { SearchError, type Clock, type Customer, type CustomerId, type CustomerRepository, type EventSink, type FoundPost, type Logger, type MemoryRepository, type ModelUsage, type PostQuery, type SpendLog, type WebReach } from "@mq/core";
import type { ModelProvider } from "../agents/models.ts";
import type { Messenger } from "../conversation/messenger.ts";
import type { Errands } from "../lifecycle/errands.ts";
import type { TaskProgress } from "../tasks/task-board.ts";
import { BatchJudge, JUDGE_BATCH, type JudgedPost } from "./batch-judge.ts";
import type { FindLedger } from "./find-service.ts";
import { searchWords } from "./search-words.ts";

/**
 * The first sweep (the founder, 2026-10-23: "We have to provide a real value first, making the first use of it
 * unforgettable"). Once someone new has a brief and their Chrome, Quest reads the sites where their people ask, by
 * code, in about ten minutes: the search words from the brief in one call, every site's search at once in their Chrome
 * (Reddit and its communities, X, LinkedIn, YouTube), each at its own pace, and the public APIs (Hacker News, Bluesky);
 * the posts judged in batches on the volume seat as they come; the picks that were only a title read in full and
 * judged again, so nobody is quoted from a search result; the best saved as finds. One line in the chat says how far it
 * is, edited in place, words and numbers, and turns into what it came to. Then the first-day cards begin, with the
 * takes on the real posts it found. Once per customer (`mq.customers.swept_at`); a sweep their Chrome left halfway
 * starts over when it is back.
 */

/** The sources in their Chrome, in the order the line names them, then the public APIs. */
const CHROME = ["reddit", "x", "linkedin", "youtube"] as const;
const APIS = ["hackernews", "bluesky"] as const;
const NAMES: Readonly<Record<string, string>> = { reddit: "Reddit", x: "X", linkedin: "LinkedIn", youtube: "YouTube", hackernews: "Hacker News", bluesky: "Bluesky" };
const inChrome = (source: string): boolean => (CHROME as readonly string[]).includes(source.split(":")[0]!);
/** Where a search answers only those signed in, so one that worked shows they are (Reddit and YouTube search signed out too). */
const SIGNED_IN_ONLY: ReadonlySet<string> = new Set(["x", "linkedin"]);

export interface SweepSizes {
  /** Searches of each site from the search words (the call asks for this many). */
  readonly queries: number;
  /** Of those, searched again in each community the words name. */
  readonly communityQueries: number;
  /** Of those, searched on YouTube, whose results are videos more than asks. */
  readonly youtubeQueries: number;
  /** Posts kept of each search. */
  readonly perSearch: number;
  /** Picks that were only a title (a Reddit result), read in full before anyone is quoted. */
  readonly reads: number;
  /** Finds saved at most. */
  readonly finds: number;
  /** The chat line is redrawn at most this often. */
  readonly lineEveryMs: number;
}

// Reddit is the slowest site (8 to 15 s a page, 30 in ten minutes): 8 searches, 4 communities twice, and 12 threads
// read is 28 of its pages, about six minutes; the other sites are done well before.
export const SWEEP_SIZES: SweepSizes = { queries: 8, communityQueries: 2, youtubeQueries: 4, perSearch: 20, reads: 12, finds: 15, lineEveryMs: 4_000 };

/** When this share of its searches in their Chrome found it gone, the sweep waits for it rather than end half-read. */
const GONE_SHARE = 0.5;

export interface SweepDeps {
  readonly customers: CustomerRepository;
  readonly reach: WebReach;
  readonly finds: Pick<FindLedger, "save" | "known">;
  readonly memory: Pick<MemoryRepository, "add">;
  readonly models: ModelProvider;
  readonly spend?: SpendLog;
  readonly messenger: Pick<Messenger, "startLine" | "line">;
  /** Their Chrome is there to read in. */
  readonly online: (customerId: CustomerId) => boolean;
  /** Quest is switched off for them. */
  readonly off: (customerId: CustomerId) => boolean;
  readonly errands: Errands;
  readonly progress?: TaskProgress;
  readonly events: EventSink;
  readonly wakeManager: () => void;
  /** Once it ended: the first-day cards begin, the takes on what it found. */
  readonly after?: (customerId: CustomerId) => Promise<void>;
  readonly clock: Clock;
  readonly log: Logger;
}

/** What a sweep came to. */
export interface Swept {
  readonly pages: number;
  readonly posts: number;
  readonly saved: number;
  readonly strong: number;
  readonly ms: number;
  readonly sites: readonly string[];
  readonly signedIn: readonly string[];
  readonly signedOut: readonly string[];
  readonly cost: number;
}

const NO_USAGE: ModelUsage = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0 };

/** The line while it reads, and once it is done. */
export const sweepLine = {
  reading: (sites: string): string => `Reading ${sites}…`,
  counting: (sites: string, pages: number, posts: number, found: number): string => `Reading ${sites}… pages: ${pages}, posts: ${posts}, worth answering: ${found}`,
  found: (sites: string, minutes: number, pages: number, posts: number, found: number): string =>
    `Read ${sites} in ${minutes} min. Pages: ${pages}, posts: ${posts}, worth answering: ${found}. The best first:`,
  none: (sites: string, minutes: number, pages: number, posts: number): string =>
    `Read ${sites} in ${minutes} min. Pages: ${pages}, posts: ${posts}, and nobody there asked for this lately. I'll look in other places next.`,
  paused: "⏸ Your Chrome went quiet, so I stopped reading. I'll pick it up when it's back.",
  failed: "I couldn't finish reading the sites just now, so my team will look on its own.",
};

export class FirstSweep {
  readonly #d: SweepDeps;
  readonly #sizes: SweepSizes;

  constructor(deps: SweepDeps, sizes: Partial<SweepSizes> = {}) {
    this.#d = deps;
    this.#sizes = { ...SWEEP_SIZES, ...sizes };
  }

  /** Whether their first sweep is reading now. */
  running(customerId: CustomerId): boolean {
    return this.#d.errands.running(`sweep:${customerId}`);
  }

  /**
   * Starts their first sweep when it is due and can run: a brief, their Chrome there, Quest on, and no sweep yet.
   * Whether one started now.
   */
  async maybeStart(customerId: CustomerId): Promise<boolean> {
    const c = await this.#d.customers.get(customerId);
    if (c.sweptAt || !c.brief?.trim() || this.running(customerId)) return false;
    if (this.#d.off(customerId) || !this.#d.online(customerId)) return false;
    return this.#d.errands.run(`sweep:${customerId}`, (stopping) => this.#run(c, stopping));
  }

  async #run(c: Customer, stopping: AbortSignal): Promise<void> {
    const d = this.#d;
    const id = c.id;
    const runId = `sweep:${id}`;
    const started = d.clock.now().getTime();
    const sites = [...CHROME, ...APIS].map((s) => NAMES[s]!).join(", ");
    d.log.info("sweep.started", { customerId: id });
    let ref = await d.messenger.startLine(id, sweepLine.reading(sites));
    try {
      await this.#sweep(c, stopping, sites, started, () => ref, (r) => (ref = r));
    } catch (e) {
      // Something no retry fixes soon (no model answered): they are past it, and the team looks the usual way.
      d.log.error("sweep.failed", { customerId: id, error: e instanceof Error ? e.message : String(e) });
      d.progress?.stopped(runId, false);
      await d.messenger.line(id, ref, sweepLine.failed, true);
      await this.#after(id);
      await d.customers.update(id, { sweptAt: d.clock.now() });
      await d.events.push(id, { kind: "system", topic: "first_sweep", text: "Their first sweep failed before it saved anything. Start your team now, as your first steps say; write nothing about it." });
      d.wakeManager();
    }
  }

  /** The first take, after the sweep: never a reason to call the sweep failed, or to run it again. */
  async #after(id: CustomerId): Promise<void> {
    await this.#d.after?.(id).catch((e: unknown) => this.#d.log.warn("sweep.after_failed", { customerId: id, error: e instanceof Error ? e.message : String(e) }));
  }

  async #sweep(c: Customer, stopping: AbortSignal, sites: string, started: number, current: () => string | null, keep: (ref: string | null) => void): Promise<void> {
    const d = this.#d;
    const size = this.#sizes;
    const id = c.id;
    const runId = `sweep:${id}`;
    let ref = current();
    let usage = NO_USAGE;
    const spent = (u: ModelUsage | null) => {
      if (u) usage = { ...usage, input: usage.input + u.input, cached: usage.cached + u.cached, output: usage.output + u.output, cost: (usage.cost ?? 0) + (u.cost ?? 0) };
    };

    // The line: redrawn when the numbers moved, at most every few seconds, never after its last words.
    const n = { pages: 0, posts: 0, found: 0 };
    let drawn = "";
    let timer: NodeJS.Timeout | null = null;
    let settled = false;
    const draw = async () => {
      timer = null;
      const text = sweepLine.counting(sites, n.pages, n.posts, n.found);
      if (settled || text === drawn) return;
      drawn = text;
      ref = await d.messenger.line(id, ref, text);
      keep(ref);
    };
    const moved = () => {
      if (!timer && !settled) timer = setTimeout(() => void draw(), size.lineEveryMs);
    };
    const settle = async (text: string) => {
      settled = true;
      if (timer) clearTimeout(timer);
      ref = await d.messenger.line(id, ref, text, true);
      keep(ref);
    };

    // 1. What to search for, once.
    const words = await searchWords(d.models, { customerId: id, brief: c.brief! }, "volume", size.queries);
    spent(words.usage);
    if (!words.queries.length) throw new Error("no search words came back for their brief");
    if (words.usage) d.spend?.record({ customerId: id, taskId: null, agent: "sweep", model: null, ms: d.clock.now().getTime() - started, usage: words.usage });
    const plan: PostQuery[] = [];
    for (const [i, query] of words.queries.entries()) {
      for (const source of ["reddit", "x", "linkedin", ...APIS]) plan.push({ source, query, within: "month", limit: size.perSearch });
      if (i < size.youtubeQueries) plan.push({ source: "youtube", query, within: "month", limit: size.perSearch });
    }
    for (const site of words.communities) for (const query of words.queries.slice(0, size.communityQueries)) plan.push({ source: "reddit", query, site, within: "month", limit: size.perSearch });
    d.progress?.started({ id: runId, customerId: id, agent: "sweep", title: { text: "Reading the sites where your people ask" } }, plan.length + size.reads + 2);

    // 2. Every search at once: the broker keeps each site at its own pace. Posts are judged a batch at a time as they come.
    const { reader, posts: search } = d.reach.forCustomer(id);
    const judge = new BatchJudge({ models: d.models, ...(d.spend ? { spend: d.spend } : {}), log: d.log, now: () => d.clock.now() });
    const seen = new Set<string>();
    const oldest = d.clock.now().getTime() - 30 * 86_400_000;
    let pending: FoundPost[] = [];
    const judged: JudgedPost[] = [];
    const judging: Promise<void>[] = [];
    const signedIn = new Set<string>();
    const signedOut = new Set<string>();
    let gone = 0;
    // What each source gave, for the log: posts found, searches that failed, finds saved.
    const bySource: Record<string, { posts: number; failed: number; saved: number }> = {};
    const tally = (source: string) => (bySource[source.split(":")[0]!] ??= { posts: 0, failed: 0, saved: 0 });
    const judgeNow = (posts: FoundPost[]) => {
      judging.push(
        (async () => {
          const known = await d.finds.known(id, posts.map((p) => p.url));
          const fresh = posts.filter((p) => !known.has(p.url));
          if (!fresh.length) return;
          const out = await judge.judge({ customerId: id, brief: c.brief!, posts: fresh });
          spent(out.usage);
          judged.push(...out.judged);
          n.found = judged.length;
          moved();
        })().catch((e: unknown) => d.log.warn("sweep.judge_failed", { customerId: id, error: e instanceof Error ? e.message : String(e) })),
      );
    };
    await Promise.all(
      plan.map(async (q) => {
        if (stopping.aborted) return;
        try {
          d.progress?.tool(runId, "search_posts", q);
          const found = await search.search(q);
          tally(q.source).posts += found.length;
          if (inChrome(q.source)) n.pages++;
          if (SIGNED_IN_ONLY.has(q.source)) signedIn.add(q.source);
          for (const p of found) {
            // Only what is fresh enough to answer: a source can give older (live, 2026-10-31: an Ask HN of 7 months ago).
            if (seen.has(p.url) || (p.postedAt && p.postedAt.getTime() < oldest)) continue;
            seen.add(p.url);
            pending.push(p);
          }
          n.posts = seen.size;
          if (pending.length >= JUDGE_BATCH) {
            judgeNow(pending.slice(0, JUDGE_BATCH));
            pending = pending.slice(JUDGE_BATCH);
          }
        } catch (e) {
          const reason = e instanceof SearchError ? e.reason : "error";
          tally(q.source).failed++;
          if (reason === "offline") gone++;
          else if (inChrome(q.source)) n.pages++;
          if (e instanceof Error && /not signed in/i.test(e.message)) signedOut.add(q.source);
          d.log.info("sweep.search_failed", { customerId: id, source: q.source, reason });
        } finally {
          d.progress?.step(runId);
          moved();
        }
      }),
    );
    const searchedInChrome = plan.filter((q) => inChrome(q.source)).length;
    if (stopping.aborted || (searchedInChrome && gone / searchedInChrome >= GONE_SHARE)) {
      // Their Chrome went away (or the agent is stopping): it starts over when their Chrome is back.
      await Promise.all(judging);
      await settle(sweepLine.paused);
      d.progress?.stopped(runId, false);
      d.log.info("sweep.paused", { customerId: id, pages: n.pages, gone, stopping: stopping.aborted });
      return;
    }
    if (pending.length) judgeNow(pending);
    await Promise.all(judging);

    // 3. A pick that was only a title is read in full and judged again on its words: nobody is quoted from a search
    // result. Reddit's results are titles only (FACTS.md); a Reddit pick left unread has no thread to answer under.
    const order = (j: JudgedPost) => (j.fit === "strong" ? 0 : 1);
    judged.sort((a, b) => order(a) - order(b) || (b.post.postedAt?.getTime() ?? 0) - (a.post.postedAt?.getTime() ?? 0));
    const titles = judged.filter((j) => j.post.preview && !j.post.source.startsWith("youtube"));
    const toRead = titles.slice(0, size.reads);
    const refs = new Map<string, string>();
    const read = (
      await Promise.all(
        toRead.map(async (j): Promise<FoundPost | null> => {
          if (stopping.aborted) return null;
          d.progress?.tool(runId, "read_page", { url: j.post.url });
          try {
            const page = await reader.readPage(j.post.url);
            n.pages++;
            if (page.post?.ref) refs.set(j.post.url, page.post.ref);
            return { ...j.post, author: page.post?.author ?? j.post.author, postedAt: page.post?.postedAt ?? j.post.postedAt, text: page.text.slice(0, 3_000), preview: false };
          } catch (e) {
            d.log.info("sweep.read_failed", { customerId: id, reason: e instanceof Error && "reason" in e ? String(e.reason) : "error" });
            return null;
          } finally {
            d.progress?.step(runId);
            moved();
          }
        }),
      )
    ).filter((p): p is FoundPost => p !== null);
    const again = read.length ? await judge.judge({ customerId: id, brief: c.brief!, posts: read }) : null;
    if (again) spent(again.usage);
    const kept = [...judged.filter((j) => !titles.includes(j)), ...(again?.judged ?? [])];
    kept.sort((a, b) => order(a) - order(b) || (b.post.postedAt?.getTime() ?? 0) - (a.post.postedAt?.getTime() ?? 0));
    n.found = kept.length;

    // 4. The best are saved as finds: the takes go out on them, and the rest come as cards.
    let saved = 0;
    let strong = 0;
    for (const j of kept.slice(0, size.finds)) {
      const find = await d.finds.save({
        customerId: id,
        taskId: null,
        source: j.post.source,
        url: j.post.url,
        author: j.post.author,
        title: j.post.title,
        quote: j.quote,
        postedAt: j.post.postedAt,
        why: j.why,
        reply: j.reply || "Answer what they asked, helpfully, in two to four plain sentences.",
        strength: j.fit,
        replyTo: refs.get(j.post.url) ?? null,
      });
      if (!find) continue;
      saved++;
      tally(j.post.source).saved++;
      if (j.fit === "strong") strong++;
    }
    const ms = d.clock.now().getTime() - started;
    const minutes = Math.max(1, Math.round(ms / 60_000));
    await settle(saved ? sweepLine.found(sites, minutes, n.pages, n.posts, saved) : sweepLine.none(sites, minutes, n.pages, n.posts));
    d.progress?.stopped(runId, true);
    // The first take goes out right under the line, then they are past their sweep: until it is out, nothing else
    // sends a first-day card, so it is the first they see. A take that does not go out now goes after a later turn.
    await this.#after(id);
    await d.customers.update(id, { sweptAt: d.clock.now() });
    const out: Swept = {
      pages: n.pages,
      posts: n.posts,
      saved,
      strong,
      ms,
      sites: [...CHROME, ...APIS].map((s) => NAMES[s]!),
      signedIn: [...signedIn].map((s) => NAMES[s] ?? s),
      signedOut: [...signedOut].map((s) => NAMES[s] ?? s),
      cost: usage.cost ?? 0,
    };
    d.log.info("sweep.done", { customerId: id, pages: out.pages, posts: out.posts, saved, strong, ms, cost: out.cost, signedIn: out.signedIn, signedOut: out.signedOut, sources: bySource });
    if (out.signedIn.length || out.signedOut.length) {
      const day = d.clock.now().toISOString().slice(0, 10);
      const text = [
        out.signedIn.length ? `Their Chrome is signed in to ${out.signedIn.join(", ")}` : "",
        out.signedOut.length ? `${out.signedIn.length ? "; not to" : "Their Chrome is not signed in to"} ${out.signedOut.join(", ")}` : "",
      ].join("");
      await d.memory.add(id, { kind: "fact", text: `${text} (the first sweep, ${day}).`, source: "system" });
    }
    await d.events.push(id, { kind: "system", topic: "first_sweep", text: sweptNote(out) });
    d.wakeManager();
  }
}

/** What the manager hears once the sweep ended. */
export function sweptNote(s: Swept): string {
  return [
    `Their first sweep ended: by code, in their Chrome and the public APIs, it read ${s.pages} pages on ${s.sites.join(", ")} in ${Math.max(1, Math.round(s.ms / 60_000))} min, ${s.posts} posts, and saved ${s.saved} finds (${s.strong} strong). Their chat line already says so.`,
    s.signedIn.length || s.signedOut.length ? `Their Chrome is signed in to ${s.signedIn.join(", ") || "none of them"}${s.signedOut.length ? `, not to ${s.signedOut.join(", ")}` : ""}.` : "",
    s.saved
      ? "The takes now go out on the best of these finds, one card at a time: the writer answers each real post as them, they tune it, and \"That's me\" offers that find's card to post. When the takes end you are told, and then you ask the one thing the work needs and they did not say, if any. The rest of the finds wait for after: show none of them, and write nothing about the sweep."
      : "Nobody there asked lately: the takes go out on people Quest pictures. Write nothing about the sweep.",
    "Start your team now, as your first steps say (the explorer for their places, the scout on other words, outreach for their profile checks): their Chrome holds the work while they answer the cards, so it never gets in their way.",
  ]
    .filter(Boolean)
    .join(" ");
}
