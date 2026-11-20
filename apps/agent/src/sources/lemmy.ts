import type { FoundPost, PostQuery } from "@mq/core";
import { dateOrNull, getJson, plainText, type Fetch, type PostSource } from "./http.ts";

interface View {
  post?: { name?: string; body?: string | null; ap_id?: string; published?: string };
  creator?: { name?: string };
  community?: { name?: string };
  counts?: { comments?: number };
}

/** Lemmy (the federated Reddit alternative) through lemmy.world's search, which sees the communities it federates with. */
export class LemmySource implements PostSource {
  readonly info = {
    name: "lemmy",
    covers: "Lemmy threads, the federated Reddit alternative: self-hosters, privacy, open source, tech communities",
    queryHint: "plain words, e.g. google analytics alternative",
  };
  readonly #fetch: Fetch;
  readonly #instance: string;

  constructor(fetchImpl: Fetch, instance = "https://lemmy.world") {
    this.#fetch = fetchImpl;
    this.#instance = instance;
  }

  async search(q: PostQuery, limit: number): Promise<FoundPost[]> {
    const url = `${this.#instance}/api/v3/search?q=${encodeURIComponent(q.query)}&type_=Posts&sort=New&limit=${limit}`;
    const body = await getJson<{ posts?: View[] }>(this.#fetch, "Lemmy", url);
    return (body.posts ?? []).map((v) => ({
      source: v.community?.name ? `lemmy:${v.community.name}` : "lemmy",
      url: v.post?.ap_id ?? "",
      author: v.creator?.name ?? null,
      title: v.post?.name ?? null,
      text: plainText(v.post?.body),
      postedAt: dateOrNull(v.post?.published),
      replies: v.counts?.comments ?? null,
    }));
  }
}
