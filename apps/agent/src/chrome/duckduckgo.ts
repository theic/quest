import type { ChromeJob, ChromeRead, DomSpec, FoundPost } from "@mq/core";

/**
 * Web search, in the customer's Chrome, on DuckDuckGo's plain HTML page: one
 * request a search, results in the page itself. Search engines refuse the cloud
 * (FACTS.md); from the customer's own connection they answer as they would them.
 */

const PERIOD: Readonly<Record<string, string>> = { day: "d", week: "w", month: "m", year: "y" };

export function searchUrl(query: string, within: string | undefined): string {
  const df = within ? PERIOD[within] : undefined;
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}${df ? `&df=${df}` : ""}`;
}

const RESULTS: DomSpec = {
  items: "div.result",
  limit: 30,
  fields: { title: "text:a.result__a", href: "href:a.result__a", snippet: "text:.result__snippet", kind: "attr:class" },
};

export const searchJob = (url: string): ChromeJob => ({
  url,
  take: { text: true, specs: { results: RESULTS } },
  waitFor: "div.result, .no-results",
  settleMs: 4_000,
});

/** DuckDuckGo's check for automated searches, instead of results. */
export const duckRefused = (r: ChromeRead): boolean =>
  /bots use duckduckgo too|unusual (traffic|activity)|anomaly|select all squares/i.test(`${r.title}\n${r.text.slice(0, 1_500)}`);

/** DuckDuckGo links through itself (`/l/?uddg=<address>`); this is where the result really goes. */
export function resultUrl(href: string): string | null {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    if (/(^|\.)duckduckgo\.com$/i.test(u.hostname)) {
      const target = u.searchParams.get("uddg");
      return target && /^https?:\/\//i.test(target) ? target : null;
    }
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

export function resultsFrom(r: ChromeRead, limit: number): FoundPost[] {
  const out: FoundPost[] = [];
  const seen = new Set<string>();
  for (const row of r.rows.results ?? []) {
    if (String(row.kind ?? "").includes("result--ad")) continue;
    const url = typeof row.href === "string" ? resultUrl(row.href) : null;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      source: "web",
      url,
      author: null,
      title: typeof row.title === "string" ? row.title.trim() || null : null,
      text: typeof row.snippet === "string" ? row.snippet.trim() : "",
      postedAt: null,
      replies: null,
      preview: true,
    });
    if (out.length >= limit) break;
  }
  return out;
}
