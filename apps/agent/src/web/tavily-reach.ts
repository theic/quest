import {
  pickFollowUps,
  ReadError,
  SearchError,
  type CustomerId,
  type FoundPost,
  type HostGuard,
  type Logger,
  type PageLink,
  type PageReader,
  type PageText,
  type PostQuery,
  type SiteRead,
} from "@mq/core";
import { WEB_SEARCH_INFO } from "../chrome/chrome-sources.ts";
import { dateOrNull, plainText, type PostSource } from "../sources/http.ts";
import { TavilyError, type DailyCredits, type TavilyClient } from "./tavily-client.ts";

const TEXT_CHARS = 20_000;
/** A search result is a snippet; the page itself is read when it matters. */
const SNIPPET_CHARS = 600;

const hostOf = (url: string): string => (URL.canParse(url) ? new URL(url).hostname : "?");

/** Markdown links as the reader's `links`, so the same follow-up picking serves a page read here or in a Chrome. */
export function linksOf(markdown: string): PageLink[] {
  return [...markdown.matchAll(/\[([^\]]{0,200})\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)].map((m) => ({ text: m[1] ?? "", href: m[2] ?? "" }));
}

const titleOf = (markdown: string): string => /^#{1,2}\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? "";

const pageOf = (url: string, markdown: string): PageText => ({ url, title: titleOf(markdown), description: null, text: markdown.slice(0, TEXT_CHARS) });

/** Why Tavily could not read one address, as the reasons the reading tools act on. */
function failedRead(url: string, why: string): ReadError {
  const host = hostOf(url);
  if (/not found|\b40[44]\b|\b410\b|does not exist/i.test(why)) return new ReadError("not_found", `${url} was not found (${why})`);
  if (/time ?out|timed out/i.test(why)) return new ReadError("timeout", `${host} did not answer in time (${why})`);
  if (/forbidden|\b40[13]\b|denied|blocked|captcha|robot|bot check/i.test(why)) return new ReadError("blocked", `${host} refused the page (${why})`);
  return new ReadError("unavailable", `${url} could not be read (${why})`);
}

function readErrorOf(e: unknown, url: string): ReadError {
  if (e instanceof ReadError) return e;
  if (!(e instanceof TavilyError)) return new ReadError("unavailable", `${url} could not be read: ${e instanceof Error ? e.message : String(e)}`);
  switch (e.reason) {
    case "limit":
      return new ReadError("limit", e.message);
    case "timeout":
      return new ReadError("timeout", e.message);
    default:
      return new ReadError("unavailable", e.message);
  }
}

function searchErrorOf(e: unknown): SearchError {
  if (e instanceof SearchError) return e;
  if (!(e instanceof TavilyError)) return new SearchError("unavailable", `web search: ${e instanceof Error ? e.message : String(e)}`);
  return new SearchError(e.reason === "limit" ? "rate_limited" : e.reason === "bad_request" ? "bad_query" : "unavailable", e.message);
}

/** A failure is a warning, except a key Tavily does not accept: that stops every customer's reading and has to be seen. */
function noteFailure(log: Logger | null, event: string, cause: unknown, data: Record<string, unknown>): void {
  if (cause instanceof TavilyError && cause.reason === "auth") log?.error(event, { ...data, key: "not accepted" });
  else log?.warn(event, data);
}

interface Deps {
  readonly client: TavilyClient;
  readonly guard: HostGuard;
  readonly credits: DailyCredits;
  readonly log: Logger | null;
}

/** Reads public pages through Tavily's extract: no Chrome, no login, and nothing here ever reads as the customer. */
export class TavilyReader implements PageReader {
  readonly #customerId: CustomerId;
  readonly #d: Deps;

  constructor(customerId: CustomerId, deps: Deps) {
    this.#customerId = customerId;
    this.#d = deps;
  }

  async readPage(raw: string): Promise<PageText> {
    const url = await this.#d.guard.check(raw);
    const [page] = await this.#extract([url.href]);
    return pageOf(page!.url, page!.markdown);
  }

  /** The page they gave, then up to `pages - 1` same-site pages that say more about what it sells (the links in its markdown). */
  async readSite(raw: string, opts: { pages?: number } = {}): Promise<SiteRead> {
    const url = await this.#d.guard.check(raw);
    const [first] = await this.#extract([url.href]);
    const pages = [pageOf(first!.url, first!.markdown)];
    const next = pickFollowUps(first!.url, linksOf(first!.markdown), Math.min(opts.pages ?? 4, 6) - 1);
    if (next.length && this.#d.credits.take(this.#customerId, 1)) {
      try {
        const safe = await Promise.all(next.map((n) => this.#d.guard.check(n).then((u) => u.href, () => null)));
        const more = await this.#d.client.extract(safe.filter((n): n is string => n !== null));
        for (const p of more.results) if (p.raw_content.trim()) pages.push(pageOf(p.url, p.raw_content));
      } catch {
        // One page that will not open does not spoil the site read.
      }
    }
    return { pages };
  }

  /** The pages Tavily read, as markdown: at least one, or it throws the reason there are none. */
  async #extract(urls: string[]): Promise<{ url: string; markdown: string }[]> {
    const url = urls[0] ?? "";
    if (!this.#d.credits.take(this.#customerId, 1)) throw new ReadError("limit", "today's allowance for reading pages this way is spent");
    const started = Date.now();
    try {
      const got = await this.#d.client.extract(urls);
      const miss = got.failed[0];
      if (!got.results.length && miss) throw failedRead(miss.url, miss.error);
      const pages = got.results.filter((r) => r.raw_content.trim());
      if (!pages.length) throw new ReadError("unavailable", `${url} had no readable text`);
      this.#d.log?.info("tavily.read", { customerId: this.#customerId, host: hostOf(url), ms: Date.now() - started });
      return pages.map((p) => ({ url: p.url, markdown: p.raw_content }));
    } catch (e) {
      const err = readErrorOf(e, url);
      noteFailure(this.#d.log, "tavily.read_failed", e, { customerId: this.#customerId, host: hostOf(url), ms: Date.now() - started, reason: err.reason });
      throw err;
    }
  }
}

/** The web at large through Tavily's search. Results are pages, not posts: a snippet, until the page is read. */
export class TavilyWebSource implements PostSource {
  readonly info = WEB_SEARCH_INFO;
  readonly #customerId: CustomerId;
  readonly #d: Deps;

  constructor(customerId: CustomerId, deps: Deps) {
    this.#customerId = customerId;
    this.#d = deps;
  }

  async search(q: PostQuery, limit: number): Promise<FoundPost[]> {
    if (!this.#d.credits.take(this.#customerId, 1)) throw new SearchError("rate_limited", "today's allowance for searching this way is spent");
    // `site:example.com` in the words stays on that site, as it does on a search engine.
    const sites = [...q.query.matchAll(/\bsite:(\S+)/gi)].map((m) => m[1]!.toLowerCase());
    const query = q.query.replace(/\bsite:\S+/gi, "").replace(/\s+/g, " ").trim() || q.query;
    const started = Date.now();
    try {
      const hits = await this.#d.client.search({
        query,
        max_results: limit,
        ...(q.within ? { time_range: q.within } : {}),
        ...(sites.length ? { include_domains: sites } : {}),
      });
      this.#d.log?.info("tavily.search", { customerId: this.#customerId, ms: Date.now() - started, found: hits.length });
      return hits.map((h) => ({
        source: "web",
        url: h.url,
        author: null,
        title: h.title.trim() || null,
        text: plainText(h.content, SNIPPET_CHARS),
        postedAt: dateOrNull(h.published_date),
        replies: null,
        preview: true,
      }));
    } catch (e) {
      const err = searchErrorOf(e);
      noteFailure(this.#d.log, "tavily.search_failed", e, { customerId: this.#customerId, ms: Date.now() - started, reason: err.reason });
      throw err;
    }
  }
}

/** Tavily as a way to read and search the public web for one customer. */
export class TavilyReach {
  readonly #d: Deps;

  constructor(deps: Deps) {
    this.#d = deps;
  }

  forCustomer(customerId: CustomerId): { reader: PageReader; web: PostSource } {
    return { reader: new TavilyReader(customerId, this.#d), web: new TavilyWebSource(customerId, this.#d) };
  }
}
