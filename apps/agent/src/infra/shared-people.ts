import type { Logger } from "@mq/core";
import type { KnownCheck, KnownPeople, SidedPost } from "./pg-known.ts";

/**
 * The local edition's people: kept on this computer as everywhere (`PgKnownPeople` on PGlite), and the public part of
 * them shared with the one database of people at Quest's server (http/people-routes.ts), whose recent finds the matcher
 * reads beside its own. Sending is best effort and batched: a server that cannot be reached never slows a run.
 */
export class SharedPeople implements KnownPeople {
  readonly #local: KnownPeople;
  readonly #server: string;
  readonly #key: string;
  readonly #log: Logger;
  #waiting: SidedPost[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #theirs: { at: number; days: number; posts: SidedPost[] } | null = null;

  constructor(deps: { local: KnownPeople; server: string; installKey: string; log: Logger }) {
    this.#local = deps.local;
    this.#server = deps.server.replace(/\/+$/, "");
    this.#key = deps.installKey;
    this.#log = deps.log;
  }

  async saw(posts: readonly SidedPost[]): Promise<void> {
    await this.#local.saw(posts);
    this.#waiting.push(...posts.filter((p) => p.author && p.text && /^https?:\/\//.test(p.url)));
    this.#timer ??= setTimeout(() => void this.#flush(), 10_000);
  }

  async know(check: KnownCheck): Promise<void> {
    await this.#local.know(check);
    await this.#send("/people/known", check);
  }

  async forget(site: string, handle: string): Promise<void> {
    await this.#local.forget(site, handle);
    await this.#send("/people/no", { site, handle });
  }

  /** Their own finds and everyone's, each post once, newest first. Everyone's is read at most every 10 minutes. */
  async recent(days: number, limit: number): Promise<SidedPost[]> {
    const own = await this.#local.recent(days, limit);
    if (!this.#theirs || Date.now() - this.#theirs.at > 600_000 || this.#theirs.days < days) {
      const res = await fetch(`${this.#server}/people/recent?days=${days}&limit=${limit}`, { headers: { "x-quest-install": this.#key }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
      const body = res?.ok ? ((await res.json().catch(() => null)) as { posts?: SidedPost[] } | null) : null;
      if (body?.posts) this.#theirs = { at: Date.now(), days, posts: body.posts.map((p) => ({ ...p, postedAt: p.postedAt ? new Date(p.postedAt) : null })) };
      else this.#log.warn("people.recent_failed", { status: res?.status ?? null });
    }
    const seen = new Set(own.map((p) => p.url));
    return [...own, ...(this.#theirs?.posts ?? []).filter((p) => !seen.has(p.url))].slice(0, limit * 2);
  }

  async #flush(): Promise<void> {
    this.#timer = null;
    while (this.#waiting.length) {
      const batch = this.#waiting.splice(0, 200).map((p) => ({ side: p.side, source: p.source, url: p.url, author: p.author, title: p.title, text: p.text.slice(0, 2000), postedAt: p.postedAt, replies: p.replies }));
      if (!(await this.#send("/people/seen", { posts: batch }))) break;
    }
  }

  async #send(path: string, body: unknown): Promise<boolean> {
    const res = await fetch(`${this.#server}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-quest-install": this.#key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (!res?.ok) this.#log.warn("people.send_failed", { path, status: res?.status ?? null });
    return Boolean(res?.ok);
  }

  // What stays on this computer: who was paired, the pairs, the pages.
  about: KnownPeople["about"] = (posts) => this.#local.about(posts);
  paired: KnownPeople["paired"] = (posts) => this.#local.paired(posts);
  pairedLately: KnownPeople["pairedLately"] = (days) => this.#local.pairedLately(days);
  keepPairs: KnownPeople["keepPairs"] = (pairs) => this.#local.keepPairs(pairs);
  openPairs: KnownPeople["openPairs"] = (limit, notOn) => this.#local.openPairs(limit, notOn);
  takePair: KnownPeople["takePair"] = (id, customerId, note) => this.#local.takePair(id, customerId, note);
  pairsForRun: KnownPeople["pairsForRun"] = (limit, want) => this.#local.pairsForRun(limit, want);
  inPairs: KnownPeople["inPairs"] = (days) => this.#local.inPairs(days);
  askerTold: KnownPeople["askerTold"] = (url) => this.#local.askerTold(url);
  pairsFor: KnownPeople["pairsFor"] = (url) => this.#local.pairsFor(url);
  keepPage: KnownPeople["keepPage"] = (customerId, page) => this.#local.keepPage(customerId, page);
}
