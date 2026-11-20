import { SearchError, type FoundPost, type PostQuery } from "@mq/core";
import { dateOrNull, getJson, plainText, type Fetch, type PostSource } from "./http.ts";

interface Item {
  title?: string;
  link?: string;
  body?: string;
  owner?: { display_name?: string };
  creation_date?: number;
  answer_count?: number;
}

const YEAR_S = 365 * 24 * 3600;

/** Questions on one Stack Exchange site: the most relevant from the past year. Without an app key the API allows 300 requests a day per address. */
export class StackExchangeSource implements PostSource {
  readonly info = {
    name: "stackexchange",
    covers: "questions people ask on Stack Exchange sites (Stack Overflow, Webmasters, WordPress, Super User, Freelancing and 170 more)",
    queryHint: "plain words from the question, e.g. GA4 cookie consent",
    siteHint: "required: the site's API name, e.g. stackoverflow, webmasters, wordpress, superuser, freelancing, ux",
  };
  readonly #fetch: Fetch;

  constructor(fetchImpl: Fetch) {
    this.#fetch = fetchImpl;
  }

  async search(q: PostQuery, limit: number): Promise<FoundPost[]> {
    const site = (q.site ?? "").trim().toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(site)) throw new SearchError("bad_query", "stackexchange needs `site`, e.g. webmasters or stackoverflow");
    const since = Math.floor(Date.now() / 1000) - YEAR_S;
    const url =
      `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&fromdate=${since}&filter=withbody` +
      `&site=${encodeURIComponent(site)}&q=${encodeURIComponent(q.query)}&pagesize=${limit}`;
    const body = await getJson<{ items?: Item[] }>(this.#fetch, `Stack Exchange (${site})`, url);
    return (body.items ?? []).map((i) => ({
      source: `stackexchange:${site}`,
      url: i.link ?? "",
      author: plainText(i.owner?.display_name) || null,
      title: plainText(i.title) || null,
      text: plainText(i.body),
      postedAt: dateOrNull(i.creation_date),
      replies: i.answer_count ?? null,
    }));
  }
}
