import {
  ReadError,
  SearchError,
  type CustomerId,
  type FoundPost,
  type Logger,
  type PageReader,
  type PageText,
  type PostQuery,
  type PostSearch,
  type SiteRead,
  type SourceInfo,
  type WebReach,
} from "@mq/core";
import type { PostSource } from "../sources/http.ts";
import type { TavilyReach } from "./tavily-reach.ts";

/**
 * When the customer's Chrome could not try a page, so nobody has refused it: it is closed, it has read its
 * day's pages, or its window is covered. A refusal ("blocked") is the site's answer and is final: it is
 * never taken to another reader (Quest does not go around a site that said no).
 */
const COULD_NOT_TRY: ReadonlySet<string> = new Set(["offline", "limit", "hidden"]);

/** A search engine that would not answer in the customer's Chrome (closed, a bot check, a changed page) may be asked through the API. */
const SEARCH_ANOTHER_WAY: ReadonlySet<string> = new Set(["offline", "rate_limited", "refused", "unavailable"]);

/** Reddit is read and searched only in the customer's own Chrome: nothing says another reader gets through (FACTS.md). */
const isReddit = (url: string): boolean => URL.canParse(url) && /(^|\.)(reddit\.com|redd\.it)$/i.test(new URL(url).hostname);

const hostOf = (url: string): string => (URL.canParse(url) ? new URL(url).hostname : "?");

class RoutedReader implements PageReader {
  readonly #customerId: CustomerId;
  readonly #chrome: PageReader;
  readonly #tavily: PageReader;
  readonly #log: Logger | null;

  constructor(customerId: CustomerId, chrome: PageReader, tavily: PageReader, log: Logger | null) {
    this.#customerId = customerId;
    this.#chrome = chrome;
    this.#tavily = tavily;
    this.#log = log;
  }

  readPage(url: string, opts: { asVisitor?: boolean; check?: boolean; drawn?: boolean } = {}): Promise<PageText> {
    // Reading as a visitor, or checking the customer's own post, is a look through their Chrome, never a stranger's service.
    if (opts.asVisitor || opts.check || isReddit(url)) return this.#chrome.readPage(url, opts);
    return this.#route(url, (r) => r.readPage(url, opts));
  }

  readSite(url: string, opts?: { pages?: number }): Promise<SiteRead> {
    if (isReddit(url)) return this.#chrome.readSite(url, opts);
    return this.#route(url, (r) => r.readSite(url, opts));
  }

  /** The customer's Chrome first; the web reader when the Chrome could not try the page. */
  async #route<T>(url: string, read: (reader: PageReader) => Promise<T>): Promise<T> {
    try {
      return await read(this.#chrome);
    } catch (e) {
      if (!(e instanceof ReadError) || !COULD_NOT_TRY.has(e.reason)) throw e;
      this.#log?.info("web.fallback", { customerId: this.#customerId, host: hostOf(url), why: e.reason });
      return read(this.#tavily);
    }
  }
}

class RoutedPosts implements PostSearch {
  readonly #customerId: CustomerId;
  readonly #chrome: PostSearch;
  readonly #web: PostSource;
  readonly #log: Logger | null;

  constructor(customerId: CustomerId, chrome: PostSearch, web: PostSource, log: Logger | null) {
    this.#customerId = customerId;
    this.#chrome = chrome;
    this.#web = web;
    this.#log = log;
  }

  sources(): readonly SourceInfo[] {
    return this.#chrome.sources();
  }

  async search(q: PostQuery): Promise<FoundPost[]> {
    try {
      return await this.#chrome.search(q);
    } catch (e) {
      // Only the web search has a second way; Reddit's has none, and the public APIs never needed Chrome.
      if (q.source.trim().toLowerCase() !== "web" || !(e instanceof SearchError) || !SEARCH_ANOTHER_WAY.has(e.reason)) throw e;
      this.#log?.info("web.search_fallback", { customerId: this.#customerId, why: e.reason });
      const found = await this.#web.search(q, Math.min(Math.max(1, q.limit ?? 10), 20));
      return found.filter((p) => p.url);
    }
  }
}

/**
 * The customer's Chrome first, and Tavily where Chrome could not try: public pages and web search
 * then run with the Chrome closed. Reddit, reading as a visitor and checking the customer's own
 * posts stay Chrome-only. Tools see one reader and one search, and the same failure reasons.
 */
export class RoutedReach implements WebReach {
  readonly #chrome: WebReach;
  readonly #tavily: TavilyReach;
  readonly #log: Logger | null;

  constructor(deps: { chrome: WebReach; tavily: TavilyReach; log?: Logger | null }) {
    this.#chrome = deps.chrome;
    this.#tavily = deps.tavily;
    this.#log = deps.log ?? null;
  }

  forCustomer(customerId: CustomerId): { reader: PageReader; posts: PostSearch } {
    const chrome = this.#chrome.forCustomer(customerId);
    const tavily = this.#tavily.forCustomer(customerId);
    return {
      reader: new RoutedReader(customerId, chrome.reader, tavily.reader, this.#log),
      posts: new RoutedPosts(customerId, chrome.posts, tavily.web, this.#log),
    };
  }
}
