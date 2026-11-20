import { randomUUID } from "node:crypto";
import type { AssetFile, CustomerId, Logger } from "@mq/core";
import type { Queryable } from "../infra/db.ts";
import { contactSite } from "../contacts/handles.ts";
import type { CustomerBrowser } from "./browser.ts";

/**
 * How many pictures a reply may carry on each site (Bluesky and X take four, a LinkedIn comment one, an email a few).
 * Elsewhere a reply goes with none: the poster refuses to publish until every file is attached, so a site that takes
 * no picture in a reply must get none.
 */
const PICTURES_IN_A_REPLY: Readonly<Record<string, number>> = { "bsky.app": 3, "x.com": 3, "threads.com": 3, "linkedin.com": 1, "mail.google.com": 3 };

export const picturesOn = (url: string): number => {
  const host = /^https?:\/\/mail\.google\.com\//i.test(url) ? "mail.google.com" : contactSite(url) ?? "";
  return PICTURES_IN_A_REPLY[host] ?? 0;
};

/**
 * Pictures of people's posts, each cut to the post's box in their Chrome (the founder, 2026-11-20: "each reply we do on
 * a platform that includes the match page link must also include cropped screenshots of the posts in the list; this
 * should increase the trust before opening the page"). Kept in mq.shots and attached as a draft's assets.
 */
export class PostShots {
  readonly #browser: CustomerBrowser;
  readonly #db: Queryable;
  readonly #log: Logger;

  constructor(deps: { browser: CustomerBrowser; db: Queryable; log: Logger }) {
    this.#browser = deps.browser;
    this.#db = deps.db;
    this.#log = deps.log;
  }

  /** Up to `max` posts pictured, one at a time, each given a minute; the ids of those that came out. */
  async take(customerId: CustomerId, posts: readonly { readonly url: string; readonly quote: string }[], max: number): Promise<string[]> {
    const ids: string[] = [];
    for (const p of posts) {
      if (ids.length >= max) break;
      const session = `shot:${randomUUID()}`;
      try {
        const shot = await Promise.race([
          (async () => {
            await this.#browser.open(customerId, session, p.url, { drawn: true });
            return (await this.#browser.act(customerId, session, { kind: "shot", quote: p.quote })).shot ?? null;
          })(),
          new Promise<null>((r) => setTimeout(() => r(null), 60_000)),
        ]);
        if (!shot) continue;
        const { rows } = await this.#db.query<{ id: string }>(`insert into mq.shots (customer_id, url, data) values ($1, $2, $3) returning id`, [customerId, p.url, shot.image]);
        if (rows[0]) ids.push(rows[0].id);
      } catch (e) {
        this.#log.info("shots.missed", { customerId, url: p.url, error: e instanceof Error ? e.message.slice(0, 160) : String(e) });
      } finally {
        await this.#browser.close(customerId, session).catch(() => undefined);
      }
    }
    await this.#db.query(`delete from mq.shots where created_at < now() - interval '14 days'`).catch(() => undefined);
    this.#log.info("shots.taken", { customerId, asked: Math.min(max, posts.length), taken: ids.length });
    return ids;
  }

  /** The pictures among these ids, as files the poster attaches. */
  async files(customerId: CustomerId, ids: readonly string[]): Promise<AssetFile[]> {
    if (!ids.length) return [];
    const { rows } = await this.#db.query<{ id: string; data: string }>(`select id, data from mq.shots where customer_id = $1 and id = any($2::uuid[])`, [customerId, ids]);
    return ids.flatMap((id, i) => {
      const r = rows.find((x) => x.id === id);
      return r ? [{ name: `post-${i + 1}.jpg`, type: "image/jpeg", data: r.data.replace(/^data:image\/jpeg;base64,/, "") }] : [];
    });
  }
}
