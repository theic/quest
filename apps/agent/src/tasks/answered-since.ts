import type { FoundPost, PostSearch } from "@mq/core";

/**
 * Whether the customer already answered someone on X since the post a reply would go under, asked of X's own search
 * (`from:<them> to:<person>`), not of the thread's page. Live, 2026-11-04: an outreach run read Theo's post on X in a
 * background tab, where X draws a thread's post but none of the replies under it, saw nothing of the founder's answer
 * of two days before, and drafted another. The run had even searched "from:theIcreator to:marcopet_"; the code did not
 * read what came back. An answer to them anywhere since counts: they already took that conversation up themselves.
 */

/** X's epoch: a status id carries the millisecond it was made, above its low 22 bits. */
const X_EPOCH = 1_288_834_974_657n;
const STATUS = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{6,25})/;

/** The X post an address is, with whose it is and when it went up (from its id), or null for anything else. */
export function xStatus(url: string): { readonly handle: string; readonly at: Date } | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)(x|twitter)\.com$/.test(u.hostname)) return null;
    const m = STATUS.exec(u.pathname);
    if (!m) return null;
    const ms = Number((BigInt(m[2]!) >> 22n) + X_EPOCH);
    return { handle: m[1]!, at: new Date(ms) };
  } catch {
    return null;
  }
}

const bare = (h: string): string => h.trim().replace(/^@/, "").toLowerCase();

/**
 * The customer's own post to this person after `since` (or the post itself, when it is theirs), or null. A search that
 * fails says nothing either way: null, and the page checks (`answeredUnder`, the poster's `answeredBelow`) still stand.
 */
export async function answeredSince(posts: PostSearch, me: string, them: string, since: Date): Promise<FoundPost | null> {
  if (bare(me) === bare(them)) return null;
  let found: FoundPost[];
  try {
    found = await posts.search({ source: "x", query: `from:${bare(me)} to:${bare(them)}`, within: "month", limit: 10 });
  } catch {
    return null;
  }
  return found.find((p) => bare(p.author ?? "") === bare(me) && (xStatus(p.url)?.at ?? p.postedAt ?? new Date(0)) > since) ?? null;
}
