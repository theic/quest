/** A post someone wrote in a public community: what Quest looks for on a customer's behalf. */
export interface FoundPost {
  /** Which source found it, e.g. "hackernews" or "stackexchange:webmasters". */
  readonly source: string;
  readonly url: string;
  readonly author: string | null;
  readonly title: string | null;
  /** Plain text, clipped. */
  readonly text: string;
  readonly postedAt: Date | null;
  readonly replies: number | null;
  /** A search engine's result, not the post itself: its words are a snippet, so read the page before quoting it. */
  readonly preview?: boolean;
}

export interface PostQuery {
  readonly source: string;
  readonly query: string;
  /** Which community within a source, where the source has several (a Stack Exchange site). */
  readonly site?: string;
  readonly limit?: number;
  /** Only posts from this recent period, where the source can filter by date. */
  readonly within?: "day" | "week" | "month" | "year";
}

/** What a source covers, for the agents choosing where to look. */
export interface SourceInfo {
  readonly name: string;
  readonly covers: string;
  /** How to phrase the query for this source. */
  readonly queryHint: string;
  /** Set when the source needs `site`, with the values it takes. */
  readonly siteHint?: string;
}

export type SearchFailure = "unknown_source" | "bad_query" | "refused" | "rate_limited" | "unavailable" | "offline";

/** A search that could not happen, with a reason the agent can act on. */
export class SearchError extends Error {
  readonly reason: SearchFailure;
  constructor(reason: SearchFailure, message: string) {
    super(message);
    this.name = "SearchError";
    this.reason = reason;
  }
}
