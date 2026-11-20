import { SearchError, type FoundPost, type PostQuery, type PostSearch } from "@mq/core";
import { tool } from "langchain";
import { z } from "zod";
import type { SeenPages } from "./seen-pages.ts";

const day = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : "date unknown");

const postBlock = (p: FoundPost): string =>
  [
    `[${p.source}] ${day(p.postedAt)}${p.author ? ` by ${p.author}` : ""}${p.replies !== null ? `, ${p.replies} replies` : ""}` +
      (p.title ? ` — "${p.title}"` : ""),
    p.url,
    p.text,
  ]
    .filter(Boolean)
    .join("\n");

const failure = (source: string, e: unknown): string => {
  if (!(e instanceof SearchError)) return `Search on ${source} failed: ${e instanceof Error ? e.message : String(e)}.`;
  const line = `Search on ${source} failed: ${e.reason} (${e.message}).`;
  if (e.reason === "refused") return `${line} That is the source's answer: do not try to reach it another way.`;
  if (e.reason === "rate_limited") return `${line} Do not search ${source} again in this task.`;
  if (e.reason === "offline") return `${line} ${CHROME_OFFLINE}`;
  return line;
};

/** What an agent is told when the customer's Chrome, where it reads and searches the web, is not there. */
export const CHROME_OFFLINE =
  "Reading pages, Reddit and web search happen in the customer's own Chrome, and it is not connected right now. Do not retry: " +
  "finish with what you have (the other sources still work), and say in your report that Chrome was offline.";

/** Keeps a run from searching forever: may refuse a search, and may add a note to a result. */
export interface SearchPacing {
  /** Takes one search from the run's allowance: null when it may run, or why it may not. */
  take(q: PostQuery): string | null | Promise<string | null>;
  /** A note to add to the result of a search that ran (with the posts it found, none when it failed), or null. */
  after(found: readonly FoundPost[], q: Pick<PostQuery, "source">): string | null;
}

export interface SearchToolOptions {
  /** Keeps every post found, so what a subagent saves can be checked against it. */
  readonly seen?: SeenPages;
  /** Which of these addresses the customer already has a find for; those are marked so nobody redoes them. */
  readonly known?: (urls: readonly string[]) => Promise<Set<string>>;
  readonly pacing?: SearchPacing;
}

/** Searching communities: Reddit and the web in the customer's Chrome, the rest through their own public APIs. */
export function searchTools(posts: PostSearch, opts: SearchToolOptions = {}) {
  const sources = posts.sources();
  const guide = sources
    .map((s) => `- ${s.name}: ${s.covers}. Query: ${s.queryHint}.${s.siteHint ? ` Site: ${s.siteHint}.` : ""}`)
    .join("\n");

  const searchPosts = tool(
    async ({ source, query, site, limit, within }) => {
      const refused = await opts.pacing?.take({ source, query, ...(site ? { site } : {}) });
      if (refused) return refused;
      const { text, found } = await search(source, query, site, limit, within);
      const note = opts.pacing?.after(found, { source });
      return note ? `${text}\n\n${note}` : text;
    },
    {
      name: "search_posts",
      description:
        "Search what people wrote recently in public communities, through each community's own search. " +
        "Use it to find people who ask for what the customer offers; then read_page the best threads in full.\n" +
        `Sources:\n${guide}`,
      schema: z.object({
        source: z.enum(sources.map((s) => s.name) as [string, ...string[]]),
        query: z.string().min(1).max(200),
        site: z.string().optional().describe("Only for sources that take one (see the list)."),
        limit: z.number().int().min(1).max(20).optional(),
        within: z.enum(["day", "week", "month", "year"]).optional().describe("Only posts from this recent period (reddit and web)."),
      }),
    },
  );

  async function search(source: string, query: string, site?: string, limit?: number, within?: PostQuery["within"]): Promise<{ text: string; found: readonly FoundPost[] }> {
    try {
      const found = await posts.search({ source, query, ...(site ? { site } : {}), ...(limit ? { limit } : {}), ...(within ? { within } : {}) });
      if (!found.length) return { text: `Nothing on ${source} for "${query}". Try other words, or another source.`, found };
      // A search engine's snippet is not the post: only what was read can be quoted.
      for (const p of found) if (!p.preview) opts.seen?.record(p.url, [p.title, p.text].filter(Boolean).join("\n"), p);
      const known = opts.known ? await opts.known(found.map((p) => p.url)) : new Set<string>();
      const blocks = found.map((p) =>
        known.has(p.url)
          ? `${postBlock(p)}\n(already found earlier for this customer: skip it)`
          : p.preview
            ? `${postBlock(p)}\n(a search result: read_page it before you judge or save it)`
            : postBlock(p),
      );
      return { text: `${found.length} posts on ${source} for "${query}":\n\n${blocks.join("\n\n")}`, found };
    } catch (e) {
      return { text: failure(source, e), found: [] };
    }
  }

  return [searchPosts];
}
