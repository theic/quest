import type { CustomerId, DraftId, TaskId } from "./ids.ts";

/**
 * Something Quest does as the customer, shown as a card with a button: a reply under someone's post or comment
 * (with a short quote of what they said), a new post in a community, a private message to a person, a like on a
 * post, a follow of a person, or new words on their own profile (a bio). It goes from their own account, in their
 * own Chrome: on their tap, or by itself once they trust Quest with that kind of thing on that platform (trust.ts).
 *
 *   open ──Post (or by itself)──▶ posted
 *     ├───Edit: their words or a note rewrite it in place
 *     └───Skip──▶ skipped
 */
export type DraftKind = "reply" | "post" | "message" | "like" | "follow" | "profile";

/** Every kind, for what is counted and reset per kind. */
export const DRAFT_KINDS: readonly DraftKind[] = ["reply", "post", "message", "like", "follow", "profile"];

/** Kinds that put no words of theirs anywhere: one tap on the page's own control. */
export const WORDLESS: ReadonlySet<DraftKind> = new Set<DraftKind>(["like", "follow"]);

/** Kinds the browser does on any site, Reddit included: Reddit's own forms take only replies, posts and messages. */
export const BROWSER_ONLY: ReadonlySet<DraftKind> = new Set<DraftKind>(["like", "follow", "profile"]);
export type DraftStatus = "open" | "posting" | "uncertain" | "posted" | "skipped";
export type DraftAction = "post" | "skip" | "edit" | "retry";

export interface Draft {
  readonly id: DraftId;
  readonly customerId: CustomerId;
  readonly kind: DraftKind;
  /** Reddit, or the host of any forum, community, messenger or email workspace. */
  readonly platform: string;
  /**
   * The page it belongs to: the post or comment a reply answers, the community a post goes to,
   * the person's post (or profile) a message is about.
   */
  readonly url: string;
  /** Where it goes, in the platform's terms: the "t3_…"/"t1_…" a reply goes under, the community, or the person. */
  readonly target: string;
  /** A post's title, or a message's subject. */
  readonly title: string | null;
  /** Whose words the quote is, or who the message is for. */
  readonly author: string | null;
  /** Their words, short, when it answers someone. */
  readonly quote: string | null;
  readonly text: string;
  readonly status: DraftStatus;
  readonly cardRef: string | null;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
  readonly sentUrl: string | null;
  readonly sentAs: string | null;
  readonly sentAt: Date | null;
  /** It went up without a tap. */
  readonly alone: boolean;
  /** Nothing went up: the page showed they had answered there themselves. */
  readonly answeredAt?: Date;
  /** Their pictures (or other assets) it goes up with, attached in their Chrome (ideas.ts). */
  readonly assets?: readonly string[];
  /** On its card only: it waits in the outbox for their Chrome (outbox.ts). */
  readonly waiting?: boolean;
}

/** A posted reply or post Quest looks at again for answers. */
export interface WatchedDraft {
  readonly draft: Draft;
  /** Looks taken so far. */
  readonly checks: number;
  /** The answers already told, by the platform's ids, so none is told twice. */
  readonly seen: readonly string[];
}

/** The answers already told for something that went up, and where it went. */
export interface ToldAnswers {
  readonly url: string;
  readonly seen: readonly string[];
}

export interface NewDraft {
  readonly customerId: CustomerId;
  readonly kind: DraftKind;
  readonly platform: string;
  readonly url: string;
  readonly target: string;
  readonly title: string | null;
  readonly author: string | null;
  readonly quote: string | null;
  readonly text: string;
  readonly assets?: readonly string[];
  /** The teammate's run that drafted it, so an experiment counts what its run drafted. */
  readonly taskId?: TaskId | null;
}

/** Whether a draft's target is only a web address: the card's link already says it. */
export const isAddress = (target: string): boolean => /^https?:\/\//i.test(target.trim());

/**
 * What a draft is, in a few words: "your reply to u/dana", "your post in r/nocode", "your message to u/dana".
 * A target that is only the page's address is left out ("your reply on habr.com"), so it isn't said twice,
 * and so is the account a post goes up from: "your post in @dana_builds on x.com" read as somewhere else.
 */
export function draftLabel(d: Pick<Draft, "kind" | "target" | "author"> & { readonly platform?: string }): string {
  const on = d.platform === "reddit" ? "Reddit" : (d.platform ?? "the site");
  switch (d.kind) {
    case "like":
      return `your like on ${d.author ? `${d.author}'s post` : "a post"} on ${on}`;
    case "follow":
      return `your follow of ${d.author ?? (isAddress(d.target) ? "them" : d.target)} on ${on}`;
    case "profile":
      return isAddress(d.target) ? `your profile on ${on}` : `your profile's ${d.target} on ${on}`;
  }
  if (d.platform && d.platform !== "reddit") {
    const whom = d.author ?? (isAddress(d.target) || (d.kind === "post" && d.target.trim().startsWith("@")) ? null : d.target);
    return whom ? `your ${d.kind} ${d.kind === "post" ? "in" : "to"} ${whom} on ${d.platform}` : `your ${d.kind} on ${d.platform}`;
  }
  switch (d.kind) {
    case "reply":
      return `your reply to ${d.author ? `u/${d.author.replace(/^u\//i, "")}` : "that post"}`;
    case "post":
      return `your post in r/${d.target.replace(/^r\//i, "")}`;
    case "message":
      return `your message to u/${d.target.replace(/^u\//i, "")}`;
  }
}
