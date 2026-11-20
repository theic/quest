import type { CustomerId } from "./ids.ts";

/**
 * A route: one way Quest goes after results ("Reddit replies", "family interpreters in caregiver
 * communities"). Every try is logged as worked, failed or thin. SPENT_AFTER tries in a row that did
 * not work and the route is spent: Quest changes course on its own instead of pushing it, and goes
 * back only with new evidence. Live, 2026-10-06/07: eleven lessons in a row called the same searches
 * "exhausted", each pointing at the next, and the next day Quest proposed the first one again.
 */
export const SPENT_AFTER = 2;

export const ROUTE_RESULTS = ["worked", "failed", "thin"] as const;
export type RouteResult = (typeof ROUTE_RESULTS)[number];
export type RouteStatus = "trying" | "working" | "spent";

export interface Route {
  readonly id: string;
  readonly customerId: CustomerId;
  readonly name: string;
  readonly status: RouteStatus;
  readonly tries: number;
  readonly wins: number;
  /** Tries in a row that did not work. */
  readonly misses: number;
  readonly lastNote: string | null;
  readonly updatedAt: Date;
}

/** A route's name as a key: case and spacing aside. */
export const routeKey = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();

/** The route after one more try. */
export function afterTry(r: Pick<Route, "tries" | "wins" | "misses">, result: RouteResult): Pick<Route, "tries" | "wins" | "misses" | "status"> {
  const worked = result === "worked";
  const misses = worked ? 0 : r.misses + 1;
  return {
    tries: r.tries + 1,
    wins: r.wins + (worked ? 1 : 0),
    misses,
    status: worked ? "working" : misses >= SPENT_AFTER ? "spent" : "trying",
  };
}

/** The platform a posting route is named after, for routes the code logs itself (a reply taken down, an answer). */
export const postingRoute = (platform: string): string => `${platform} posts and replies`;
