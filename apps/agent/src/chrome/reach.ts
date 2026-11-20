import type { CustomerId, HostGuard, Logger, PageReader, PostSearch, WebReach } from "@mq/core";
import type { PostSource } from "../sources/http.ts";
import { SourceRegistry } from "../sources/registry.ts";
import type { ChromeBroker } from "./broker.ts";
import { ChromeReader } from "./chrome-reader.ts";
import { RedditSource, SiteSource, WebSource } from "./chrome-sources.ts";
import { SITE_READERS } from "./sites.ts";

/**
 * What a customer's team reads and searches with: pages, Reddit and web search
 * in the customer's own Chrome; communities with public APIs (Hacker News,
 * Stack Exchange, Bluesky and the rest) straight from the agent, as before.
 */
export class ChromeReach implements WebReach {
  readonly #broker: ChromeBroker;
  readonly #guard: HostGuard;
  readonly #apis: readonly PostSource[];
  readonly #log: Logger | null;

  constructor(broker: ChromeBroker, guard: HostGuard, apis: readonly PostSource[], log: Logger | null = null) {
    this.#broker = broker;
    this.#guard = guard;
    this.#apis = apis;
    this.#log = log;
  }

  forCustomer(customerId: CustomerId): { reader: PageReader; posts: PostSearch } {
    const read = (job: Parameters<ChromeBroker["read"]>[1]) => this.#timed(customerId, job);
    return {
      reader: new ChromeReader(read, this.#guard, { log: this.#log }),
      posts: new SourceRegistry([
        new RedditSource(read),
        new WebSource(read),
        ...SITE_READERS.filter((s) => s.searchUrl).map((s) => new SiteSource(s, read)),
        ...this.#apis,
      ]),
    };
  }

  /** Each page read in a customer's Chrome is one log line: the host (never the path), how long it took and how it ended. */
  async #timed(customerId: CustomerId, job: Parameters<ChromeBroker["read"]>[1]) {
    const started = Date.now();
    const host = URL.canParse(job.url) ? new URL(job.url).hostname : "?";
    try {
      const read = await this.#broker.read(customerId, job);
      this.#log?.info("chrome.read", { customerId, host, ms: Date.now() - started, status: read.status, drawn: Boolean(job.drawn) });
      return read;
    } catch (e) {
      const reason = e instanceof Error && "reason" in e ? String(e.reason) : "error";
      this.#log?.warn("chrome.read_failed", { customerId, host, ms: Date.now() - started, reason, drawn: Boolean(job.drawn) });
      throw e;
    }
  }
}
