import type { Draft } from "@mq/core";
import { LIMIT_WORDS, limitKind, OTHER_SITE, platformOf, PLATFORMS, type DayLimits, type LimitKind, type Platform } from "../platforms.ts";

/** The platform a draft goes up on, for its limits: one Quest knows, else every other site's. */
export const draftPlatform = (d: Pick<Draft, "platform" | "url">): Platform => platformOf(d.platform) ?? platformOf(d.url) ?? OTHER_SITE;

type Sent = Pick<Draft, "kind" | "platform" | "url">;

/** How many of each limited kind went up on a platform among these. */
function used(p: Platform, sent: readonly Sent[]): DayLimits {
  const count = (kind: LimitKind) => sent.filter((d) => limitKind(d.kind) === kind && draftPlatform(d).key === p.key).length;
  return { posts: count("posts"), messages: count("messages"), actions: count("actions"), profile: count("profile") };
}

/**
 * Why this draft may not go up now, in the words a tap is answered with; null when it may. `sentToday` is what
 * went up in the last day. A reply or a comment has no limit.
 */
export function dayLimit(draft: Sent, sentToday: readonly Sent[]): string | null {
  const kind = limitKind(draft.kind);
  if (!kind) return null;
  const p = draftPlatform(draft);
  const max = p.limits[kind];
  if (max === 0) return `Quest does no ${LIMIT_WORDS[kind].many} on ${p.name}`;
  if (draft.kind === "follow" && p.follows !== undefined && sentToday.filter((d) => d.kind === "follow" && draftPlatform(d).key === p.key).length >= p.follows)
    return `That's ${p.follows} ${p.key === "linkedin" ? "connection requests" : "follows"} on ${p.name} today, its limit. Tap again tomorrow`;
  if (used(p, sentToday)[kind] < max) return null;
  const which = max === 1 ? LIMIT_WORDS[kind].one : LIMIT_WORDS[kind].many;
  return kind === "posts" || kind === "messages"
    ? `That's ${max} ${which} on ${p.name} today, its limit. Post this one yourself, or tap again tomorrow`
    : `That's ${max} ${which} on ${p.name} today, its limit. Tap again tomorrow`;
}

/**
 * When the day's limit has room for this one again: a day after the send that fills the slot it waits for (what waits
 * in line counts as going now). Null when the platform takes none of its kind at all. The founder, 2026-11-15: "If I hit
 * a limit for posts, it should schedule it instead of blocking it".
 */
export function limitFreesAt(draft: Sent, sentToday: readonly (Sent & { readonly sentAt?: Date | null })[], now: Date): Date | null {
  const kind = limitKind(draft.kind);
  if (!kind) return now;
  const p = draftPlatform(draft);
  const follows = draft.kind === "follow" && p.follows !== undefined;
  const max = follows ? p.follows! : p.limits[kind];
  if (max <= 0) return null;
  const same = sentToday.filter((d) => draftPlatform(d).key === p.key && (follows ? d.kind === "follow" : limitKind(d.kind) === kind));
  const times = same.map((d) => d.sentAt?.getTime() ?? now.getTime()).sort((a, b) => a - b);
  if (times.length < max) return now;
  // The (n - max + 1)th oldest leaves the window last of those that must leave; a few minutes after, so it is surely out.
  return new Date((times[times.length - max] ?? now.getTime()) + 86_400_000 + 5 * 60_000);
}

/** One platform's limits and what went up there in the last day, for their page. */
export interface PlatformDay {
  readonly key: string;
  readonly name: string;
  readonly limits: DayLimits;
  readonly used: DayLimits;
}

/** The platforms the page shows first, whatever they used: where most of their people are. */
const SHOWN = ["reddit", "x", "linkedin", "instagram", "facebook", "threads", "tiktok", "youtube", "email"];

/**
 * Every platform's day limits for their page: the common ones, then any other they posted on or picked, in that
 * order, and every other site's last.
 */
export function limitsPage(sentToday: readonly Sent[], picked: readonly string[] = []): PlatformDay[] {
  const keys = [...new Set([...SHOWN, ...picked, ...sentToday.map((d) => draftPlatform(d).key)])].filter((k) => k !== OTHER_SITE.key);
  const platforms = keys.map((k) => PLATFORMS.find((p) => p.key === k)).filter((p): p is Platform => Boolean(p));
  return [...platforms, OTHER_SITE].map((p) => ({ key: p.key, name: p.name, limits: p.limits, used: used(p, sentToday) }));
}
