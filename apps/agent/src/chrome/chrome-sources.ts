import { ReadError, SearchError, type FoundPost, type PostQuery, type SourceInfo } from "@mq/core";
import type { PostSource } from "../sources/http.ts";
import { readChecked, type ReadInChrome } from "./chrome-reader.ts";
import { duckRefused, resultsFrom, searchJob as duckJob, searchUrl as duckUrl } from "./duckduckgo.ts";
import type { SiteReader } from "./sites.ts";
import { communityName, drawnJob, noResults, noRows, postsFrom, REDDIT_CHECK, redditRefused, searchJob, searchUrl, wantsDrawing } from "./reddit.ts";


/** A read that failed, as a search failure the tools know how to explain. */
function searchErrorOf(e: unknown, source: string): SearchError {
  if (e instanceof SearchError) return e;
  if (!(e instanceof ReadError)) return new SearchError("unavailable", `${source}: ${e instanceof Error ? e.message : String(e)}`);
  switch (e.reason) {
    case "offline":
      return new SearchError("offline", e.message);
    case "blocked":
      return new SearchError("refused", e.message);
    case "limit":
      return new SearchError("rate_limited", e.message);
    default:
      return new SearchError("unavailable", e.message);
  }
}

/** Reddit's own search, in the customer's Chrome. */
export class RedditSource implements PostSource {
  readonly info = {
    name: "reddit",
    covers: "Reddit posts, most relevant in the time window, read in the customer's own Chrome",
    queryHint: "the words a person with the problem would write, e.g. alternative to typeform",
    siteHint:
      "optional: one subreddit's name (e.g. SaaS, smallbusiness, Entrepreneur). A search inside one community finds real asks " +
      "four times as often as a search of all Reddit, so use one once you know where these people talk",
  };
  readonly #read: ReadInChrome;

  constructor(read: ReadInChrome) {
    this.#read = read;
  }

  async search(q: PostQuery, limit: number): Promise<FoundPost[]> {
    const community = q.site ? communityName(q.site) : null;
    if (q.site && !community) throw new SearchError("bad_query", `"${q.site}" is not a subreddit name; give it without r/, e.g. SaaS`);
    const job = searchJob(searchUrl(q.query, community, q.within ?? "year"));
    try {
      let r = await readChecked(this.#read, job);
      if (wantsDrawing(r)) r = await readChecked(this.#read, drawnJob(job));
      if (redditRefused(r)) throw new SearchError("refused", REDDIT_CHECK);
      if (noResults(r)) return [];
      if (noRows(r)) throw new SearchError("unavailable", "Reddit's search page came back without results or a 'no results' note (it may not have rendered)");
      return postsFrom(r, limit);
    } catch (e) {
      throw searchErrorOf(e, "Reddit");
    }
  }
}

/** What the agents are told about web search, whichever way it runs (the customer's Chrome, or Tavily when it is closed). */
export const WEB_SEARCH_INFO = {
  name: "web",
  covers:
    "the whole web through a search engine: forums, Q&A sites, blogs and communities the other sources miss. " +
    "Results are pages, not posts: read_page one before you judge or save it",
  queryHint: 'search-engine words; add site:example.com to stay on one site, or a phrase in quotes, e.g. "looking for" typeform alternative',
};

/** The web at large, through DuckDuckGo, in the customer's Chrome. */
export class WebSource implements PostSource {
  readonly info = WEB_SEARCH_INFO;
  readonly #read: ReadInChrome;

  constructor(read: ReadInChrome) {
    this.#read = read;
  }

  async search(q: PostQuery, limit: number): Promise<FoundPost[]> {
    try {
      const r = await readChecked(this.#read, duckJob(duckUrl(q.query, q.within)));
      if (duckRefused(r)) throw new SearchError("refused", "DuckDuckGo showed a check for automated searches in the customer's Chrome");
      return resultsFrom(r, limit);
    } catch (e) {
      throw searchErrorOf(e, "DuckDuckGo");
    }
  }
}

/** A sign-in page where the search was: the site shows its search only to someone signed in. */
const SIGN_IN = /\/(login|signin|i\/flow\/login|authwall|uas\/login|checkpoint)\b/i;

/** A big site's own search, in the customer's Chrome, cut into posts by code (`sites.ts`). */
export class SiteSource implements PostSource {
  readonly info: SourceInfo;
  readonly #site: SiteReader;
  readonly #search: (q: PostQuery, now: Date) => string;
  readonly #read: ReadInChrome;
  readonly #now: () => Date;

  constructor(site: SiteReader, read: ReadInChrome, now: () => Date = () => new Date()) {
    if (!site.info || !site.searchUrl) throw new Error(`${site.key} has no search`);
    this.info = site.info;
    this.#site = site;
    this.#search = site.searchUrl;
    this.#read = read;
    this.#now = now;
  }

  async search(q: PostQuery, limit: number): Promise<FoundPost[]> {
    const now = this.#now();
    try {
      const r = await readChecked(this.#read, this.#site.job(this.#search(q, now)));
      const posts = this.#site.postsFrom(r, now);
      if (!posts.length && SIGN_IN.test(new URL(r.url).pathname)) {
        const host = new URL(r.url).hostname;
        throw new SearchError("unavailable", `the customer is not signed in to ${host} in this Chrome, and its search shows only to someone signed in (it opened ${new URL(r.url).pathname.slice(0, 40)}). They sign in themselves; search elsewhere meanwhile`);
      }
      return posts.slice(0, limit);
    } catch (e) {
      throw searchErrorOf(e, this.info.name);
    }
  }
}
