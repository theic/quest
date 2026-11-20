import { SearchError, type FoundPost, type PostQuery, type PostSearch, type SourceInfo } from "@mq/core";
import { BlueskySource } from "./bluesky.ts";
import { GitHubSource } from "./github.ts";
import { HackerNewsSource } from "./hackernews.ts";
import type { Fetch, PostSource } from "./http.ts";
import { LemmySource } from "./lemmy.ts";
import { MastodonSource } from "./mastodon.ts";
import { StackExchangeSource } from "./stackexchange.ts";

const MAX_LIMIT = 20;

/** Every source Quest can search, by name. */
export class SourceRegistry implements PostSearch {
  readonly #sources = new Map<string, PostSource>();

  constructor(sources: readonly PostSource[]) {
    for (const s of sources) this.#sources.set(s.info.name, s);
  }

  sources(): readonly SourceInfo[] {
    return [...this.#sources.values()].map((s) => s.info);
  }

  async search(q: PostQuery): Promise<FoundPost[]> {
    const source = this.#sources.get(q.source.trim().toLowerCase());
    if (!source) throw new SearchError("unknown_source", `no source "${q.source}"; there are: ${[...this.#sources.keys()].join(", ")}`);
    if (!q.query.trim()) throw new SearchError("bad_query", "the query is empty");
    const limit = Math.min(Math.max(1, q.limit ?? 10), MAX_LIMIT);
    const posts = await source.search(q, limit);
    return posts.filter((p) => p.url);
  }
}

/** The sources measured to answer a cloud machine without a login (FACTS.md, 2026-09-26). */
export function publicSourceList(fetchImpl: Fetch = fetch): PostSource[] {
  return [
    new HackerNewsSource(fetchImpl),
    new StackExchangeSource(fetchImpl),
    new BlueskySource(fetchImpl),
    new LemmySource(fetchImpl),
    new GitHubSource(fetchImpl),
    new MastodonSource(fetchImpl),
  ];
}

export const publicSources = (fetchImpl: Fetch = fetch): SourceRegistry => new SourceRegistry(publicSourceList(fetchImpl));
