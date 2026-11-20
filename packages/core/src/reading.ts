import type { FoundPost } from "./posts.ts";

/** Who wrote a page that is one person's post (a Reddit thread), when the page says. */
export interface PostMeta {
  /** Where it was posted, e.g. "reddit:r/SaaS". */
  readonly source: string;
  readonly author: string | null;
  readonly title: string | null;
  readonly postedAt: Date | null;
  /** The platform's own id for the post ("t3_…" on Reddit), for a reply to go under it. */
  readonly ref?: string | null;
  /** When the post shows no words: the page's own line saying it was removed or deleted, if it has one. */
  readonly notice?: string | null;
  /** When the post shows no words: the start of the page as it reads, to tell a removed post from a link post. */
  readonly bare?: string;
}

/** One page as a person would read it: its title, its words, and what it links to. */
export interface PageText {
  readonly url: string;
  readonly title: string;
  readonly description: string | null;
  readonly text: string;
  /** Set when the page is one person's post and the reader knows whose. */
  readonly post?: PostMeta;
  /** The comments under that post, each by its own person: a find may be one of them, not the post. */
  readonly comments?: readonly PageComment[];
  /** Set when the page is a search or a listing that code cut into posts (`text` is then those posts). */
  readonly posts?: readonly FoundPost[];
  /** The customer's own name on the site, when the page shows whom it is read as (X's link to their profile). */
  readonly account?: string | null;
  /** Comments the page shows as deleted or removed (nobody else can read them), by their ids. */
  readonly gone?: readonly string[];
}

export interface PageComment {
  readonly author: string | null;
  readonly postedAt: Date | null;
  readonly text: string;
  /** The platform's own id for the comment ("t1_…" on Reddit), for a reply to go under it. */
  readonly ref?: string | null;
  /** The comment it answers, by the same ids; null for one that answers the post. */
  readonly parentRef?: string | null;
}

export interface SiteRead {
  readonly pages: readonly PageText[];
}

export type ReadFailure = "invalid_url" | "blocked" | "not_found" | "timeout" | "unavailable" | "offline" | "hidden" | "limit";

/** A read that could not happen, with a reason the agent can act on. */
export class ReadError extends Error {
  readonly reason: ReadFailure;
  constructor(reason: ReadFailure, message: string) {
    super(message);
    this.name = "ReadError";
    this.reason = reason;
  }
}

const READ_FAILURES: ReadonlySet<string> = new Set<ReadFailure>(["invalid_url", "blocked", "not_found", "timeout", "unavailable", "offline", "hidden", "limit"]);

export const isReadFailure = (s: string): s is ReadFailure => READ_FAILURES.has(s);
