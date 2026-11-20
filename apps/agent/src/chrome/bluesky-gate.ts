const API = "https://public.api.bsky.app/xrpc/";

/**
 * Whether a Bluesky post sits in a thread whose first post limits who may reply (its threadgate). Bluesky's page shows
 * such a post's Reply button like any other and it does nothing, so the poster pressed it for three minutes, twice
 * (live, 2026-11-14: a reply under a post whose thread let only followers answer). Asked of Bluesky's public API, which
 * needs no account; anything it cannot say is "no", and the page decides as before.
 */
export async function repliesGated(url: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const at = /^https:\/\/bsky\.app\/profile\/([^/]+)\/post\/([a-z0-9]+)/i.exec(url);
  if (!at) return false;
  try {
    const ask = async (path: string): Promise<unknown> => (await fetcher(`${API}${path}`, { signal: AbortSignal.timeout(8_000) })).json();
    const who = at[1]!.startsWith("did:") ? at[1]! : ((await ask(`com.atproto.identity.resolveHandle?handle=${encodeURIComponent(at[1]!)}`)) as { did?: string }).did;
    if (!who) return false;
    const got = (await ask(`app.bsky.feed.getPostThread?uri=${encodeURIComponent(`at://${who}/app.bsky.feed.post/${at[2]!}`)}&depth=0&parentHeight=30`)) as { thread?: Node };
    // The gate is the first post's; every post above this one is looked at, since a thread may be cut short.
    for (let node = got.thread; node; node = node.parent) if (node.post?.threadgate) return true;
    return false;
  } catch {
    return false;
  }
}

interface Node {
  readonly post?: { readonly threadgate?: unknown };
  readonly parent?: Node;
}

/**
 * Why a Bluesky message to this person cannot go, or null when it can (or nobody can tell). Bluesky lets each account
 * take messages from everyone, from the people it follows (also its default, when it says nothing) or from nobody,
 * and its page then shows no Message button and a "New chat" that never lists them (live, 2026-11-17: 21 messages
 * waited on cards, every try spent four minutes typing into that search box). `me` is the customer's own profile
 * address as the page shows it; without it, only "nobody" is known for sure.
 */
/**
 * Their own Bluesky profile, as a page of theirs last showed it: learned by the poster on any send there, read when a
 * message is drafted, so one to someone who takes none from them is never put on a card. In memory.
 */
const accounts = new Map<string, string>();
export const noteBlueskyAccount = (customerId: string, profile: string | null): void => void (profile && profile.toLowerCase().startsWith("https://bsky.app/profile/") && accounts.set(customerId, profile));
export const blueskyAccount = (customerId: string): string | null => accounts.get(customerId) ?? null;

export async function messagesClosed(url: string, target: string, me: string | null, fetcher: typeof fetch = fetch): Promise<string | null> {
  const handle = (s: string): string | null => {
    const at = /^https:\/\/bsky\.app\/profile\/([^/?#]+)/i.exec(s)?.[1] ?? (/^@?([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i.exec(s.trim())?.[1] ?? null);
    return at ? decodeURIComponent(at) : null;
  };
  const them = handle(target) ?? handle(url);
  if (!them) return null;
  try {
    const ask = async (path: string): Promise<unknown> => (await fetcher(`${API}${path}`, { signal: AbortSignal.timeout(8_000) })).json();
    const profile = (await ask(`app.bsky.actor.getProfile?actor=${encodeURIComponent(them)}`)) as { did?: string; associated?: { chat?: { allowIncoming?: string } } };
    if (!profile.did) return null;
    const allow = profile.associated?.chat?.allowIncoming ?? "following";
    if (allow === "all") return null;
    if (allow === "none") return `@${them} takes no messages on Bluesky.`;
    const own = me ? handle(me) : null;
    // getRelationships takes their DIDs, not handles.
    const mine = own?.startsWith("did:") ? own : own ? ((await ask(`com.atproto.identity.resolveHandle?handle=${encodeURIComponent(own)}`)) as { did?: string }).did : null;
    if (!mine) return null;
    const rel = (await ask(`app.bsky.graph.getRelationships?actor=${encodeURIComponent(profile.did)}&others=${encodeURIComponent(mine)}`)) as { relationships?: { following?: string }[] };
    return rel.relationships?.[0]?.following ? null : `@${them} takes messages on Bluesky only from people they follow.`;
  } catch {
    return null;
  }
}
