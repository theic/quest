/**
 * Mastodon and its kin: a post lives on its author's server, and someone with an account elsewhere answers or likes it
 * from their own server, which shows any post by its address. Live, 2026-11-11: a reply drafted at
 * mastodon.example.net, where the customer has no account, met "Sign in to continue" four times, while their own
 * account sat on mastodon.social.
 */

/** A post's address as Mastodon servers write it: /@name/<id>, or /@name@server/<id>. */
const STATUS = /^\/@[\w.-]+(@[\w.-]+)?\/\d+\/?$/;
/** A profile's address, as they give it: https://mastodon.social/@name. */
const ACCOUNT = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})\/@[\w.-]+/gi;

/** The server their fediverse account is on, read from what Quest keeps about them: the memory that names Mastodon with their own address. */
export function fediverseHome(memories: readonly string[]): string | null {
  for (const text of memories) {
    if (!/mastodon|fediverse/i.test(text)) continue;
    const m = [...text.matchAll(ACCOUNT)][0];
    if (m) return m[1]!.toLowerCase();
  }
  return null;
}

/** Where a post on another server is opened so they can act on it: their own server's page for it; null when it needs none. */
export function fromHome(url: string, home: string | null): string | null {
  if (!home || !URL.canParse(url)) return null;
  const u = new URL(url);
  if (u.hostname.toLowerCase() === home || !STATUS.test(u.pathname)) return null;
  return `https://${home}/authorize_interaction?uri=${encodeURIComponent(url)}`;
}
