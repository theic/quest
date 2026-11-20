import type { PageLink as Link } from "./chrome.ts";

/**
 * Which pages a person opens off a landing page to learn what a company sells.
 * Carried over from v1's site reader, where these were the pages its scout was
 * measured choosing; the terms page is avoided on purpose (a scout once turned
 * one into a description of who to answer).
 */
const WANT =
  /(pricing|prices?|plans?|product|features?|how[-_ ]?it[-_ ]?works|about|use[-_ ]?cases?|solutions?|customers?|faq|why|services?|what[-_ ]?we[-_ ]?do|for[-_ ])/i;
const AVOID =
  /(log[-_ ]?in|sign[-_ ]?(in|up|on)|register|account|checkout|cart|terms|privacy|cookie|legal|refund|policy|gdpr|imprint|careers|jobs|press|status|\/blog\/.+|\.(pdf|png|jpe?g|gif|svg|zip|mp4)$)/i;

const bareHost = (host: string): string => host.toLowerCase().replace(/^www\./, "");
const trimSlash = (path: string): string => path.replace(/\/+$/, "");

/** Up to `max` same-site pages worth reading next, best first. */
export function pickFollowUps(base: string, links: readonly Link[], max: number): string[] {
  if (max <= 0) return [];
  let at: URL;
  try {
    at = new URL(base);
  } catch {
    return [];
  }
  const host = bareHost(at.host);
  const best = new Map<string, { href: string; path: string; score: number }>();
  for (const link of links) {
    let u: URL;
    try {
      u = new URL(link.href, at);
    } catch {
      continue;
    }
    u.hash = "";
    if (!/^https?:$/.test(u.protocol) || bareHost(u.host) !== host) continue;
    if (trimSlash(u.pathname) === trimSlash(at.pathname) || AVOID.test(u.pathname)) continue;
    const text = link.text.replace(/\s+/g, " ").trim().slice(0, 80);
    const score = (WANT.test(u.pathname) ? 2 : 0) + (WANT.test(text) ? 1 : 0);
    if (!score) continue;
    const had = best.get(u.href);
    if (!had || had.score < score) best.set(u.href, { href: u.href, path: u.pathname, score });
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    .slice(0, max)
    .map((x) => x.href);
}
