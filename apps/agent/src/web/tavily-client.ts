import type { CustomerId } from "@mq/core";

/** Why a Tavily call failed, in terms the readers turn into what the tools act on. */
export type TavilyFailure = "auth" | "limit" | "bad_request" | "timeout" | "unavailable";

export class TavilyError extends Error {
  readonly reason: TavilyFailure;
  constructor(reason: TavilyFailure, message: string) {
    super(message);
    this.name = "TavilyError";
    this.reason = reason;
  }
}

export interface TavilyHit {
  readonly title: string;
  readonly url: string;
  readonly content: string;
  readonly published_date?: string | null;
}

export interface TavilyExtract {
  readonly results: readonly { readonly url: string; readonly raw_content: string }[];
  readonly failed: readonly { readonly url: string; readonly error: string }[];
}

/** What a search is asked: Tavily's own words for it (https://docs.tavily.com/documentation/api-reference). */
export interface TavilySearchBody {
  readonly query: string;
  readonly max_results: number;
  readonly time_range?: "day" | "week" | "month" | "year";
  readonly include_domains?: readonly string[];
}

/** The slice of Tavily's API Quest uses: search and extract, both as plain POSTs with a bearer key. */
export class TavilyClient {
  readonly #key: string;
  readonly #fetch: typeof fetch;

  constructor(key: string, fetchImpl: typeof fetch = fetch) {
    this.#key = key;
    this.#fetch = fetchImpl;
  }

  async search(body: TavilySearchBody): Promise<TavilyHit[]> {
    const res = await this.#post<{ results?: TavilyHit[] }>("search", { search_depth: "basic", include_published_date: true, ...body });
    return res.results ?? [];
  }

  /** The text of up to 20 pages as markdown, and the ones Tavily could not read, with its reason. */
  async extract(urls: readonly string[]): Promise<TavilyExtract> {
    const res = await this.#post<{ results?: { url: string; raw_content: string }[]; failed_results?: { url: string; error: string }[] }>("extract", {
      urls,
      format: "markdown",
      extract_depth: "basic",
    });
    return { results: res.results ?? [], failed: res.failed_results ?? [] };
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.#fetch(`https://api.tavily.com/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(40_000),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new TavilyError(timedOut ? "timeout" : "unavailable", `the web reader did not answer: ${e instanceof Error ? e.message : String(e)}`);
    }
    // 432 and 433 are the key's plan limit and the pay-as-you-go limit.
    if (res.status === 401) throw new TavilyError("auth", "the web reader did not accept its key");
    if (res.status === 429 || res.status === 432 || res.status === 433) throw new TavilyError("limit", `the web reader is out of its allowance (HTTP ${res.status})`);
    if (res.status === 400 || res.status === 422) throw new TavilyError("bad_request", `the web reader did not accept the request (HTTP ${res.status})`);
    if (!res.ok) throw new TavilyError("unavailable", `the web reader answered HTTP ${res.status}`);
    try {
      return (await res.json()) as T;
    } catch {
      throw new TavilyError("unavailable", "the web reader answered something that is not JSON");
    }
  }
}

/**
 * What one customer may spend of Tavily's credits in a UTC day: a backstop on cost, not a promise.
 * Kept in memory, so an agent restart gives the day's allowance back.
 */
export class DailyCredits {
  readonly #cap: number;
  readonly #now: () => number;
  readonly #spent = new Map<string, { day: string; credits: number }>();

  constructor(cap: number, now: () => number = Date.now) {
    this.#cap = cap;
    this.#now = now;
  }

  /** Takes `credits` from the customer's day; false (and nothing taken) when that would pass the cap. */
  take(customerId: CustomerId, credits: number): boolean {
    const day = new Date(this.#now()).toISOString().slice(0, 10);
    const had = this.#spent.get(customerId);
    const spent = had?.day === day ? had.credits : 0;
    if (spent + credits > this.#cap) return false;
    this.#spent.set(customerId, { day, credits: spent + credits });
    return true;
  }
}
