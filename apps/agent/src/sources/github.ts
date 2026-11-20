import type { FoundPost, PostQuery } from "@mq/core";
import { dateOrNull, getJson, plainText, type Fetch, type PostSource } from "./http.ts";

interface Issue {
  html_url?: string;
  title?: string;
  body?: string | null;
  user?: { login?: string };
  created_at?: string;
  comments?: number;
}

/** GitHub issues, newest first. Without a token GitHub allows 10 searches a minute. */
export class GitHubSource implements PostSource {
  readonly info = {
    name: "github",
    covers: "GitHub issues: developers asking for a feature, a fix or a replacement tool",
    queryHint: "GitHub search words, e.g. \"cookie banner\" analytics",
  };
  readonly #fetch: Fetch;

  constructor(fetchImpl: Fetch) {
    this.#fetch = fetchImpl;
  }

  async search(q: PostQuery, limit: number): Promise<FoundPost[]> {
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(`${q.query} is:issue`)}&sort=created&order=desc&per_page=${limit}`;
    const body = await getJson<{ items?: Issue[] }>(this.#fetch, "GitHub", url, { accept: "application/vnd.github+json" });
    return (body.items ?? []).map((i) => ({
      source: "github",
      url: i.html_url ?? "",
      author: i.user?.login ?? null,
      title: i.title ?? null,
      text: plainText(i.body),
      postedAt: dateOrNull(i.created_at),
      replies: i.comments ?? null,
    }));
  }
}
