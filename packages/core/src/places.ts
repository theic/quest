import type { CustomerId } from "./ids.ts";

/**
 * Where a customer's people ask, as the explorer found it: a community, a forum,
 * a board. Each carries what its rules say about a message like the customer's:
 *   search  the scout searches it first
 *   avoid   its rules forbid such messages: nothing found there is saved
 *   login   access is pending; the customer signs in before the browser can inspect it
 */
export const PLACE_VERDICTS = ["search", "avoid", "login"] as const;
export type PlaceVerdict = (typeof PLACE_VERDICTS)[number];

export interface Place {
  readonly customerId: CustomerId;
  /** One spelling per place: "reddit:r/nocode", or a site's host ("community.shopify.com"). */
  readonly key: string;
  /** What a person calls it: "r/nocode", "Shopify Community". */
  readonly name: string;
  readonly url: string;
  readonly verdict: PlaceVerdict;
  /** What its rules say about promotion or offers, in a line; null when they could not be read. */
  readonly rules: string | null;
  /** Why the customer's people are there. */
  readonly why: string;
  readonly foundAt: Date;
  readonly updatedAt: Date;
}

export type NewPlace = Omit<Place, "foundAt" | "updatedAt">;

/**
 * The key a place is filed under, from any address in it: a Reddit community by
 * its name (any thread in r/NoCode is in "reddit:r/nocode"), anything else by its
 * host. Null for what is not a web address.
 */
export function placeKey(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|old|new|m)\./, "");
  if (host === "reddit.com") {
    const name = /^\/r\/([A-Za-z0-9_]{2,21})/.exec(url.pathname)?.[1];
    if (name) return `reddit:r/${name.toLowerCase()}`;
    // Reddit as a whole ("No Reddit today please", live 2026-10-08): its front page, never a thread or a profile.
    return url.pathname.replace(/\/+$/, "") === "" ? REDDIT : null;
  }
  return host || null;
}

/** The key all of Reddit is filed under: a hold on it covers every community. */
export const REDDIT = "reddit.com";

/**
 * Every key that rules an address: its own place, and the platform around it (a thread in r/NoCode is
 * held by "reddit:r/nocode" and by a hold on all of Reddit). Empty for what is not a web address.
 */
export function placeKeys(raw: string): string[] {
  const key = placeKey(raw);
  if (!key) return /^https?:\/\/(www\.|old\.|new\.|m\.)?reddit\.com\//i.test(raw) ? [REDDIT] : [];
  return key.startsWith("reddit:") ? [key, REDDIT] : [key];
}
