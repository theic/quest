import type { FoundPost, PostQuery } from "@mq/core";
import { dateOrNull, getJson, plainText, type Fetch, type PostSource } from "./http.ts";

interface Post {
  uri: string;
  author?: { handle?: string; displayName?: string };
  record?: { text?: string; createdAt?: string };
  replyCount?: number;
}

/**
 * Bluesky's post search through its AppView. api.bsky.app answers without a login;
 * public.api.bsky.app refuses the same search with a 403 (measured 2026-09-26).
 */
export class BlueskySource implements PostSource {
  readonly info = {
    name: "bluesky",
    covers: "Bluesky posts: indie makers, designers, the privacy and open-web crowd",
    queryHint: "a few words people would write, e.g. google analytics gdpr",
  };
  readonly #fetch: Fetch;

  constructor(fetchImpl: Fetch) {
    this.#fetch = fetchImpl;
  }

  async search(q: PostQuery, limit: number): Promise<FoundPost[]> {
    const url = `https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q.query)}&sort=latest&limit=${limit}`;
    const body = await getJson<{ posts?: Post[] }>(this.#fetch, "Bluesky", url);
    return (body.posts ?? []).map((p) => {
      const handle = p.author?.handle ?? "";
      const rkey = p.uri.split("/").pop() ?? "";
      return {
        source: "bluesky",
        url: handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : p.uri,
        author: handle || null,
        title: null,
        text: plainText(p.record?.text),
        postedAt: dateOrNull(p.record?.createdAt),
        replies: p.replyCount ?? null,
      };
    });
  }
}
