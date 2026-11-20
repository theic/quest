import type { FoundPost, PostQuery, SearchRecord } from "@mq/core";
import type { SearchPacing } from "./search-tools.ts";
import { SOURCE_SITES } from "./site-pin.ts";

/**
 * When a run stops searching: after a few searches in a row that turned up nobody new, not at a step cap. Live,
 * 2026-10-31: six outreach runs on X took 29 to 46 steps for 13 drafts, most of them searching and scrolling after
 * the people were found. A search the record says found nobody (`mq.searches`, the last 30 days) is not run again.
 */
export const EMPTY_IN_A_ROW = 3;
/**
 * Empty searches a run makes in all, across its sites and plays: in a row counts each site and play apart (live,
 * 2026-11-01, a run for 12 founders on five sites found 3 on X, then every find_people on Reddit, LinkedIn and YouTube
 * stopped before searching, on X's count), so a run that keeps rewording a play still stops.
 */
export const EMPTY_IN_A_RUN = 40;

/** How a search is known in `mq.searches`: its site and its words, as the trail keeps them. */
export const searchKey = (source: string, query: string, site?: string): string =>
  `${SOURCE_SITES[source] ?? source}|${`${query.trim()}${site ? ` (site: ${site})` : ""}`.toLowerCase()}`;

/** The searches that found nobody in every run that tried them. */
export function foundNobody(records: readonly SearchRecord[]): Set<string> {
  const hits = new Map<string, number>();
  for (const r of records) {
    const key = `${r.site}|${r.query.toLowerCase()}`;
    hits.set(key, (hits.get(key) ?? 0) + r.hits);
  }
  return new Set([...hits].filter(([, n]) => n === 0).map(([key]) => key));
}

/**
 * One run's searches, whoever runs them (search_posts, or find_people's searches by code). Searching for one lane is
 * over after a few in a row turned up nobody new; a lane is a site (search_posts) or a site and a play (find_people).
 */
export class SearchStreak implements SearchPacing {
  readonly #nobody: () => Promise<ReadonlySet<string>>;
  #loaded: Promise<ReadonlySet<string>> | null = null;
  readonly #empty = new Map<string, number>();
  #emptyAll = 0;
  readonly #seen = new Set<string>();

  /** `nobody`: the searches the record says found nobody, read once, when the run first searches. */
  constructor(nobody: () => Promise<ReadonlySet<string>> = async () => new Set()) {
    this.#nobody = nobody;
  }

  /** Whether searching this lane is over: its last few turned up nobody new, or the run's empty searches ran out. */
  spent(lane: string, inARow = EMPTY_IN_A_ROW): boolean {
    return (this.#empty.get(lane) ?? 0) >= inARow || this.#emptyAll >= EMPTY_IN_A_RUN;
  }

  /** Whether the record says this search found nobody before. */
  async triedBefore(q: Pick<PostQuery, "source" | "query" | "site">): Promise<boolean> {
    this.#loaded ??= this.#nobody().catch(() => new Set<string>());
    return (await this.#loaded).has(searchKey(q.source, q.query, q.site));
  }

  /** A search's outcome in its lane: whether it turned up anyone new. */
  turnedUp(lane: string, anyone: boolean): void {
    this.#empty.set(lane, anyone ? 0 : (this.#empty.get(lane) ?? 0) + 1);
    if (!anyone) this.#emptyAll++;
  }

  /** Posts not seen before in this run: the rest are counted as seen now. */
  fresh(posts: readonly FoundPost[]): FoundPost[] {
    const out = posts.filter((p) => !this.#seen.has(p.url));
    for (const p of out) this.#seen.add(p.url);
    return out;
  }

  async take(q: PostQuery): Promise<string | null> {
    if (this.spent(q.source)) return `No more searches on ${q.source} in this run: its last ${EMPTY_IN_A_ROW} turned up nobody new. Work the people you have, then write your report.`;
    if (await this.triedBefore(q)) return `Not searched: "${q.query}" on ${q.source} found nobody for them before. Use other words, or work the people you have.`;
    return null;
  }

  after(found: readonly FoundPost[], q: Pick<PostQuery, "source">): string | null {
    this.turnedUp(q.source, this.fresh(found).length > 0);
    return this.spent(q.source) ? `That makes ${EMPTY_IN_A_ROW} searches in a row on ${q.source} with nobody new: no more searching there in this run. Work the people you have, then write your report.` : null;
  }
}
