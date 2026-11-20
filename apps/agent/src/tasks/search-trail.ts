import type { SearchRecord, SearchRun } from "@mq/core";
import { hostOf, SOURCE_SITES } from "./site-pin.ts";

/**
 * What a run's searches came to, kept so the next run starts with the ones that found people. Live,
 * 2026-10-14: an outreach run on X took 24 minutes and about thirty searches to draft three replies,
 * and the next run had no way to know which three searches had found them.
 *
 * Each search keeps the addresses it turned up (a result list's links, a search page's links as it
 * scrolls). A find saved or a message drafted is credited to the search that turned up its address,
 * else to the last search before it.
 */
export class SearchTrail {
  readonly #searches: { site: string; query: string; urls: Set<string>; hits: number; page: string | null }[] = [];

  /** A search run by code inside a tool (find_people's), with the addresses it turned up: the same as a search_posts. */
  add(source: string, query: string, urls: Iterable<string>): void {
    this.#searches.push({ site: SOURCE_SITES[source] ?? source, query: query.trim(), urls: new Set([...urls].map(canonical)), hits: 0, page: null });
  }

  /** Takes in one tool call and what it answered. */
  note(name: string, args: unknown, out: string): void {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (name) {
      case "search_posts": {
        // A refusal ("Not searched", "No more searches") or a failure ("Search on … failed") searched nothing.
        if (/^(Not searched|No more searches|Search on )/.test(out)) return;
        const source = String(a["source"] ?? "web");
        const within = typeof a["site"] === "string" && a["site"] ? ` (site: ${a["site"]})` : "";
        this.#searches.push({ site: SOURCE_SITES[source] ?? source, query: `${String(a["query"] ?? "").trim()}${within}`, urls: links(out), hits: 0, page: null });
        return;
      }
      case "browser_open": {
        const url = typeof a["url"] === "string" ? a["url"] : null;
        if (!url || out.startsWith("Not done") || !isSearchPage(url)) return this.#more(out);
        this.#searches.push({ site: hostOf(url) ?? "web", query: url, urls: links(out), hits: 0, page: pageKey(url) });
        return;
      }
      case "browser_act":
        return this.#more(out);
      case "save_find":
        if (out.startsWith("Saved")) this.#credit(a["url"]);
        return;
      case "outreach_draft":
      case "draft":
        // A draft that went through answers with its record; a refusal is a sentence.
        if (out.startsWith("{")) this.#credit(a["url"]);
        return;
    }
  }

  /** Each distinct search of the run, with what came of it. */
  runs(): SearchRun[] {
    const by = new Map<string, SearchRun>();
    for (const s of this.#searches) {
      const key = `${s.site}|${s.query.toLowerCase()}`;
      const was = by.get(key);
      by.set(key, { site: s.site, query: s.query, hits: (was?.hits ?? 0) + s.hits });
    }
    return [...by.values()];
  }

  /** A page that follows a browser search (a scroll, the next results) adds what it shows to that search. */
  #more(out: string): void {
    const last = this.#searches.at(-1);
    const url = landed(out);
    if (last?.page && url && pageKey(url) === last.page) for (const u of links(out)) last.urls.add(u);
  }

  #credit(url: unknown): void {
    if (typeof url !== "string" || !this.#searches.length) return;
    const key = canonical(url);
    const from = [...this.#searches].reverse().find((s) => s.urls.has(key)) ?? this.#searches.at(-1)!;
    from.hits++;
  }
}

/** A search page: its address carries the words (q=, query=, keywords=), or its path is a search. */
function isSearchPage(url: string): boolean {
  try {
    const u = new URL(url);
    return ["q", "query", "keywords", "search", "term"].some((k) => u.searchParams.has(k)) || /\/search(\/|$)/.test(u.pathname);
  } catch {
    return false;
  }
}

/** One search page, whatever its scroll: host, path and words. */
function pageKey(url: string): string | null {
  try {
    const u = new URL(url);
    const words = ["q", "query", "keywords", "search", "term"].map((k) => u.searchParams.get(k)).find(Boolean) ?? "";
    return `${hostOf(url)}${u.pathname}|${words}`;
  } catch {
    return null;
  }
}

/** An address as a post is known by: host without www (twitter.com as x.com), path without a trailing slash; no query, no fragment. */
export function canonical(url: string): string {
  try {
    const u = new URL(url);
    return `${hostOf(url)}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/** Every address in a tool's answer: links in its text, and a browser page's link targets. */
function links(out: string): Set<string> {
  const found = new Set<string>();
  for (const m of out.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) found.add(canonical(m[0].replace(/[.,;:]+$/, "")));
  return found;
}

const landed = (out: string): string | null => {
  if (!out.startsWith("{")) return null;
  try {
    const url = (JSON.parse(out) as { url?: unknown }).url;
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
};

const day = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * What earlier searches for this customer came to, for a task's opening: the ones that found people,
 * best first, and the ones that found nobody, so the run starts with what worked and skips the rest.
 * Empty when there is nothing to tell.
 */
export function searchesBlock(records: readonly SearchRecord[], site: string | null): string {
  const by = new Map<string, { site: string; query: string; hits: number; tries: number; last: Date }>();
  for (const r of records) {
    const key = `${r.site}|${r.query.toLowerCase()}`;
    const was = by.get(key);
    by.set(key, was
      ? { ...was, hits: was.hits + r.hits, tries: was.tries + 1, last: r.at > was.last ? r.at : was.last }
      : { site: r.site, query: r.query, hits: r.hits, tries: 1, last: r.at });
  }
  const all = [...by.values()];
  const worked = all.filter((s) => s.hits > 0).sort((a, b) => b.hits - a.hits || b.last.getTime() - a.last.getTime()).slice(0, 8);
  const nobody = all.filter((s) => s.hits === 0).sort((a, b) => b.last.getTime() - a.last.getTime()).slice(0, 8);
  if (!worked.length && !nobody.length) return "";
  const line = (s: (typeof all)[number]) => `- ${site ? "" : `${s.site}: `}${s.query}${s.hits ? ` → ${s.hits} ${s.hits === 1 ? "person" : "people"}` : ""} (${day(s.last)}${s.tries > 1 ? `, ${s.tries} runs` : ""})`;
  return [
    `WHAT EARLIER SEARCHES FOR THEM CAME TO${site ? ` ON ${site}` : ""} (run the ones that found people first, with a newer date where they have one; never repeat the ones that found nobody)`,
    ...(worked.length ? ["Found people:", ...worked.map(line)] : []),
    ...(nobody.length ? ["Found nobody:", ...nobody.map(line)] : []),
  ].join("\n");
}
