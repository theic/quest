import type { CustomerId, FindId, TaskId } from "./ids.ts";

/**
 * A person the scout found asking, in public, for what the customer offers. The
 * customer decides on each one. Quest posts a reply from their own account in
 * their own Chrome: when they tap "Post it", or, for a strong find, by itself once
 * they trust it on that platform (trust.ts).
 *
 *   new ──show──▶ shown ──▶ kept | replied (by hand, or posted)
 *                   └────▶ skipped (with a reason, when they give one)
 */
export type FindStatus = "new" | "shown" | "kept" | "skipped" | "replied";
export type FindStrength = "strong" | "maybe";
export type FindDecision = "kept" | "skipped" | "replied";

export const SKIP_REASONS = ["not_my_buyer", "off_topic", "too_old", "other"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const SKIP_REASON_WORDS: Readonly<Record<SkipReason, string>> = {
  not_my_buyer: "Not a fit",
  off_topic: "Off topic",
  too_old: "Too old",
  other: "Other",
};

export interface Find {
  readonly id: FindId;
  readonly customerId: CustomerId;
  readonly taskId: TaskId | null;
  /** Where it was found: "hackernews", "stackexchange:webmasters", "web"… */
  readonly source: string;
  readonly url: string;
  readonly author: string | null;
  readonly title: string | null;
  /** The person's own words, as they appear on the page. */
  readonly quote: string;
  readonly postedAt: Date | null;
  /** Why this person fits the customer, in a sentence. */
  readonly why: string;
  /** A reply the customer could post, written from the brief. */
  readonly reply: string;
  readonly strength: FindStrength;
  /** What the reply answers in native ids ("t1_…" on Reddit); other sites can use the observed URL/quote. */
  readonly replyTo: string | null;
  readonly status: FindStatus;
  readonly skipReason: SkipReason | null;
  /** The chat message that carries the find's card. */
  readonly cardRef: string | null;
  readonly createdAt: Date;
  readonly shownAt: Date | null;
  readonly decidedAt: Date | null;
  /** Where the reply went up when Quest posted it, and as whom. */
  readonly sentUrl: string | null;
  readonly sentAs: string | null;
  readonly sentAt: Date | null;
  /** It went up without a tap. */
  readonly sentAlone: boolean;
  /** Durable sending state, independent of the customer's Keep/Skip decision. */
  readonly postState?: "open" | "posting" | "uncertain" | "posted";
  /** On its card only: its reply waits in the outbox for their Chrome (outbox.ts). */
  readonly waiting?: boolean;
}

export interface NewFind {
  readonly customerId: CustomerId;
  readonly taskId: TaskId | null;
  readonly source: string;
  readonly url: string;
  readonly author: string | null;
  readonly title: string | null;
  readonly quote: string;
  readonly postedAt: Date | null;
  readonly why: string;
  readonly reply: string;
  readonly strength: FindStrength;
  readonly replyTo?: string | null;
}

export type FindCounts = Readonly<Record<FindStatus, number>>;

/** A reply Quest posted on the customer's tap, which it looks at again for answers. */
export interface WatchedFind {
  readonly find: Find;
  /** Looks taken so far. */
  readonly checks: number;
  /** The replies already told, by the platform's ids, so none is told twice. */
  readonly seen: readonly string[];
}

/** What a customer can do on a card: decide, say why they skipped, or have Quest post the reply as them. */
export type FindAction =
  | { readonly kind: "decide"; readonly decision: FindDecision }
  | { readonly kind: "reason"; readonly reason: SkipReason }
  | { readonly kind: "post" }
  | { readonly kind: "retry_post" }
  | { readonly kind: "edit" };

/** The name a person would use for a source. */
export function sourceLabel(source: string, url: string): string {
  const [name, sub] = source.split(":", 2);
  switch (name) {
    case "hackernews":
      return "Hacker News";
    case "stackexchange":
      return sub ? `Stack Exchange (${sub})` : "Stack Exchange";
    case "bluesky":
      return "Bluesky";
    case "lemmy":
      return sub ? `Lemmy (${sub})` : "Lemmy";
    case "github":
      return "GitHub";
    case "mastodon":
      return sub ? `Mastodon ${sub}` : "Mastodon";
    case "reddit":
      return sub ? `Reddit (${sub})` : "Reddit";
    default:
      try {
        return new URL(url).hostname.replace(/^www\./, "");
      } catch {
        return name ?? source;
      }
  }
}
