import type { FoundPost, PageText } from "@mq/core";

/**
 * Answers to what went up under a Bluesky post, from Bluesky's public API: no page in their Chrome, no model.
 * Live, 2026-11-15: read off the post's page, about thirty makers who had said "yes, go ahead" to an introduction were
 * never seen, and nothing followed; the API lists every reply with who wrote it and its own address.
 */
const API = "https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread";
const POST = /^https:\/\/bsky\.app\/profile\/([^/]+)\/post\/([a-z0-9]+)/i;

interface Node {
  readonly post?: { readonly uri: string; readonly author: { readonly handle: string }; readonly record?: { readonly text?: string; readonly createdAt?: string } };
  readonly replies?: readonly Node[];
}

export interface SkyAnswer {
  /** Which of the sent things it answers, from 0. */
  readonly to: number;
  readonly author: string;
  readonly text: string;
}

export const blueskyPost = (url: string): boolean => POST.test(url);

const flat = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
/** The same words, as far as either goes: a link the site shortened ends a post's text early. */
const sameWords = (a: string, b: string): boolean => {
  const [x, y] = [flat(a).slice(0, 60), flat(b).slice(0, 60)];
  return x.length >= 12 && y.length >= 12 && (x.startsWith(y.slice(0, 40)) || y.startsWith(x.slice(0, 40)));
};
const address = (n: Node): string => `https://bsky.app/profile/${n.post!.author.handle}/post/${n.post!.uri.split("/").pop()}`;

/** The page as the watch needs it, and who answered which of `sent` (their words as they went up); null when the API has no such thread. */
export async function blueskyAnswers(url: string, sent: readonly string[], fetcher: typeof fetch = fetch): Promise<{ page: PageText; heard: SkyAnswer[] } | null> {
  const m = POST.exec(url);
  if (!m) return null;
  const res = await fetcher(`${API}?uri=${encodeURIComponent(`at://${m[1]}/app.bsky.feed.post/${m[2]}`)}&depth=3`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const top = ((await res.json()) as { thread?: Node }).thread;
  if (!top?.post) return null;
  const heard: SkyAnswer[] = [];
  const posts: FoundPost[] = [];
  // Their own words anywhere in the thread: whoever replied right under them answered them.
  const walk = (n: Node): void => {
    const to = n.post ? sent.findIndex((s) => sameWords(s, n.post!.record?.text ?? "")) : -1;
    for (const r of n.replies ?? []) {
      if (!r.post) continue;
      const text = (r.post.record?.text ?? "").trim();
      if (to >= 0 && text && r.post.author.handle !== n.post!.author.handle) {
        heard.push({ to, author: r.post.author.handle, text });
        posts.push({ source: "bluesky", url: address(r), author: r.post.author.handle, title: null, text, postedAt: r.post.record?.createdAt ? new Date(r.post.record.createdAt) : null, replies: r.replies?.length ?? null });
      }
      walk(r);
    }
  };
  walk(top);
  return { page: { url, title: "Bluesky", description: null, text: posts.map((p) => `${p.author}: ${p.text}`).join("\n"), posts }, heard };
}
