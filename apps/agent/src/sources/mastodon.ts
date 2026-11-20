import { SearchError, type FoundPost, type PostQuery } from "@mq/core";
import { dateOrNull, getJson, plainText, type Fetch, type PostSource } from "./http.ts";

interface Status {
  url?: string | null;
  uri?: string;
  content?: string;
  account?: { acct?: string };
  created_at?: string;
  replies_count?: number;
}

/**
 * Mastodon hashtags through mastodon.social's public tag timeline, which carries
 * the posts it federates with. Full-text search of posts needs a login there
 * (it answers with nothing), so this source takes a hashtag.
 */
export class MastodonSource implements PostSource {
  readonly info = {
    name: "mastodon",
    covers: "recent Mastodon posts under a hashtag: the privacy, open-source and EU tech crowd",
    queryHint: "one hashtag, without #, e.g. gdpr or googleanalytics",
  };
  readonly #fetch: Fetch;
  readonly #instance: string;

  constructor(fetchImpl: Fetch, instance = "https://mastodon.social") {
    this.#fetch = fetchImpl;
    this.#instance = instance;
  }

  async search(q: PostQuery, limit: number): Promise<FoundPost[]> {
    const tag = q.query.replace(/^#/, "").replace(/[^\p{L}\p{N}_]/gu, "");
    if (!tag) throw new SearchError("bad_query", "mastodon takes one hashtag, e.g. gdpr");
    const url = `${this.#instance}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=${limit}`;
    const body = await getJson<Status[]>(this.#fetch, "Mastodon", url);
    return (Array.isArray(body) ? body : []).map((s) => ({
      source: `mastodon:#${tag}`,
      url: s.url ?? s.uri ?? "",
      author: s.account?.acct ?? null,
      title: null,
      text: plainText(s.content),
      postedAt: dateOrNull(s.created_at),
      replies: s.replies_count ?? null,
    }));
  }
}
