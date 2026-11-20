import { type Draft, type Find } from "@mq/core";
import { commentRef, postRef } from "../chrome/reddit.ts";
import { platformOf } from "../platforms.ts";

/**
 * Where a reply goes, as one key whatever the address around it: a Reddit post's or comment's id, X's post id
 * (x.com or twitter.com, with any path or query around /status/<id>), else the address without its query, its
 * fragment or a closing slash. Null when it is no address.
 */
/**
 * A person as one key however they were named: "Dana Reed", "dana-reed" and a profile's "dana-reed-449a2216b"
 * are one (live, 2026-11-19: LinkedIn replies to one person were kept under his name and under his profile's slug, so
 * one reply per person saw two people).
 */
export const whoKey = (who: string | null | undefined): string =>
  (who ?? "")
    .trim()
    .replace(/^@|^u\//i, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !/\d/.test(t))
    .join(" ") || (who ?? "").trim().toLowerCase();

export function replySpot(url: string, redditRef?: string | null, who?: string | null): string | null {
  if (redditRef && /^t[13]_[a-z0-9]+$/i.test(redditRef)) return redditRef.toLowerCase();
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|mobile|m|old|new)\./, "");
  if (/(^|\.)reddit\.com$/.test(host)) return (commentRef(u.href) ?? postRef(u.href))?.toLowerCase() ?? `reddit.com${u.pathname.replace(/\/+$/, "")}`;
  // A chat is one address for everything said in it (Telegram names the chat after the #): the spot is the person in that chat,
  // else the first reply in a group would be the last one ever written there.
  if (host === "web.telegram.org" || host === "discord.com") return `${host}${u.pathname.replace(/\/+$/, "").toLowerCase()}${u.hash.toLowerCase()}|${whoKey(who)}`;
  // LinkedIn's comments have no address of their own: everyone under a post shares the post's. The spot is the person
  // answered there (live, 2026-11-14: three people answered their post, the first reply went up and the other two were
  // refused as a second reply to the same post).
  // One post has several addresses there (/posts/…-share-<id>, /feed/update/urn:li:share:<id>): its long number names it.
  const linked = host === "linkedin.com" ? /\d{15,}/.exec(decodeURIComponent(u.pathname))?.[0] : null;
  if (host === "linkedin.com" && who?.trim()) return `${host}${linked ? `/${linked}` : u.pathname.replace(/\/+$/, "").toLowerCase()}|${whoKey(who)}`;
  if (linked) return `${host}/${linked}`;
  const x = host === "x.com" || host === "twitter.com" ? /\/status(?:es)?\/(\d+)/.exec(u.pathname)?.[1] : null;
  if (x) return `x.com/status/${x}`;
  // A video is named by its query. Live, 2026-11-01: every YouTube video was youtube.com/watch, and a comment under
  // one refused a comment under another as a second reply.
  const video = host === "youtube.com" ? (u.searchParams.get("v") ?? /^\/shorts\/([\w-]+)/.exec(u.pathname)?.[1]) : host === "youtu.be" ? u.pathname.split("/")[1] : null;
  if (video) return `youtube.com/watch?v=${video}`;
  // So is a post on a site that numbers them in the query (Hacker News' item?id=, Facebook's story_fbid=); any other query is how it was reached.
  const id = ["id", "story_fbid"].find((k) => u.searchParams.get(k));
  return `${host}${u.pathname.replace(/\/+$/, "").toLowerCase()}${id ? `?${id}=${u.searchParams.get(id)}` : ""}`;
}

/**
 * Whether an address is a list of posts (their notifications, a search, a feed) and not one post. A reply or a like needs
 * the post's own page: a row in a list shows nothing of what is under it, their own answer included, and every row
 * shares the list's address, so one reply per post cannot hold. Live, 2026-11-05: a reply stopped on Md Sikandar's post,
 * since they had answered it, was drafted again on x.com/notifications/mentions and went up from its row.
 */
export function listPage(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const path = u.pathname.replace(/\/+$/, "").toLowerCase();
  if (!path && !u.hash) return Boolean(platformOf(url));
  return /^\/(notifications|search|explore)(\/|$)|^\/(activity|home|results|foryou|following|feed)$/.test(path);
}

/** Said when a reply or a like is given a list's address. */
export const NOT_A_POST =
  "That address is a list, not the post. A row there shows nothing of what is under the post, the customer's own answer included. Give the post's own address: the note's link, or open the post from its row.";

/** What already answered a post or comment: a reply of theirs that went up, may have, or is going up. */
export interface EarlierReply {
  readonly id: string;
  readonly at: Date;
  readonly words: string;
  /** Up for sure, or held as uncertain, or going up now; or theirs, answered by hand, which stopped this one. */
  readonly state: "posted" | "uncertain" | "posting" | "theirs";
}

/** Their replies, from drafts and finds, that went up, may have, or are going up, by where each went. */
export function earlierReplies(drafts: readonly Draft[], finds: readonly Find[]): Map<string, EarlierReply> {
  const out = new Map<string, EarlierReply>();
  const add = (spot: string | null, r: EarlierReply): void => {
    if (spot && !out.has(spot)) out.set(spot, r);
  };
  for (const d of drafts) {
    const state = d.answeredAt ? "theirs" : d.status === "posted" || d.status === "uncertain" || d.status === "posting" ? d.status : null;
    if (d.kind !== "reply" || !state) continue;
    add(replySpot(d.url, d.platform === "reddit" ? d.target : null, d.target), { id: d.id, at: d.sentAt ?? d.decidedAt ?? d.createdAt, words: d.text, state });
  }
  for (const f of finds) {
    // "replied" is a reply that went up, by Quest or by their own hand ("I replied").
    const state = f.status === "replied" ? "posted" : f.postState === "uncertain" ? "uncertain" : f.postState === "posting" ? "posting" : null;
    if (!state) continue;
    add(replySpot(f.url, f.replyTo ?? postRef(f.url)), { id: f.id, at: f.sentAt ?? f.decidedAt ?? f.createdAt, words: f.reply, state });
  }
  return out;
}

/**
 * Why a second reply under the same post or comment is refused: the site may hide or take down the first, or
 * show it only further down, but it is still theirs, and a second one under it reads as spam. Live, 2026-10-19:
 * a reply to @MakerOne went up on 10-18, the manager opened the post the next morning, did not see it, and a
 * second one in other words went up by itself; the same day two went up under @MakerTwo's post within an hour.
 */
export function secondReply(earlier: EarlierReply): string {
  const day = earlier.at.toISOString().slice(0, 10);
  if (earlier.state === "theirs") return `They answered there themselves, by hand (seen on ${day}, when this reply stopped): "${earlier.words.slice(0, 160)}" never went up, and none is needed. The thread is theirs: leave it, and do not offer it again.`;
  const what =
    earlier.state === "posted"
      ? `They already replied there on ${day}`
      : earlier.state === "uncertain"
        ? `A reply of theirs there from ${day} may have gone up (held: verify_sent_draft, never a new one)`
        : "A reply of theirs is going up there right now";
  return `${what}: "${earlier.words.slice(0, 160)}". One reply per post or comment, whatever the words. If you can't see it, the site may hide it or have taken it down, and a second one reads as spam. Leave it; answer only someone who answers them.`;
}
