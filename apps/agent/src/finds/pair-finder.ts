import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { CustomerId, Draft, FoundPost, Logger, PostSearch, SpendLog, TaskId } from "@mq/core";
import type { ModelProvider, ModelRole } from "../agents/models.ts";
import { usageOf } from "../agents/usage.ts";
import { saysUnder18 } from "../drafts/adults.ts";
import { replySpot } from "../drafts/one-reply.ts";
import { knownKey, type KnownAbout, type KnownPeople } from "../infra/pg-known.ts";
import { dateOrNull, getJson, plainText, type Fetch } from "../sources/http.ts";

/**
 * Two people who need each other, found by matching two lists (the founder, 2026-11-12: "there are hundreds of launches
 * per day and all people are looking to connect with their customers; and customers are there, it is just hard to find").
 * Searching for one builder's customers found nobody twice (customers_for: 20 searches, no pick). Measured by hand the
 * same day: a week of Hacker News is 190 asks and 600 launches, and read side by side they hold several exact pairs
 * ("How do you keep secrets out of your AI agents' context?" and "Show HN: Cloakroom, keeps secrets away from agents",
 * posted the same day, neither answered by the other). So: collect the people asking and the people launching, each
 * once, and let one cheap call match the lists.
 */

/** One side of a pair: someone asking, or someone who launched. */
export interface PairPost extends FoundPost {
  readonly side: "ask" | "launch";
  /** False for someone who only shows the need: the maker is told of them, they are not written to. */
  readonly tell?: boolean;
}

export interface Pair {
  readonly ask: PairPost;
  readonly launch: PairPost;
  /** Why the launch is what the ask wants, in a line. */
  readonly why: string;
}

export interface PairsFound {
  readonly pairs: readonly Pair[];
  readonly asks: number;
  readonly launches: number;
  /** The sources that could not be searched now. */
  readonly failed: readonly string[];
  /** What a check already found about a post's author, by the post's address (the shared cache). */
  readonly known?: ReadonlyMap<string, KnownAbout>;
}

/** A kind of person several people are looking for now: users several launches want, or a maker several asks want. */
export interface Wanted {
  readonly side: "users" | "makers";
  /** Who, in a few plain words: "people learning a language". */
  readonly who: string;
  /** What such a person types when they want it: "learning spanish app". */
  readonly search: string;
  /** A post that asks them to speak up. */
  readonly question: string;
  /** The posts that look for them. */
  readonly posts: readonly PairPost[];
}

/** What people type when they want a thing, and when they made one: run on each source that searches by words. */
const ASK_WORDS = [
  "is there an app that", "need a telegram bot", "looking for a tool", "is there a telegram bot", "anyone know a tool", "can anyone recommend",
  "alternative to", "looking for a bot", "what do you use for", "wish there was an app", "recommend an app", "any app for",
  "does anyone know a good", "tired of using", "need help finding", "who can build",
  "is there a tool that", "is there a website that", "any recommendations for an app", "looking for an app", "does an app exist", "someone should build",
  "i would pay for", "why is there no app", "what app do you use", "any good apps for", "need an app that", "looking for software",
  "anyone built", "is there a service that",
];
const LAUNCH_WORDS = ["just launched", "built a telegram bot", "I built", "telegram mini app", "launched my", "my first app", "looking for beta testers", "first users", "we just shipped", "side project is live",
  "my new app", "my game is out", "out now on steam", "now on the app store", "just released my", "launched on product hunt", "open beta", "early access is live", "made a little app", "my first game", "finally released", "free to try"];
/**
 * The sources asked by words, where the run has them, and how many searches each takes a run: a site's pace is the
 * limit (LinkedIn lets an account read about 12 pages in ten minutes), so each run asks a few and the next run asks the
 * next few (`turn`); what they found stays in the shared cache, so the lists grow from run to run. Bluesky's search
 * matches any of the words (live, 2026-11-12: its posts took 30 of 30 places), so it is asked for the exact phrase.
 * Reddit is read here and never written to. Hacker News comes whole, below.
 */
const WORD_SOURCES: Readonly<Record<string, { readonly asks: number; readonly launches: number; readonly needs: number }>> = {
  x: { asks: 4, launches: 2, needs: 4 },
  reddit: { asks: 4, launches: 2, needs: 3 },
  linkedin: { asks: 2, launches: 1, needs: 1 },
  // Bluesky answers from its own API, with no browser and no pace to keep: every phrase, every run.
  bluesky: { asks: 30, launches: 22, needs: 8 },
};
/** Telegram's public channels and groups, through a web search kept to t.me. */
const TELEGRAM_ASKS = ['site:t.me "looking for a bot"', 'site:t.me "is there a bot"', 'site:t.me "посоветуйте бота"', 'site:t.me "ищу сервис"'];
/** Mastodon is read by hashtag. */
const TAGS = { ask: ["askfedi"], launch: ["buildinpublic", "indiedev", "indiegame", "indieapp", "newrelease", "iosdev", "androiddev"] } as const;
/** Where a person cannot be written to where they posted: Hacker News bans written-for-them comments, Reddit is read only. */
const CLOSED = new Set(["hackernews", "reddit"]);
const siteOf = (p: Pick<FoundPost, "source">): string => p.source.split(":")[0]!;
/** Whether someone can be answered where they posted. */
export const answeredThere = (p: Pick<FoundPost, "source">): boolean => !CLOSED.has(siteOf(p));
/** The next `n` of a list, a different stretch each turn. */
const stretch = <T,>(list: readonly T[], n: number, turn: number): T[] => Array.from({ length: Math.min(n, list.length) }, (_, i) => list[(turn * n + i) % list.length]!);

/** A post that wants something, by its own words: the rest of an Ask list is talk. */
const WANTS = /\b(is there|are there|looking for|recommend|alternative|what (do|are) you us|what(?:'s| is) the best|how do you (keep|manage|track|handle|find|get|deal|test|monitor|share)|any(one)? (know|using|use|built|tried|good)|need (a|an|some|help)|wish (there|i)|tool for|app for|bot (for|that)|struggling|can't find|cannot find)\b/i;

const PER_SIDE = { ask: 180, launch: 400 } as const;
/** The asks are matched this many at a time, each call against every launch, side by side. */
const ASKS_A_CALL = 60;
const MAX_PAIRS = 12;
/** One launch is given to at most this many people asking: three people to send its maker. */
const ASKS_A_LAUNCH = 3;
/** How many pairs a run is handed. */
const PAIRS_A_RUN = 8;
/** How often the searches move on to their next stretch. */
const TURN_MS = 30 * 60_000;
/** How long a run's searches may take in all. */
const SEARCH_MS = 150_000;

export const PAIRS_SYSTEM = `You match people who need each other. ASKS are posts by people who want something: a tool, an app, a bot, a service, a way out of a problem. LAUNCHES are posts by people who just made something and want its first users. Find the pairs where the launch is exactly what the ask wants, so that each would be glad to hear of the other today.
- Exact, not near: the launch does the very thing the ask describes, for the kind of person asking (their platform, their scale, their constraint when they give one). The same topic is not a match.
- Never a pair by one author. Never an ask whose author plainly builds or sells such a thing themselves. Never a launch that is a big company's product.
- Prefer a pair where either side lives in Telegram (a bot, a mini app, a channel, a group, a t.me link).
- Each post says where it is, in brackets. People on x, linkedin, bluesky, threads, mastodon and telegram can be answered where they posted; people on hackernews and reddit cannot. So give first every pair with both posts off hackernews and reddit, then pairs with one, and a pair of two such posts only when nothing else matches.
- One launch may answer several asks, each its own pair; an ask is in one pair, with the launch that fits it best.
- At most ${MAX_PAIRS} pairs, best first; none is a fine answer.
Return only JSON: {"pairs":[{"ask":<number>,"launch":<number>,"why":"<one line: what they ask for, and what the launch does>"}]}`;

/** How many of a look's need searches go to X: its pages come at a person's pace, shared with the runs. */
const NEEDS_ON_X = 20;
/** And on LinkedIn, whose pace is 12 pages in ten minutes. */
const NEEDS_ON_LINKEDIN = 6;
/** How many launches a run looks for users for. */
const NEED_LAUNCHES = 90;
/** How long the makers' side may take in all: three calls and a few dozen searches. */
const NEEDS_MS = 270_000;
// One search of the makers' side waits this long: a site slow in their Chrome (X behind a send) answers nothing this time.
// Live, 2026-11-14: those searches made the side take 7 to 50 minutes, the look stopped listening at 4.5, and for five
// hours every pair it found (12 people for one launch) was thrown away: no opener was written.
const NEED_SEARCH_MS = 25_000;
/** A launch is looked for users for again no sooner than this. */
const NEEDS_AGAIN_MS = 6 * 3_600_000;

/** The languages besides English that Quest speaks (@mq/i18n), for the needs' searches. */
const OTHER_TONGUES = ["Portuguese", "Spanish", "French", "German", "Russian", "Ukrainian", "Hindi", "Chinese", "Arabic"] as const;

export const NEEDS_SYSTEM = `LAUNCHES are posts by people who just made something and want its first users. For each one whose users are ordinary people or small teams who talk about that need in public posts, write what such a person posts, before they know the thing exists: three short phrases, two to four everyday words each, lower case, as typed in a complaint, a wish, a question, or by someone who simply says they do or love the thing ("tired of dating apps", "planning a road trip", "can't keep track of receipts", "love nonogram puzzles"). Each phrase is searched as an exact phrase, so use the commonest wording. No product names, no category words like "app" or "tool", nothing only its maker would say.
At least two of the three are how someone asks or wishes for it out loud ("any app for", "looking for a way to", "how do you keep track of", "wish there was"): a person who asks is the one a stranger may answer.
Take first the launches by someone with something to sell (a product with a price, a plan, a trial, a waitlist, customers in mind: an app, a tool, a service). Leave out a launch whose users would never post about the need (developer infrastructure, enterprise software), a hobby project with nobody to sell to (a jam game, a mod, fan art, a toy repo, a school project), one too vague to tell what it does, a post that is not a launch at all, and big companies. At most 40 launches, the clearest first.
Return only JSON: {"needs":[{"launch":<number>,"who":"<who needs it, a few words>","phrases":["...","...","..."]}]}`;

export const NEED_JUDGE_SYSTEM = `You match a person who has a need with someone who just made the thing for it. Each block is a LAUNCH (L1, L2, ...) with whom it is for, and POSTS (P1, P2, ..., numbered across all blocks) by other people, found by searching for that need.
Pick the posts whose author plainly is the person the launch is for, in their own words: they have the problem now, or they do or love the very thing it is made for (someone who says they love nonogram puzzles, for a new nonogram game). Hearing "someone just made this" would be welcome to them today, and the maker would be glad to meet them. Not a company or a brand, not someone who builds or sells such a thing, not a joke, a quote, a news item or an ad, not a post where the words mean something else, not anyone who says they are under 18.
Up to 3 posts for a launch, only from its own block, the ones who ask for such a thing first; none is a fine and common answer.
The launch must be a thing anyone can use from anywhere (an app, a game, a site, a tool, a book): skip a block whose launch is a local event, an opinion, a request for money (a fundraiser, a crowdfunding page) or not a product at all. Never a post whose author is in trouble or grieving, and never one where pointing at their words would embarrass them.
For each pick, asked: true when the person asks or wishes out loud for such a thing in the post (they would thank a stranger for the pointer), false when they only show the need or the liking.
Return only JSON: {"pairs":[{"launch":<the L number>,"post":<the P number>,"asked":<true or false>,"why":"<one line: what they said, and what the launch does>"}]}`;

/** A match's reason names both posts: a number that pointed at another line gives a reason that fits neither (live, 2026-11-12). */
const saysBoth = (why: string, a: FoundPost, l: FoundPost): boolean => {
  const big = (s: string): Set<string> => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{5,}/gu) ?? []);
  const w = big(why);
  const shares = (p: FoundPost): boolean => [...big(`${p.title ?? ""} ${p.text}`)].some((x) => w.has(x));
  return shares(a) && shares(l);
};

export const WANTED_SYSTEM =`You read what people made and what people ask for this week, and name who is wanted. LAUNCHES are posts by people who just made something and want its first users. ASKS are posts by people who want something.
Name the kinds of people that several posts are looking for, two or more posts each, the more the better:
- side "users": people that several LAUNCHES are for ("people learning a language", for three language learning apps). posts: those launches' numbers.
- side "makers": someone who makes what several ASKS want ("someone who builds Telegram bots for shops"). posts: those asks' numbers.
For each: who (a few plain words), search (two to four words such a person types in a post of their own when they want it, lower case, no brand names: "learning spanish app"), question (a short post that asks those people to speak up, as someone who knows a few builders working on it would ask friends: "Anyone learning a language right now? I know a few people who just built apps for it."; no hashtags, no emoji, no product names).
Prefer what ordinary people need over developer tooling, and anything that lives in Telegram. At most 8, the most wanted first; none is a fine answer.
Return only JSON: {"wanted":[{"side":"users","who":"...","search":"...","question":"...","posts":[<number>,...]}]}`;

interface Hit {
  objectID: string;
  created_at?: string;
  author?: string;
  title?: string | null;
  story_text?: string | null;
  url?: string | null;
  num_comments?: number | null;
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (p && typeof p === "object" && "text" in p && typeof p.text === "string" ? p.text : "")).join("") : "";

export function parsePairs(raw: string): { ask: number; launch: number; why: string }[] {
  try {
    const v = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { pairs?: unknown };
    if (!Array.isArray(v.pairs)) return [];
    return v.pairs.flatMap((p: unknown) => {
      const o = p as { ask?: unknown; launch?: unknown; why?: unknown };
      return typeof o.ask === "number" && typeof o.launch === "number" ? [{ ask: o.ask, launch: o.launch, why: typeof o.why === "string" ? o.why.slice(0, 300) : "" }] : [];
    });
  } catch {
    return [];
  }
}

const line = (p: FoundPost, i: number, chars: number): string =>
  `${i + 1}. [${p.source}] ${p.author ?? "someone"}: ${[p.title, p.text].filter(Boolean).join(" | ").replace(/\s+/g, " ").slice(0, chars)}`;

export class PairFinder {
  readonly #models: ModelProvider;
  readonly #spend: SpendLog | undefined;
  readonly #log: Logger;
  readonly #fetch: Fetch;
  readonly #seat: ModelRole;
  readonly #drafts: { recent(customerId: CustomerId, limit: number): Promise<Draft[]> } | undefined;
  readonly #known: KnownPeople | undefined;
  /** When each launch was last looked for users for. */
  readonly #planned = new Map<string, number>();

  constructor(deps: { models: ModelProvider; spend?: SpendLog; log: Logger; fetch?: Fetch; seat?: ModelRole; drafts?: { recent(customerId: CustomerId, limit: number): Promise<Draft[]> }; known?: KnownPeople }) {
    this.#drafts = deps.drafts;
    this.#known = deps.known;
    this.#models = deps.models;
    this.#spend = deps.spend;
    this.#log = deps.log;
    this.#fetch = deps.fetch ?? fetch;
    this.#seat = deps.seat ?? "volume";
  }

  /** A week of Hacker News' Ask and Show posts, newest first: no browser, no key. */
  async #hackerNews(tag: "ask_hn" | "show_hn", side: PairPost["side"], days: number, pages: number): Promise<PairPost[]> {
    const since = Math.floor(Date.now() / 1000) - days * 86_400;
    const out: PairPost[] = [];
    for (let page = 0; page < pages; page++) {
      const body = await getJson<{ hits?: Hit[]; nbPages?: number }>(
        this.#fetch,
        "Hacker News",
        `https://hn.algolia.com/api/v1/search_by_date?tags=${tag}&hitsPerPage=100&page=${page}&numericFilters=${encodeURIComponent(`created_at_i>${since}`)}`,
      );
      for (const h of body.hits ?? []) {
        out.push({ side, source: "hackernews", url: `https://news.ycombinator.com/item?id=${h.objectID}`, author: h.author ?? null, title: h.title ?? null, text: plainText(h.story_text), postedAt: dateOrNull(h.created_at), replies: h.num_comments ?? null });
      }
      if (page + 1 >= (body.nbPages ?? 0)) break;
    }
    return out;
  }

  /** Hacker News' week and what the shared cache holds from earlier runs, whoever's: no browser, a second or two. */
  async #standing(days: number, add: (name: string, get: () => Promise<PairPost[]>) => Promise<void>): Promise<void> {
    await Promise.all([
      add("hackernews", () => this.#hackerNews("ask_hn", "ask", days, 3)),
      add("hackernews", () => this.#hackerNews("show_hn", "launch", days, 4)),
      add("cache", async () => (await this.#known?.recent(days, 600)) ?? []),
    ]);
  }

  /**
   * The kinds of people several posts are looking for now (the founder, 2026-11-12: "if there are three new language
   * learning apps, post a question to find people learning a language rn (and the other way around)"): one call over the
   * launches and the asks. Each is a search for the other side, and a post of the customer's own that finds them.
   */
  async #wanted(customerId: CustomerId, taskId: TaskId | null, pool: readonly PairPost[]): Promise<Wanted[]> {
    const started = Date.now();
    const launches = pool.filter((p) => p.side === "launch").slice(0, 220);
    const asks = pool.filter((p) => p.side === "ask" && WANTS.test(`${p.title ?? ""} ${p.text}`)).slice(0, 60);
    if (launches.length < 6) return [];
    try {
      const reply = await this.#models.modelFor(this.#seat, { customerId }).invoke([
        new SystemMessage(WANTED_SYSTEM),
        new HumanMessage(["LAUNCHES", ...launches.map((p, i) => line(p, i, 140)), "", "ASKS", ...asks.map((p, i) => line(p, i, 200))].join("\n")),
      ]);
      const usage = usageOf(reply);
      if (usage) this.#spend?.record({ customerId, taskId, agent: "judge", model: (reply as { response_metadata?: { model_name?: string } }).response_metadata?.model_name ?? null, ms: Date.now() - started, usage });
      const raw = textOf(reply.content);
      const v = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { wanted?: unknown };
      const out = (Array.isArray(v.wanted) ? v.wanted : []).flatMap((w: unknown): Wanted[] => {
        const o = w as { side?: unknown; who?: unknown; search?: unknown; question?: unknown; posts?: unknown };
        if (typeof o.who !== "string" || typeof o.search !== "string" || typeof o.question !== "string") return [];
        const side = o.side === "makers" ? "makers" : "users";
        const from = side === "users" ? launches : asks;
        const posts = (Array.isArray(o.posts) ? o.posts : []).flatMap((n) => (typeof n === "number" && from[n - 1] ? [from[n - 1]!] : []));
        return posts.length >= 2 ? [{ side, who: o.who.slice(0, 120), search: o.search.slice(0, 60), question: o.question.slice(0, 280), posts: posts.slice(0, 6) }] : [];
      });
      this.#log.info("pairs.wanted", { customerId, taskId, wanted: out.map((w) => `${w.side}: ${w.who} (${w.posts.length})`), ms: Date.now() - started });
      return out.slice(0, 8);
    } catch (e) {
      this.#log.warn("pairs.wanted_failed", { customerId, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      return [];
    }
  }

  /** Who is wanted now, from Hacker News' week and the shared cache alone: for a post of the customer's own. */
  async wanted(ask: { customerId: CustomerId; taskId?: TaskId | null; days?: number }): Promise<Wanted[]> {
    const pool: PairPost[] = [];
    await this.#standing(ask.days ?? 7, async (_name, get) => void pool.push(...(await get().catch(() => []))));
    const seen = new Set<string>();
    return this.#wanted(ask.customerId, ask.taskId ?? null, pool.filter((p) => !seen.has(p.url) && seen.add(p.url)));
  }

  /**
   * From the makers' side (2026-11-12: matching 122 asks against 400 launches gave 3 pairs, since few people ask for a
   * tool in so many words, while a launch's users say the need every day). For the freshest launches, one call writes
   * what a first user would have posted before knowing the thing exists; each phrase is searched; a second call keeps,
   * for each launch, up to three people who plainly have that need now.
   */
  async #needs(customerId: CustomerId, taskId: TaskId | null, pool: readonly PairPost[], search: (query: string, launchOn: string) => Promise<FoundPost[]>): Promise<Pair[]> {
    const started = Date.now();
    const full = (await this.#known?.inPairs(14).catch(() => undefined)) ?? new Set<string>();
    const seen = new Set<string>();
    // A launch looked at lately waits its turn: each run goes on to the next ones (in memory).
    const lately = started - NEEDS_AGAIN_MS;
    // Makers who plainly live in Telegram first (the founder, 2026-11-14: "We require people with telegram installed"):
    // the product is a Telegram bot, so only they can become users. The rest follow, in the order they came.
    const inTelegram = (p: PairPost): number => (/\bt\.me\/|telegram|\btg\b|mini ?app\b/i.test(`${p.title ?? ""} ${p.text}`) ? 0 : 1);
    const fresh = pool
      .filter((p) => p.side === "launch" && p.author && !p.url.includes("recent-activity") && !seen.has(p.url) && seen.add(p.url) && !full.has(knownKey(p) ?? "") && (this.#planned.get(p.url) ?? 0) < lately)
      .map((p, i) => ({ p, i }))
      .filter((x) => !hobby(x.p))
      // Whoever has something to sell first (the founder, 2026-11-18: "Focus on ICP, not how big the account is").
      .sort((a, b) => Number(sells(b.p)) - Number(sells(a.p)) || inTelegram(a.p) - inTelegram(b.p) || a.i - b.i)
      .map((x) => x.p);
    // Mostly makers who can be answered where they posted, and a few from Hacker News for a run to reach.
    const launches = [...fresh.filter((p) => !CLOSED.has(siteOf(p))).slice(0, NEED_LAUNCHES - 10), ...fresh.filter((p) => CLOSED.has(siteOf(p))).slice(0, 10)];
    if (launches.length < 4) return [];
    for (const l of launches) this.#planned.set(l.url, started);
    return this.#needsFor(customerId, taskId, launches, search, ASKS_A_LAUNCH, started);
  }

  /**
   * More people for one launch, asked when its maker said yes (the founder, 2026-11-17: "if person agrees, let Quest do
   * match with multiple people at once"): the same two calls and searches as a look's, for this launch alone, keeping up
   * to `cap` people.
   */
  async moreFor(customerId: CustomerId, launch: FoundPost, posts: PostSearch, cap: number): Promise<Pair[]> {
    // Every phrase on another site in turn, so a page lists people from several (the founder, 2026-11-20: "from
    // different sites"); it was Bluesky and X only.
    const offered = new Set(posts.sources().map((s) => s.name));
    const sites = ["bluesky", "x", "reddit", "linkedin", "hackernews", "threads"].filter((s) => offered.has(s));
    if (!sites.length) return [];
    let n = 0;
    const found = await this.#needsFor(customerId, null, [{ ...launch, side: "launch" }], (query) => {
      const source = sites[n++ % sites.length]!;
      return posts.search({ source, query: source === "bluesky" || source === "x" ? `"${query}"` : query, within: "week", limit: 25 });
    }, cap, Date.now());
    await this.#known?.saw(found.map((f) => f.ask)).catch(() => undefined);
    return found;
  }

  async #needsFor(customerId: CustomerId, taskId: TaskId | null, launches: readonly PairPost[], search: (query: string, launchOn: string) => Promise<FoundPost[]>, perLaunch: number, started: number): Promise<Pair[]> {
    // One launch whose maker said yes gets more phrases, more posts read and more people kept.
    const wide = perLaunch > ASKS_A_LAUNCH;
    const call = async (system: string, human: string): Promise<string> => {
      const at = Date.now();
      const reply = await this.#models.modelFor(this.#seat, { customerId }).invoke([new SystemMessage(system), new HumanMessage(human)]);
      const usage = usageOf(reply);
      if (usage) this.#spend?.record({ customerId, taskId, agent: "judge", model: (reply as { response_metadata?: { model_name?: string } }).response_metadata?.model_name ?? null, ms: Date.now() - at, usage });
      const raw = textOf(reply.content);
      return raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    };
    try {
      // Half the looks search in another language Quest speaks (the founder, 2026-11-14: "Use other languages more, from
      // the 10 we do support"): what launched is for people everywhere, and they say their need in their own words.
      const tongue = Math.random() < 0.5 ? OTHER_TONGUES[Math.floor(Math.random() * OTHER_TONGUES.length)] : null;
      const asks = tongue ? `\nWrite every phrase in ${tongue}, as people who speak it type them, not translated word for word.` : "";
      const planned = JSON.parse(await call(NEEDS_SYSTEM, ["LAUNCHES", ...launches.map((p, i) => line(p, i, 260))].join("\n") + asks + (wide ? "\nWrite six phrases for this launch, each a different way such a person says it." : ""))) as { needs?: { launch?: unknown; who?: unknown; phrases?: unknown }[] };
      const plans = (Array.isArray(planned.needs) ? planned.needs : []).flatMap((n) => {
        const l = typeof n.launch === "number" ? launches[n.launch - 1] : undefined;
        const phrases = (Array.isArray(n.phrases) ? n.phrases : []).filter((x): x is string => typeof x === "string" && x.trim().length > 3).slice(0, wide ? 6 : 3);
        return l && phrases.length ? [{ l, who: typeof n.who === "string" ? n.who.slice(0, 120) : "", phrases }] : [];
      });
      // Each launch's phrases, searched; the launches a few at a time.
      const blocks: { l: PairPost; who: string; posts: PairPost[] }[] = [];
      for (let i = 0; i < plans.length; i += 6) {
        blocks.push(...(await Promise.all(plans.slice(i, i + 6).map(async (plan) => {
          const got = (await Promise.all(plan.phrases.map((q) => Promise.race([search(q.toLowerCase().replace(/"/g, ""), siteOf(plan.l)).catch(() => [] as FoundPost[]), new Promise<FoundPost[]>((r) => setTimeout(() => r([]), NEED_SEARCH_MS))])))).flat();
          const once = new Set<string>();
          const posts = got.filter((p) => p.author && p.author !== plan.l.author && !once.has(p.author) && once.add(p.author) && !saysUnder18(p.text) && (!p.postedAt || started - p.postedAt.getTime() < 14 * 86_400_000)).slice(0, wide ? 30 : 12).map((p) => ({ ...p, side: "ask" as const }));
          return { l: plan.l, who: plan.who, posts };
        }))));
      }
      const withPosts = blocks.filter((b) => b.posts.length);
      const pairs: Pair[] = [];
      const batches = Array.from({ length: Math.ceil(withPosts.length / 8) }, (_, i) => withPosts.slice(i * 8, i * 8 + 8));
      await Promise.all(batches.map(async (batch) => {
        const flat = batch.flatMap((b) => b.posts);
        let n = 0;
        const text = batch.map((b, bi) => [`LAUNCH L${bi + 1} by ${b.l.author}: ${[b.l.title, b.l.text].filter(Boolean).join(" | ").replace(/\s+/g, " ").slice(0, 300)}`, `for: ${b.who}`, ...b.posts.map((p) => `P${++n}. ${p.author}: ${p.text.replace(/\s+/g, " ").slice(0, 300)}`)].join("\n")).join("\n\n");
        const answer = await call(NEED_JUDGE_SYSTEM, wide ? `${text}\n\nThis launch's maker asked to be introduced: keep up to ${perLaunch} posts for it, each as plainly a fit as the first.` : text).catch((e: unknown) => { this.#log.warn("pairs.needs_judge_failed", { error: e instanceof Error ? e.message.slice(0, 200) : String(e) }); return ""; });
        let judged: { pairs?: { launch?: unknown; post?: unknown; asked?: unknown; why?: unknown }[] } = {};
        try { judged = JSON.parse(answer || "{}") as typeof judged; } catch { this.#log.warn("pairs.needs_judge_unread", { answer: answer.slice(0, 200) }); }
        const each = new Map<string, number>();
        for (const j of Array.isArray(judged.pairs) ? judged.pairs : []) {
          // "L3" and "P17" as well as 3 and 17.
          const num = (v: unknown): number => Number(String(v ?? "").replace(/[^0-9]/g, "")) || 0;
          const b = batch[num(j.launch) - 1];
          const p = flat[num(j.post) - 1];
          // The post must be one found for that launch: a number that points elsewhere is dropped.
          if (!b || !p || !b.posts.includes(p) || (each.get(b.l.url) ?? 0) >= perLaunch) continue;
          each.set(b.l.url, (each.get(b.l.url) ?? 0) + 1);
          pairs.push({ ask: { ...p, tell: j.asked === true }, launch: b.l, why: typeof j.why === "string" ? j.why.slice(0, 300) : "" });
        }
      }));
      if (!pairs.length) this.#log.info("pairs.needs_none", { judged: withPosts.length });
      this.#log.info("pairs.needs", { customerId, taskId, tongue, launches: launches.length, planned: plans.length, searched: blocks.reduce((s, b) => s + b.posts.length, 0), found: plans.map((p, i) => `${p.phrases.join(" / ")}: ${blocks[i]?.posts.length ?? 0}`), pairs: pairs.length, ms: Date.now() - started });
      return pairs;
    } catch (e) {
      this.#log.warn("pairs.needs_failed", { customerId, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      return [];
    }
  }

  /** Up to eight pairs from this week's asks and launches. `posts` is the run's own search: the sites it reaches are added to Hacker News and the shared cache. */
  async find(ask: { customerId: CustomerId; taskId?: TaskId | null; posts?: PostSearch; days?: number; closedOnly?: boolean }): Promise<PairsFound> {
    const started = Date.now();
    const days = ask.days ?? 7;
    const failed: string[] = [];
    const misses = new Map<string, number>();
    const pool: PairPost[] = [];
    const add = async (name: string, get: () => Promise<PairPost[]>): Promise<void> => {
      try {
        pool.push(...(await get()));
      } catch (e) {
        // One search a site did not answer is that search; two, and the site is left for this time.
        misses.set(name, (misses.get(name) ?? 0) + 1);
        if (misses.get(name)! >= 2 && !failed.includes(name)) failed.push(name);
        this.#log.warn("pairs.search_failed", { customerId: ask.customerId, source: name, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      }
    };
    await this.#standing(days, add);
    const standing = pool.length;
    const offered = new Set((ask.posts?.sources() ?? []).map((s) => s.name));
    const turn = Math.floor(started / TURN_MS);
    const search = (source: string, query: string, side: PairPost["side"]): Promise<void> =>
      add(source, async () => (await ask.posts!.search({ source, query, within: "week", limit: source === "bluesky" ? 50 : 20 })).map((p) => ({ ...p, side })));
    // What launched this week says whom to look for: a search in the words of the people those launches want.
    const wanted = this.#wanted(ask.customerId, ask.taskId ?? null, pool);
    // The searches get two and a half minutes in all: a site that waits its turn in their Chrome behind other work held
    // the whole match for six (live, 2026-11-12: 348 s, with X and LinkedIn never answering). What came by then is used,
    // and what comes later still reaches the cache through the next run's searches.
    const sites = Promise.all([
      // Each site's searches one after another, at its own pace; the sites side by side.
      ...Object.entries(WORD_SOURCES).filter(([s]) => offered.has(s)).map(async ([source, n]) => {
        const exact = (q: string): string => (source === "bluesky" ? `"${q}"` : q);
        const plan = [
          ...stretch(ASK_WORDS, n.asks, turn).map((q) => ({ query: exact(q), side: "ask" as const })),
          ...stretch(LAUNCH_WORDS, n.launches, turn).map((q) => ({ query: exact(q), side: "launch" as const })),
        ];
        for (const w of plan) {
          if (failed.includes(source) || failed.includes("slow sites")) return;
          await search(source, w.query, w.side);
        }
        for (const w of (await wanted).filter((x) => x.side === "users").slice(0, n.needs)) {
          if (failed.includes(source)) return;
          await search(source, w.search, "ask");
        }
      }),
      ...(offered.has("web") ? [(async () => { for (const q of stretch(TELEGRAM_ASKS, 2, turn)) await search("web", q, "ask"); })()] : []),
      ...(offered.has("mastodon") ? [...TAGS.ask.map((t) => search("mastodon", t, "ask")), ...TAGS.launch.map((t) => search("mastodon", t, "launch"))] : []),
    ]);
    // Beside them, from the makers' side: what each fresh launch's first user would have posted, searched and judged.
    // Not everyone from one site to another (the founder, 2026-11-13: "if we always send users from one platform to a
    // specific another, it may be considered spam"): a launch on X is searched for on X first, and one search in four
    // goes to X anyway, within what X's pace leaves a look (NEEDS_ON_X).
    // More than Bluesky (the founder, 2026-11-13: "use other platforms as well"): every other search goes to X, and one
    // in six to LinkedIn, each within what its pace leaves a look; a launch on X or LinkedIn is searched for there first.
    let onX = offered.has("x") ? NEEDS_ON_X : 0;
    let onLinkedIn = offered.has("linkedin") ? NEEDS_ON_LINKEDIN : 0;
    let asked = 0;
    const needs = offered.has("bluesky")
      ? this.#needs(ask.customerId, ask.taskId ?? null, pool.slice(0, standing), (query, launchOn) => {
          const n = asked++;
          const li = onLinkedIn > 0 && (launchOn === "linkedin" || n % 3 === 2);
          const x = !li && onX > 0 && (launchOn === "x" || n % 2 === 1);
          if (li) onLinkedIn--;
          if (x) onX--;
          return ask.posts!.search({ source: li ? "linkedin" : x ? "x" : "bluesky", query: li ? query : `"${query}"`, within: "week", limit: 25 });
        })
      : Promise.resolve([]);
    let late: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all([sites, needs]),new Promise<void>((done) => { late = setTimeout(() => { failed.push("slow sites"); done(); }, SEARCH_MS); })]);
    clearTimeout(late);
    // Everyone a search turned up goes to the shared cache, so the next run, anyone's, starts from them.
    await this.#known?.saw(pool.filter((p) => WANTS.test(`${p.title ?? ""} ${p.text}`) || p.side === "launch")).catch((e: unknown) => this.#log.warn("pairs.cache_failed", { error: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
    // A post the customer already answered is not brought to anyone again.
    const drafts = (await this.#drafts?.recent(ask.customerId, 400).catch(() => [])) ?? [];
    const answered = new Set(drafts.map((d) => replySpot(d.url)).filter((s): s is string => s !== null));
    // Nor is someone written to in the last two weeks, wherever the words went (an email for a post on another site).
    const since = Date.now() - 14 * 86_400_000;
    const name = (s: string | null | undefined): string => (s ?? "").trim().replace(/^@/, "").toLowerCase();
    const written = new Set(drafts.filter((d) => d.createdAt.getTime() >= since && (d.kind === "reply" || d.kind === "message")).flatMap((d) => [name(d.target), name(d.author)]).filter(Boolean));
    // Nor anyone handed out in a pair this week: the same two came back run after run (live, 2026-11-12, five runs).
    const paired = new Set([...((await this.#known?.pairedLately(7).catch(() => undefined)) ?? []), ...((await this.#known?.inPairs(14).catch(() => undefined)) ?? [])]);
    const seen = new Set<string>();
    const fresh = pool.filter((p) => !seen.has(p.url) && seen.add(p.url) && !answered.has(replySpot(p.url) ?? p.url) && !written.has(name(p.author)) && !paired.has(knownKey(p) ?? ""));
    // Half of each list is kept for the people who can be answered where they posted: Hacker News answers first and
    // would fill both alone (live, 2026-11-12: 400 launches, every one from Hacker News, with X's and LinkedIn's left out).
    const side = (which: PairPost["side"], cap: number): PairPost[] => {
      const all = fresh.filter((p) => p.side === which && (which === "launch" || WANTS.test(`${p.title ?? ""} ${p.text}`)));
      // The sites take turns, so the one that answers first does not take every place.
      const bySite = new Map<string, PairPost[]>();
      for (const p of all.filter((x) => !CLOSED.has(siteOf(x)))) bySite.set(siteOf(p), [...(bySite.get(siteOf(p)) ?? []), p]);
      const sites: PairPost[] = [];
      for (let i = 0; sites.length < cap / 2 && [...bySite.values()].some((l) => i < l.length); i++) for (const l of bySite.values()) if (l[i] && sites.length < cap / 2) sites.push(l[i]!);
      return [...sites, ...all.filter((p) => CLOSED.has(siteOf(p)))].slice(0, cap);
    };
    const asks = side("ask", PER_SIDE.ask);
    const launches = side("launch", PER_SIDE.launch);
    const matching = Date.now();
    // The makers' side has its own judge: its pairs join the rest, held to the same exclusions.
    const usable = (p: PairPost): boolean => !answered.has(replySpot(p.url) ?? p.url) && !written.has(name(p.author)) && !paired.has(knownKey(p) ?? "");
    const fromNeeds = (await Promise.race([needs, new Promise<Pair[]>((r) => setTimeout(() => r([]), Math.max(30_000, started + NEEDS_MS - Date.now())))]).catch(() => [] as Pair[])).filter((p) => usable(p.ask) && !written.has(name(p.launch.author)));
    await this.#known?.saw(fromNeeds.map((p) => p.ask)).catch(() => undefined);
    // The asks go a few dozen at a time, each call against every launch, side by side: one call of 60 gave 8 pairs at most.
    const chunks = Array.from({ length: Math.ceil(asks.length / ASKS_A_CALL) }, (_, i) => asks.slice(i * ASKS_A_CALL, (i + 1) * ASKS_A_CALL));
    const launchLines = launches.map((p, i) => line(p, i, 170));
    const answers = await Promise.all(chunks.map(async (chunk) => {
      try {
        const reply = await this.#models.modelFor(this.#seat, { customerId: ask.customerId }).invoke([
          new SystemMessage(PAIRS_SYSTEM),
          new HumanMessage(["ASKS", ...chunk.map((p, i) => line(p, i, 320)), "", "LAUNCHES", ...launchLines].join("\n")),
        ]);
        const usage = usageOf(reply);
        if (usage) this.#spend?.record({ customerId: ask.customerId, taskId: ask.taskId ?? null, agent: "judge", model: (reply as { response_metadata?: { model_name?: string } }).response_metadata?.model_name ?? null, ms: Date.now() - matching, usage });
        return parsePairs(textOf(reply.content)).map((p) => ({ a: chunk[p.ask - 1], l: launches[p.launch - 1], why: p.why }));
      } catch (e) {
        this.#log.warn("pairs.match_failed", { customerId: ask.customerId, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
        return [];
      }
    }));
    const taken = new Set<string>();
    const given = new Map<string, number>();
    const all: Pair[] = [];
    for (const { a, l, why } of [...fromNeeds.map((p) => ({ a: p.ask, l: p.launch, why: p.why })), ...answers.flat().filter((p) => p.a && p.l && saysBoth(p.why, p.a, p.l))]) {
      if (!a || !l || taken.has(a.url) || (given.get(l.url) ?? 0) >= ASKS_A_LAUNCH) continue;
      if (a.author && l.author && a.author.toLowerCase() === l.author.toLowerCase()) continue;
      taken.add(a.url);
      given.set(l.url, (given.get(l.url) ?? 0) + 1);
      all.push({ ask: a, launch: l, why });
    }
    // The pairs whose people can be answered where they posted come first, whatever order the model gave.
    const open = (p: Pair): number => [p.ask, p.launch].filter((x) => !CLOSED.has(siteOf(x))).length;
    all.sort((a, b) => open(b) - open(a));
    // Every pair is kept: code writes to whoever can be answered where they posted (finds/introducer.ts), and a run
    // (closedOnly) is handed the ones with someone to reach elsewhere.
    const kept = (await this.#known?.keepPairs(all).catch((e: unknown) => { this.#log.warn("pairs.keep_failed", { error: e instanceof Error ? e.message.slice(0, 200) : String(e) }); return 0; })) ?? 0;
    // A run gets the ones with someone to reach elsewhere, from everything kept and not yet handed to a run.
    const pairs: Pair[] = ask.closedOnly && this.#known ? await this.#known.pairsForRun(PAIRS_A_RUN, (p) => open(p) < 2 || needsCustomers(p.ask)).catch(() => []) : all.slice(0, PAIRS_A_RUN);
    await this.#known?.paired(all.map((p) => p.ask)).catch(() => undefined);
    const known = (await this.#known?.about(pairs.flatMap((p) => [p.ask, p.launch])).catch(() => undefined)) ?? new Map<string, KnownAbout>();
    const from = (list: readonly PairPost[]): Record<string, number> => list.reduce<Record<string, number>>((n, p) => ({ ...n, [siteOf(p)]: (n[siteOf(p)] ?? 0) + 1 }), {});
    this.#log.info("pairs.done", { customerId: ask.customerId, taskId: ask.taskId ?? null, asks: asks.length, launches: launches.length, askFrom: from(asks), launchFrom: from(launches), cached: pool.slice(0, standing).filter((p) => siteOf(p) !== "hackernews").length, pairs: all.length, kept, handed: pairs.length, open: all.map(open), failed, ms: Date.now() - started });
    return { pairs, asks: asks.length, launches: launches.length, failed, known };
  }
}

const one = (p: PairPost, known?: KnownAbout): string =>
  `${p.author ?? "someone"} [${siteOf(p)}]${p.postedAt ? ` (${p.postedAt.toISOString().slice(0, 10)}, ${p.replies ?? 0} answers)` : ""} ${p.url}\n      "${[p.title, p.text].filter(Boolean).join(" | ").replace(/\s+/g, " ").slice(0, 300)}"` +
  (known ? `\n      already known: ${[known.about, known.siteUrl && `site ${known.siteUrl}`, known.reach && `reach them at ${known.reach}`].filter(Boolean).join("; ").slice(0, 400)}` : "");

/** How an introduction reads: the founder, 2026-11-12, "sound natural and not salesy when he connects with people". */
export const INTRO_VOICE =
  "How it reads: like passing a friend's name along, one or two short lines in the customer's own voice. Words first, no link: say you think you saw someone who made that (or a post or two from people looking for exactly this) and ask if they want it, genuinely, the way a person who happened to notice would. Keep the link in note_person's plan as \"Links: <url>\" and give it in the reply once they answer. " +
  'No "check out", no "you should", no "I think you two", no praise of the product, nothing asked in return, nothing about the customer\'s own product. ' +
  "To the one who made it, once and only in passing where it fits, that the customer comes across people asking for such things and will send more their way: people should come to know the customer as someone who knows who is building what and who is looking. Never as an offer or a service.";

/** A launch that says it sells: a price, a plan, a waitlist, customers. */
export const sells = (p: { readonly title: string | null; readonly text: string }): boolean =>
  /\b(saas|b2b|pricing|price|paid plan|free (plan|tier|trial)|per (month|seat|user)|subscription|waitlist|early access|customers?|clients?|first (users|sale|paying)|mrr|revenue|startup|founder|freelancers?|agencies|small business(es)?|teams?)\b|\/mo\b|[$€£]\s?\d/i.test(`${p.title ?? ""} ${p.text}`);
/** A launch with nobody to sell to: a jam game, fan art, a toy. Its maker is not who Quest is for. */
export const hobby = (p: { readonly title: string | null; readonly text: string }): boolean =>
  /\b(game ?jam|itch\.io|ludum dare|steam (page|demo|wishlist)|wishlist (it|on steam)|my (first )?(game|mod|comic|zine|album|song|novel)|indie ?game|gamedev|devlog|roguelike|platformer|fan ?(art|fic|game)|pixel ?art|school project|just for fun)\b/i.test(`${p.title ?? ""} ${p.text}`) && !sells(p);

/**
 * Someone who says they need customers is the customer's own to help, not someone to point at another tool (live,
 * 2026-11-13: code was about to send a seller with "need more customers and sales" to a Show HN that finds buyers).
 */
export const needsCustomers = (p: Pick<FoundPost, "title" | "text">): boolean =>
  /\b(need|needs|find|finding|get|getting|looking for|struggl\w+ (to|with)( find| get)?)\b[^.!?]{0,30}\b(customers|clients|buyers|sales|first users|more users)\b|\b(no|zero|0) (sales|customers|signups|sign-ups|users)\b|\bfirst (paying )?(customers?|sale)\b/i.test(`${p.title ?? ""} ${p.text}`);

/** What the teammate reads after find_pairs: the pairs, and how to bring each together. */
export function pairsText(f: PairsFound): string {
  if (!f.pairs.length) return `No two people who need each other this time (${f.asks} asking, ${f.launches} launching${f.failed.length ? `; not searched: ${f.failed.join(", ")}` : ""}). Go on with the rest of the run.`;
  return [
    `People who need each other (${f.pairs.length} pairs from ${f.asks} asking and ${f.launches} launching):`,
    ...f.pairs.map((p, i) =>
      needsCustomers(p.ask)
        ? `${i + 1}. A founder who says they need customers: the customer's own to help, so never point them at the other tool.\n   them: ${one(p.ask, f.known?.get(p.ask.url))}\n   Check them (their profile and their site), find people who want what they sell (customers_for) and open with those people, helps true; keep the three steps with note_person (plan). Nobody found for them: the one thing on their site that loses a visitor, said plainly.`
        : p.ask.tell === false
          ? // Someone who only showed the need gets no reply (live, 2026-11-18: "I gotta do my math homework" was offered a
            // math tool, and "pls Nintendo make a new one" a browser racing game). Their maker hears of them.
            `${i + 1}. ${p.why}\n   shows the need, did NOT ask for such a thing: never write to this person, only tell the maker about them: ${one(p.ask, f.known?.get(p.ask.url))}\n   made: ${one(p.launch, f.known?.get(p.launch.url))}`
          : `${i + 1}. ${p.why}\n   asks: ${one(p.ask, f.known?.get(p.ask.url))}\n   made: ${one(p.launch, f.known?.get(p.launch.url))}`,
    ),
    "Work through all of them, best first, and be quick: a pair takes two reads and two drafts, not a study. Open both posts (read_page) and read what is under them. Drop the pair when someone already pointed one to the other, when the thing asked for is not what was made after all, or when either post is closed to answers. " +
      "Then bring them together as someone who came across both, one reply under each post (outreach_draft kind reply, quoting their own words): to the one asking, that this person made just that, with the address of their launch post; to the one who made it, that this person is asking for it, with the address of their post and one true thing you noticed about what they made. " +
      "A private message instead where the post takes no replies and the site has messages, and for the one or two pairs that fit best where the person's profile shows messages open (outreach_draft kind message to their profile): the same words, a line longer, said to them alone. " +
      INTRO_VOICE +
      " Someone marked [hackernews] or [reddit], or on any place the customer avoids, is read there and never written to there (Hacker News asks for no generated or automated comments, and Reddit is read only for this customer: never draft on either): reach that person where else they are. " +
      'Where a line says "already known", use it and do not look again. Else their profile there (Hacker News: news.ycombinator.com/user?id=<name>; Reddit: reddit.com/user/<name>), their site and their repository name an email, an X, Bluesky, LinkedIn or Telegram handle: read those (no contact on the profile: their earlier posts there name what they make, and that site has one), then a reply to a fresh post of theirs or a message there (their email: outreach_draft kind message through the customer\'s mail, with a subject), saying where you saw their post. ' +
      "Keep everyone you read with note_person, with reach: every public contact you saw, so nobody has to look twice. Nowhere else to reach them: put the line and both addresses in your report, and still write to the other one, since half an introduction helps too. Always draft with outreach_draft: it waits for the customer's tap, and a line left in your report reaches nobody.",
  ].join("\n");
}

/** What the teammate reads after who_is_wanted: the kinds of people to ask for in a post of the customer's own. */
export function wantedText(list: readonly Wanted[]): string {
  if (!list.length) return "Nothing stands out this week: no kind of person that several builders are looking for. Write the post from their brief instead.";
  return [
    "Who is wanted this week, by several people each:",
    ...list.map((w, i) => `${i + 1}. ${w.side === "users" ? `${w.posts.length} builders are looking for` : `${w.posts.length} people are asking for someone who makes`}: ${w.who}\n   a post could ask: "${w.question}"\n   ${w.posts.map((p) => `${p.author ?? "someone"} ${p.url}`).join("\n   ")}`),
    "Pick the one that fits this platform's people best and write the post as a question that makes those people speak up, in the customer's voice, short. It may say the customer knows a few people building (or looking for) it; it names none of them and carries no link: whoever answers gets the introduction as a reply. Not a list, no hashtags, nothing about the customer's own product.",
  ].join("\n");
}
