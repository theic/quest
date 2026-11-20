import { askKeys, isGroupKind, type Ask, type Draft, type GroupKind } from "@mq/core";

/**
 * Where an ask stands in the line (the founder's order, 2026-10-23: "a real person waiting first, then what goes stale,
 * then setup, then ideas"): someone talking with them; a question the team stopped on; a reply to a post, which goes
 * stale; a post of their own; a send that may have gone up, to look at; a change to their profile; likes and follows;
 * Quest's ideas.
 */
export const TIERS = { person: 0, question: 1, reply: 2, post: 3, check: 4, profile: 5, warm: 6, idea: 7 } as const;

/** Whether someone talks with them already (a conversation on record): their message waits on a person. */
export type Talking = (person: string | null) => boolean;

const held = (status: string | null | undefined): boolean => status === "uncertain";

export function tierOf(a: Ask, talking: Talking): number {
  switch (a.kind) {
    case "question":
      return TIERS.question;
    // Quest's offer to go alone on a platform is a decision of theirs, like the team's questions.
    case "trust":
      return TIERS.question;
    case "idea":
      return TIERS.idea;
    case "group":
      return a.what === "profile" ? TIERS.profile : TIERS.warm;
    case "find":
      if (held(a.find.postState)) return TIERS.check;
      return talking(a.find.author) ? TIERS.person : TIERS.reply;
    case "draft": {
      const d = a.draft;
      if (held(d.status)) return TIERS.check;
      if (d.kind === "message") return TIERS.person;
      if (d.kind === "reply") return talking(d.author) ? TIERS.person : TIERS.reply;
      return d.kind === "post" ? TIERS.post : d.kind === "profile" ? TIERS.profile : TIERS.warm;
    }
  }
}

/** How fresh what it answers is: a find by its post's time, anything else by when it joined. */
const freshness = (a: Ask): number => {
  switch (a.kind) {
    case "find":
      return (a.find.postedAt ?? a.find.shownAt ?? a.find.createdAt).getTime();
    case "draft":
      return a.draft.createdAt.getTime();
    case "question":
      return (a.question.askedAt ?? a.question.createdAt).getTime();
    case "idea":
      return a.idea.createdAt.getTime();
    case "trust":
      return 0;
    case "group":
      return Math.min(...a.drafts.map((d) => d.createdAt.getTime()));
  }
};

/** The group an open like, follow or profile change belongs to, by its key; null for anything else. */
export function groupOf(d: Draft): string | null {
  return d.status === "open" && isGroupKind(d.kind) ? askKeys.group(d.kind, d.platform) : null;
}

/**
 * Likes, or follows, on one platform, or the changes of a profile check there (the founder, 2026-10-29: "one 'profile
 * check' ask per platform ... instead of a stream of field cards"): two or more are one ask, unless they chose to go
 * through that one one by one.
 */
function grouped(asks: readonly Ask[], oneByOne: string | null): Ask[] {
  const groups = new Map<string, Draft[]>();
  for (const a of asks) {
    const key = a.kind === "draft" ? groupOf(a.draft) : null;
    if (!key || a.kind !== "draft") continue;
    groups.set(key, [...(groups.get(key) ?? []), a.draft]);
  }
  const together = new Set([...groups].filter(([key, ds]) => ds.length > 1 && key !== oneByOne).map(([key]) => key));
  const out: Ask[] = [];
  const placed = new Set<string>();
  for (const a of asks) {
    const key = a.kind === "draft" ? groupOf(a.draft) : null;
    if (!key || !together.has(key)) {
      out.push(a);
      continue;
    }
    if (placed.has(key)) continue;
    placed.add(key);
    const drafts = groups.get(key)!;
    out.push({ kind: "group", key, what: drafts[0]!.kind as GroupKind, platform: drafts[0]!.platform, drafts });
  }
  return out;
}

/**
 * The line, first to last: by tier; replies freshest first (a post goes stale), the rest in the order they came.
 * Alike likes and follows are grouped first.
 */
export function rankAsks(asks: readonly Ask[], talking: Talking, oneByOne: string | null = null): Ask[] {
  const all = grouped(asks, oneByOne).map((a) => ({ a, tier: tierOf(a, talking), at: freshness(a) }));
  all.sort((x, y) => x.tier - y.tier || (x.tier === TIERS.reply || x.tier === TIERS.person ? y.at - x.at : x.at - y.at));
  return all.map((x) => x.a);
}
