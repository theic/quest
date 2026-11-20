import { SearchError, type SourceInfo, type FoundPost, type PostQuery } from "@mq/core";

/** Quest says who it is on every request. Sources decide what to answer; Quest never pretends to be a person. */
export const QUEST_USER_AGENT = "QuestBot/0.1 (+https://messaging.quest)";

/** One community's search. Adding a source is a new class in the registry; nothing else changes. */
export interface PostSource {
  readonly info: SourceInfo;
  search(query: PostQuery, limit: number): Promise<FoundPost[]>;
}

export type Fetch = typeof fetch;

/** GETs JSON, turning refusals and outages into reasons an agent can act on. */
export async function getJson<T>(fetchImpl: Fetch, source: string, url: string, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { "user-agent": QUEST_USER_AGENT, accept: "application/json", ...headers },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new SearchError("unavailable", `${source} did not answer: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 401 || res.status === 403) throw new SearchError("refused", `${source} refused the search (HTTP ${res.status})`);
  if (res.status === 429) throw new SearchError("rate_limited", `${source} asked us to slow down (HTTP 429)`);
  if (res.status === 400 || res.status === 404 || res.status === 422) throw new SearchError("bad_query", `${source} did not accept the query (HTTP ${res.status})`);
  if (!res.ok) throw new SearchError("unavailable", `${source} answered HTTP ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new SearchError("unavailable", `${source} answered something that is not JSON`);
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** HTML fragments (comments, answers, toots) as plain text. */
export function plainText(html: string | null | undefined, max = 600): string {
  if (!html) return "";
  const text = html
    .replace(/<(br|\/p|\/li|\/div)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
      if (code[0] === "#") {
        const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export const dateOrNull = (v: string | number | null | undefined): Date | null => {
  if (v === null || v === undefined || v === "") return null;
  const d = typeof v === "number" ? new Date(v * 1000) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
