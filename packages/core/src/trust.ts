import type { DraftKind } from "./drafts.ts";

/**
 * Quest asks before it does a kind of thing on a platform, until TRUST_AFTER of them were approved on a tap;
 * then it does that kind there by itself. The founder, 2026-10-14: "before switching to autopilot on a specific
 * thing, platform or action, the agent must first ask the user a few times for approvals or edits". Replies,
 * posts and private messages on a site earn it apart (trustKey). "Go ahead" or "ask me first" from them sets
 * it at once, for a host or for all (*); a reply taken down resets it.
 */
export const TRUST_AFTER = 3;

export const postsAlone = (approved: number): boolean => approved >= TRUST_AFTER;

/**
 * What trust is counted on: replies on a platform under its own name; its posts, messages, likes, follows and
 * profile edits apart ("x.com likes"), so a few liked posts never let Quest edit their bio by itself.
 */
export const trustKey = (platform: string, kind: DraftKind = "reply"): string => (kind === "reply" ? platform : `${platform} ${kind}s`);

/**
 * A kind everywhere: "* likes" for "mastodon.social likes", "*" for a site's replies. Their word for a kind on every
 * platform is kept there, so it holds on a site Quest had no name for when they said it (live, 2026-11-11: "do all
 * likes and follows on auto" was written for the sites Quest knew, and each Mastodon server still asked).
 */
export const everywhere = (key: string): string => {
  const kind = / (posts|messages|likes|follows|profiles)$/.exec(key);
  return kind ? `*${kind[0]}` : "*";
};

