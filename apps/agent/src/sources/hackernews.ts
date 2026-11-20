import type { FoundPost, PostQuery } from "@mq/core";
import { dateOrNull, getJson, plainText, type Fetch, type PostSource } from "./http.ts";

interface Hit {
  objectID: string;
  created_at?: string;
  author?: string;
  title?: string | null;
  story_title?: string | null;
  comment_text?: string | null;
  story_text?: string | null;
  num_comments?: number | null;
}

/** How far back each window reaches, in seconds. */
const WINDOW_S = { day: 86_400, week: 7 * 86_400, month: 30 * 86_400, year: 365 * 86_400 } as const;

/** Hacker News through Algolia's public search API: the most relevant from the window asked for, the past year by default (loose word matches win). */
export class HackerNewsSource implements PostSource {
  readonly info = {
    name: "hackernews",
    covers: "Hacker News stories and comments: founders, developers, people choosing tools",
    queryHint: "plain words, e.g. google analytics alternative",
  };
  readonly #fetch: Fetch;

  constructor(fetchImpl: Fetch) {
    this.#fetch = fetchImpl;
  }

  async search(q: PostQuery, limit: number): Promise<FoundPost[]> {
    const since = Math.floor(Date.now() / 1000) - WINDOW_S[q.within ?? "year"];
    const url =
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q.query)}&tags=(story,comment)` +
      `&numericFilters=${encodeURIComponent(`created_at_i>${since}`)}&hitsPerPage=${limit}`;
    const body = await getJson<{ hits?: Hit[] }>(this.#fetch, "Hacker News", url);
    return (body.hits ?? []).map((h) => ({
      source: "hackernews",
      url: `https://news.ycombinator.com/item?id=${h.objectID}`,
      author: h.author ?? null,
      title: h.title ?? h.story_title ?? null,
      text: plainText(h.comment_text ?? h.story_text),
      postedAt: dateOrNull(h.created_at),
      replies: h.num_comments ?? null,
    }));
  }
}
