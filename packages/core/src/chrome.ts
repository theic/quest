import type { DraftKind } from "./drafts.ts";
import type { AssetFile } from "./ideas.ts";
import type { CustomerId } from "./ids.ts";

/**
 * The customer's own Chrome, with the Messaging Quest extension: where Quest
 * reads and works for them in a tab group of its own, using their existing profile and logins,
 * at a reader's pace. Outgoing work uses the recorded draft/find publishing boundary.
 */

/**
 * Rows to take from a page: `items` is a selector (matched through shadow
 * roots); each field says where its value is:
 *   `attr:<name>`           an attribute of the item
 *   `attr:<name>@<sel>`     an attribute of its first descendant matching <sel>
 *   `text:<sel>` / `text`   the trimmed text of a descendant / of the item
 *   `href:<sel>` / `href`   the absolute address a descendant / the item links to
 *   `a|b`                   the first of several that answers
 * Platform knowledge lives in these specs, on the agent's side; the extension
 * only executes them.
 */
export interface DomSpec {
  readonly items: string;
  readonly limit?: number;
  readonly fields: Readonly<Record<string, string>>;
}

/** What to take from the page once it has loaded. */
export interface PageTake {
  /** The page's readable text, clipped. */
  readonly text?: boolean;
  /** Up to 300 links with their words. */
  readonly links?: boolean;
  readonly specs?: Readonly<Record<string, DomSpec>>;
}

/** One page for the extension to open and read. */
export interface ChromeJob {
  readonly url: string;
  readonly take: PageTake;
  /** Wait for this selector (through shadow roots) before reading, up to `settleMs`. */
  readonly waitFor?: string;
  readonly settleMs?: number;
  /** A feed: scroll this many screens down before reading, so it draws more than its first rows (extension 0.12.10). */
  readonly more?: number;
  /** The page only renders while Chrome draws it (Reddit's new pages): the window must be on screen. */
  readonly drawn?: boolean;
  /**
   * Read as someone who is not logged in (no cookies sent or kept), to see what others see. Logged in,
   * a site shows the customer their own removed comment as if nothing happened (measured 2026-10-03).
   */
  readonly asVisitor?: boolean;
  /** A look at the customer's own post: counted apart from the day's reading, so searching cannot spend it. */
  readonly check?: boolean;
}

export interface PageLink {
  readonly href: string;
  readonly text: string;
}

/** What the extension read. */
export interface ChromeRead {
  /** Where the tab ended up, after redirects. */
  readonly url: string;
  /** The page's HTTP status, when Chrome reported one. */
  readonly status: number | null;
  readonly title: string;
  readonly description: string | null;
  readonly text: string;
  readonly links: readonly PageLink[];
  readonly rows: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  /** Whether Chrome was drawing the page when it was read. */
  readonly visible: boolean;
}

/**
 * Something the customer tapped "Post it" on, to post from their own account in
 * their own Chrome, where they are signed in. Only ever sent for that tap:
 * - a reply (no `kind`, as before posts and messages existed) under a post or comment;
 * - a new post in a community;
 * - a private message to a person.
 */
export type ChromePost =
  | {
      readonly platform: "browser";
      readonly kind: DraftKind;
      readonly url: string;
      readonly target: string;
      readonly quote?: string | null;
      readonly author?: string | null;
      readonly title: string | null;
      readonly text: string;
      /** What already went up from their account to this person: seen on the page under the words answered, the send stops. */
      readonly before?: readonly string[];
      /** Their pictures (or files) it goes up with, attached in the composer before it is sent. */
      readonly files?: readonly AssetFile[];
    }
  | {
      readonly platform: "reddit";
      readonly kind?: "reply";
      /** The thread it goes under, for the link back. */
      readonly url: string;
      /** What it answers, in the platform's own ids: Reddit's post ("t3_…") or comment ("t1_…"). */
      readonly parent: string;
      readonly text: string;
    }
  | {
      readonly platform: "reddit";
      readonly kind: "post";
      /** The community's page, for the link back. */
      readonly url: string;
      /** The community's name, without "r/". */
      readonly community: string;
      readonly title: string;
      readonly text: string;
    }
  | {
      readonly platform: "reddit";
      readonly kind: "message";
      /** The page the message is about, for the link back. */
      readonly url: string;
      /** The person's name, without "u/". */
      readonly to: string;
      readonly subject: string;
      readonly text: string;
    };

/** Where the posted reply is now, and the account it went out as. */
export interface ChromePosted {
  readonly url: string;
  readonly account: string;
}

export type ChromeFailure =
  | "offline" // the extension is not connected right now
  | "invalid_url"
  | "blocked" // the site refused, or the address is not public
  | "not_found"
  | "timeout"
  | "hidden" // the page needed drawing, and their Chrome window is minimised or covered
  | "limit" // the extension's daily reading allowance is spent
  | "login" // posting: this Chrome is not signed in to the site
  | "rate_limited" // posting: the site says to wait before posting again
  | "refused" // posting: the site did not take the reply, and said why
  | "outdated" // the extension is older than the job it was given
  | "uncertain" // a send was attempted, but its result must be inspected before any retry
  | "gone" // posting: the page says it can never go up (comments off, the post deleted); nothing was sent
  | "too_long" // posting: the words are longer than the field they go in takes; nothing was typed
  | "unavailable";

export class ChromeError extends Error {
  readonly reason: ChromeFailure;
  constructor(reason: ChromeFailure, message: string) {
    super(message);
    this.name = "ChromeError";
    this.reason = reason;
  }
}

/** The words are longer than the field they go in takes (X's profile bio: 160 characters). Nothing was typed. */
export class TooLong extends ChromeError {
  readonly limit: number;
  readonly length: number;
  constructor(limit: number, length: number) {
    super("too_long", `The field takes at most ${limit} characters, and the words have ${length}. Nothing was typed.`);
    this.limit = limit;
    this.length = length;
  }
}

/**
 * A reply to what they already answered themselves: the page shows their own reply under it (by hand, or from their
 * phone). Nothing was typed. Live, 2026-11-04: Theo's answer on X, already answered by hand two days before, read off
 * their notifications and drafted again.
 */
export class AlreadyAnswered extends ChromeError {
  readonly words: string;
  constructor(words: string) {
    super("unavailable", `They already answered there ("${words.slice(0, 120)}"). Nothing was sent.`);
    this.words = words;
  }
}

/**
 * The site takes no more of this for now, and says so: a limit that passes by itself, nothing sent. Live, 2026-11-06:
 * Threads' "You can't send any more message requests today" read as a failed post, and two messages asked for a tap again.
 */
export class SiteLimit extends ChromeError {
  constructor(why: string) {
    super("rate_limited", why);
  }
}

/** How a customer's Chrome stands, for the manager and the gate on tasks. */
export interface ChromeStatus {
  /** They connected a Chrome and have not disconnected it. */
  readonly linked: boolean;
  /** The extension is asking for work right now (Chrome is open and awake). */
  readonly online: boolean;
  /** "Chrome 141 on Windows". */
  readonly device: string | null;
  readonly lastSeenAt: Date | null;
  /** Not connected yet: when the setup went out, while it is too soon to send it again (half a day). */
  readonly offeredAt?: Date;
  /** Reads in the last day that failed because their Chrome window was minimised or covered; absent when none. */
  readonly hidden?: { readonly count: number; readonly last: Date };
}

/** A connected Chrome, as the agent's API sees it. */
export interface ChromeLink {
  readonly id: string;
  readonly customerId: CustomerId;
  readonly device: string | null;
  readonly pairedAt: Date;
  readonly lastSeenAt: Date | null;
}
