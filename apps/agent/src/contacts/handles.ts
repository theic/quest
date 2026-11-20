import { bareHandle } from "@mq/core";

/**
 * Who a page is of, from its address alone: the site a person is met on, and their handle there. A contact is keyed by
 * both (contacts.ts), so the same person reached from their post, their profile or a follow is one person.
 */

/** The site a person is met on, as contacts and the People tab name it: "x.com", "threads.com", "reddit". */
export function contactSite(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^(www|old|m|mobile)\./, "");
    if (host === "twitter.com") return "x.com";
    if (host === "threads.net") return "threads.com";
    if (host === "reddit.com" || host.endsWith(".reddit.com")) return "reddit";
    return host;
  } catch {
    return null;
  }
}

/** First path parts that are a site's own pages, never a person. */
const NOT_A_PERSON: Readonly<Record<string, ReadonlySet<string>>> = {
  "x.com": new Set(["home", "search", "explore", "notifications", "messages", "i", "settings", "compose", "hashtag", "login", "signup", "share", "intent"]),
  "instagram.com": new Set(["p", "reel", "reels", "explore", "accounts", "stories", "direct", "tv"]),
};

const parts = (url: string): string[] => {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  } catch {
    return [];
  }
};

/** The handle of the person a page is of (their profile, or a post of theirs), bare and in lower case; null when the address names nobody. */
export function handleOf(url: string): string | null {
  const site = contactSite(url);
  const p = parts(url);
  if (!site || !p.length) return null;
  const first = p[0]!;
  let handle: string | null = null;
  switch (site) {
    case "x.com":
    case "instagram.com":
      handle = NOT_A_PERSON[site]!.has(first.toLowerCase()) ? null : first;
      break;
    case "threads.com":
    case "tiktok.com":
    case "youtube.com":
      handle = first.startsWith("@") ? first : null;
      break;
    case "linkedin.com":
      // A profile (/in/<slug>), or a post of theirs (/posts/<slug>_<what it says>-activity-<id>).
      handle = first === "in" ? (p[1] ?? null) : first === "posts" ? (p[1]?.split("_")[0] ?? null) : null;
      break;
    case "bsky.app":
      handle = first === "profile" ? (p[1] ?? null) : null;
      break;
    case "reddit":
      handle = first === "user" || first === "u" ? (p[1] ?? null) : null;
      break;
  }
  return handle ? bareHandle(handle) : null;
}

/** Whether an address is the profile page of that person on its site (not one of their posts). */
export function isProfileOf(url: string, handle: string): boolean {
  if (handleOf(url) !== bareHandle(handle)) return false;
  const p = parts(url);
  switch (contactSite(url)) {
    case "x.com":
      return p.length === 1 || (p.length === 2 && ["with_replies", "highlights", "media", "articles"].includes(p[1]!));
    case "threads.com":
    case "instagram.com":
    case "tiktok.com":
      return p.length === 1;
    case "youtube.com":
      return p.length <= 2;
    case "linkedin.com":
      return p[0] === "in";
    case "bsky.app":
      return p.length === 2;
    case "reddit":
      return p.length <= 3;
    default:
      return false;
  }
}

/** The address of their profile on a site whose addresses say it, from a post of theirs; null where they do not. */
export function profileUrlOf(url: string): string | null {
  const site = contactSite(url);
  const handle = handleOf(url);
  if (!site || !handle) return null;
  switch (site) {
    case "x.com":
      return `https://x.com/${handle}`;
    case "threads.com":
      return `https://www.threads.com/${handle.startsWith("@") ? handle : `@${handle}`}`;
    case "instagram.com":
      return `https://www.instagram.com/${handle}/`;
    case "tiktok.com":
      return `https://www.tiktok.com/@${handle}`;
    case "youtube.com":
      return `https://www.youtube.com/@${handle}`;
    case "linkedin.com":
      return `https://www.linkedin.com/in/${handle}/`;
    case "bsky.app":
      return `https://bsky.app/profile/${handle}`;
    case "reddit":
      return `https://www.reddit.com/user/${handle}/`;
    default:
      return null;
  }
}
