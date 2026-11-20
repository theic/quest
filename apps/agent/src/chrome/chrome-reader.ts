import {
  ChromeError,
  pickFollowUps,
  ReadError,
  type ChromeJob,
  type ChromeRead,
  type HostGuard,
  type Logger,
  type PageReader,
  type PageText,
  type SiteRead,
} from "@mq/core";
import { drawnJob, isRedditThread, REDDIT_CHECK, redditRefused, threadFrom, threadJob, wantsDrawing } from "./reddit.ts";
import { postsText, readerFor, type SiteReader } from "./sites.ts";

/** Reads one page in one customer's Chrome. */
export type ReadInChrome = (job: ChromeJob) => Promise<ChromeRead>;

/** Challenge pages some sites show instead of their content. */
const WALL = /just a moment|attention required|verify you are (a )?human|prove your humanity|access denied|are you a robot|enable javascript and cookies/i;

const TEXT_CHARS = 20_000;

/** The same post, whichever way its address was written: twitter.com or x.com, www or not, a trailing slash, a query. */
const sameAddress = (a: string, b: string): boolean => {
  const key = (raw: string) => {
    try {
      const u = new URL(raw);
      return `${u.hostname.replace(/^www\./, "").replace(/^(mobile\.)?twitter\.com$/, "x.com")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
    } catch {
      return raw.toLowerCase();
    }
  };
  return key(a) === key(b);
};

const toPageText = (r: ChromeRead): PageText => ({ url: r.url, title: r.title, description: r.description, text: r.text.slice(0, TEXT_CHARS) });

/** What went wrong in the customer's Chrome, in the words the reading tools act on. */
export function readErrorOf(e: unknown, url: string): ReadError {
  if (e instanceof ReadError) return e;
  if (!(e instanceof ChromeError)) return new ReadError("unavailable", `${url} could not be read: ${e instanceof Error ? e.message : String(e)}`);
  switch (e.reason) {
    case "offline":
    case "hidden":
    case "limit":
    case "invalid_url":
    case "blocked":
    case "not_found":
    case "timeout":
      return new ReadError(e.reason, e.message);
    default:
      return new ReadError("unavailable", e.message);
  }
}

/**
 * A page read in the customer's Chrome, checked the way a careful reader
 * would: the status, and the challenge pages that stand in for content.
 */
export async function readChecked(read: ReadInChrome, job: ChromeJob): Promise<ChromeRead> {
  let r: ChromeRead;
  try {
    r = await read(job);
  } catch (e) {
    throw readErrorOf(e, job.url);
  }
  const host = new URL(job.url).hostname;
  if (r.status === 404 || r.status === 410) throw new ReadError("not_found", `${job.url} answered ${r.status}`);
  if (r.status === 401 || r.status === 403 || r.status === 429) {
    throw new ReadError("blocked", `${host} refused the page in the customer's Chrome (HTTP ${r.status})`);
  }
  if (r.status !== null && r.status >= 500) throw new ReadError("unavailable", `${job.url} answered ${r.status}`);
  if (WALL.test(r.title) || (r.text.length < 400 && WALL.test(r.text))) {
    throw new ReadError("blocked", `${host} showed a bot check in the customer's Chrome`);
  }
  return r;
}

/**
 * The customer's Chrome as the team's reader. Every address is checked first:
 * a page read there must be on the public internet, never on their own network.
 */
export class ChromeReader implements PageReader {
  readonly #read: ReadInChrome;
  readonly #guard: HostGuard;
  readonly #log: Logger | null;
  readonly #now: () => Date;

  constructor(read: ReadInChrome, guard: HostGuard, opts: { log?: Logger | null; now?: () => Date } = {}) {
    this.#read = read;
    this.#guard = guard;
    this.#log = opts.log ?? null;
    this.#now = opts.now ?? (() => new Date());
  }

  async readPage(raw: string, opts: { asVisitor?: boolean; check?: boolean; drawn?: boolean } = {}): Promise<PageText> {
    const url = await this.#guard.check(raw);
    const visitor = { ...(opts.asVisitor ? { asVisitor: true } : {}), ...(opts.check ? { check: true } : {}) };
    if (isRedditThread(url)) return this.#redditThread(url, visitor);
    const site = opts.asVisitor || opts.check ? null : readerFor(url.href);
    if (site) return this.#cut(site, url.href);
    return toPageText(await readChecked(this.#read, { url: url.href, take: { text: true }, settleMs: opts.drawn ? 6_000 : 2_500, ...visitor, ...(opts.drawn ? { drawn: true } : {}) }));
  }

  /** The page they gave, then up to `pages - 1` same-site pages that say more about what it sells. */
  async readSite(raw: string, opts: { pages?: number } = {}): Promise<SiteRead> {
    const url = await this.#guard.check(raw);
    const first = await readChecked(this.#read, { url: url.href, take: { text: true, links: true }, settleMs: 2_500 });
    const out: PageText[] = [toPageText(first)];
    for (const next of pickFollowUps(first.url, first.links, Math.min(opts.pages ?? 4, 6) - 1)) {
      try {
        const more = await readChecked(this.#read, { url: (await this.#guard.check(next)).href, take: { text: true }, settleMs: 2_500 });
        if (more.text.trim()) out.push(toPageText(more));
      } catch (e) {
        // One page that will not open does not spoil the site read; a Chrome that went away does.
        if (e instanceof ReadError && (e.reason === "offline" || e.reason === "limit")) throw e;
      }
    }
    return { pages: out };
  }

  /**
   * A search, a listing, a profile or a thread on a big site, as its posts: a few hundred characters each, where the
   * page was 24,000. A profile's header comes first; a thread's own post is the page's post, with whose it is.
   */
  async #cut(site: SiteReader, url: string): Promise<PageText> {
    const r = await readChecked(this.#read, site.job(url));
    const posts = site.postsFrom(r, this.#now());
    const about = site.aboutFrom?.(r) ?? null;
    const account = site.accountFrom?.(r) ?? null;
    if (!posts.length && !about) {
      // Rows the reader could not make posts of are a page that changed: logged, so the spec gets fixed.
      this.#log?.info("site.cut_empty", { site: site.key, rows: Object.values(r.rows).reduce((n, rows) => n + rows.length, 0) });
      return toPageText(r);
    }
    const own = posts.find((p) => sameAddress(p.url, url) || sameAddress(p.url, r.url));
    return {
      url: r.url,
      title: r.title,
      description: r.description,
      text: [about, posts.length ? postsText(posts) : "(no posts shown)"].filter(Boolean).join("\n\n"),
      posts,
      ...(own ? { post: { source: own.source, author: own.author, title: own.title, postedAt: own.postedAt } } : {}),
      ...(account ? { account } : {}),
    };
  }

  async #redditThread(url: URL, visitor: { asVisitor?: boolean; check?: boolean }): Promise<PageText> {
    let job: ChromeJob = { ...threadJob(url), ...visitor };
    let r = await readChecked(this.#read, job);
    if (wantsDrawing(r)) {
      job = drawnJob(job);
      r = await readChecked(this.#read, job);
    }
    if (redditRefused(r)) throw new ReadError("blocked", REDDIT_CHECK);
    return threadFrom(r, url.href) ?? { ...toPageText(r), url: url.href };
  }
}
