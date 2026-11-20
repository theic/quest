import type { CustomerId, DraftId } from "@mq/core";
import type { Queryable } from "./db.ts";

/** One thing that went up, for the day's sample. */
export interface SentLine {
  readonly id: string;
  readonly kind: string;
  readonly platform: string;
  readonly author: string | null;
  readonly text: string;
  readonly url: string | null;
  readonly alone: boolean;
  readonly sentBack: boolean;
}

/**
 * What a draft keeps besides its words, for trust and for the day's sample: whether they changed it before it went
 * (`edited`), and whether the checks sent it back to the writer (`sent_back`). Best effort: a lost mark fails nothing.
 */
export class PgDraftMarks {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async edited(id: DraftId): Promise<void> {
    await this.#db.query(`update mq.drafts set edited = true where id = $1`, [id]).catch(() => undefined);
  }

  async sentBack(id: DraftId): Promise<void> {
    await this.#db.query(`update mq.drafts set sent_back = true where id = $1`, [id]).catch(() => undefined);
  }

  /**
   * Their last `last` decisions by tap on a kind on a platform: how many, and how many went up as Quest wrote them
   * (not skipped, not edited). What they do with the cards is what decides whether Quest keeps asking.
   */
  async record(customerId: CustomerId, platform: string, kind: string, last = 10): Promise<{ readonly n: number; readonly clean: number }> {
    const { rows } = await this.#db.query<{ n: string; clean: string }>(
      `select count(*) as n, count(*) filter (where status <> 'skipped' and not edited) as clean
         from (select status, edited from mq.drafts
                where customer_id = $1 and platform = $2 and kind = $3 and not alone and status in ('posted', 'uncertain', 'skipped') and decided_at is not null
                order by decided_at desc limit $4) d`,
      [customerId, platform, kind, last],
    );
    return { n: Number(rows[0]?.n ?? 0), clean: Number(rows[0]?.clean ?? 0) };
  }

  /** The words that went up since `since`, newest first, each cut short: the day's sample is drawn from them. */
  async sent(customerId: CustomerId, since: Date, limit = 600): Promise<SentLine[]> {
    const { rows } = await this.#db.query<{ id: string; kind: string; platform: string; author: string | null; body: string; sent_url: string | null; url: string; alone: boolean; sent_back: boolean }>(
      `select id, kind, platform, coalesce(author, target) as author, left(body, 500) as body, sent_url, url, alone, sent_back
         from mq.drafts where customer_id = $1 and kind in ('reply', 'message', 'post') and sent_at >= $2 and body <> '' order by sent_at desc limit $3`,
      [customerId, since, limit],
    );
    return rows.map((r) => ({ id: r.id, kind: r.kind, platform: r.platform, author: r.author, text: r.body, url: r.sent_url ?? r.url, alone: r.alone, sentBack: r.sent_back }));
  }
}
