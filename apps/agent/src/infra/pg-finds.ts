import {
  customerId,
  findId,
  taskId,
  type CustomerId,
  type Find,
  type FindCounts,
  type FindDecision,
  type FindId,
  type FindRepository,
  type FindStatus,
  type FindStrength,
  type NewFind,
  type SkipReason,
  type ToldAnswers, type WatchedFind,
} from "@mq/core";
import type { Queryable } from "./db.ts";

interface FindRow {
  id: string;
  customer_id: string;
  task_id: string | null;
  source: string;
  url: string;
  author: string | null;
  title: string | null;
  quote: string;
  posted_at: Date | null;
  why: string;
  reply: string;
  strength: FindStrength;
  reply_to: string | null;
  status: FindStatus;
  skip_reason: SkipReason | null;
  card_ref: string | null;
  created_at: Date;
  shown_at: Date | null;
  decided_at: Date | null;
  sent_url: string | null;
  sent_as: string | null;
  sent_at: Date | null;
  sent_alone: boolean;
  post_state: NonNullable<Find["postState"]>;
}

const toFind = (r: FindRow): Find => ({
  id: findId(r.id),
  customerId: customerId(r.customer_id),
  taskId: r.task_id ? taskId(r.task_id) : null,
  source: r.source,
  url: r.url,
  author: r.author,
  title: r.title,
  quote: r.quote,
  postedAt: r.posted_at,
  why: r.why,
  reply: r.reply,
  strength: r.strength,
  replyTo: r.reply_to,
  status: r.status,
  skipReason: r.skip_reason,
  cardRef: r.card_ref,
  createdAt: r.created_at,
  shownAt: r.shown_at,
  decidedAt: r.decided_at,
  sentUrl: r.sent_url,
  sentAs: r.sent_as,
  sentAt: r.sent_at,
  sentAlone: r.sent_alone,
  postState: r.post_state,
});

const COLUMNS = `id, customer_id, task_id, source, url, author, title, quote, posted_at, why, reply, strength, reply_to,
  status, skip_reason, card_ref, created_at, shown_at, decided_at, sent_url, sent_as, sent_at, sent_alone, post_state`;

export class PgFindRepository implements FindRepository {
  readonly #db: Queryable;
  readonly #lane: string;

  /** `lane` scopes the work this repository hands out (the posted replies due a look), as the task and event queues do. */
  constructor(db: Queryable, lane = "live") {
    this.#db = db;
    this.#lane = lane;
  }

  async beginPost(id: FindId, alone = false): Promise<boolean> {
    const { rowCount } = await this.#db.query(`update mq.finds set post_state = 'posting', sent_alone = $2 where id = $1 and sent_at is null and post_state = 'open' and status in ('shown', 'kept')`, [id, alone]);
    return (rowCount ?? 0) > 0;
  }

  async endPost(id: FindId, uncertain: boolean): Promise<void> {
    await this.#db.query(`update mq.finds set post_state = $2 where id = $1 and post_state in ('posting', 'uncertain') and sent_at is null`, [id, uncertain ? "uncertain" : "open"]);
  }

  async leftPosting(): Promise<Find[]> {
    const { rows } = await this.#db.query<FindRow>(
      `select ${COLUMNS} from mq.finds
        where post_state = 'posting' and sent_at is null and customer_id in (select id from mq.customers where lane = $1)
        order by shown_at nulls first`,
      [this.#lane],
    );
    return rows.map(toFind);
  }

  async add(f: NewFind): Promise<Find | null> {
    const { rows } = await this.#db.query<FindRow>(
      `insert into mq.finds (customer_id, task_id, source, url, author, title, quote, posted_at, why, reply, strength, reply_to)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (customer_id, url) do nothing
       returning ${COLUMNS}`,
      [f.customerId, f.taskId, f.source, f.url, f.author, f.title, f.quote, f.postedAt, f.why, f.reply, f.strength, f.replyTo ?? null],
    );
    return rows[0] ? toFind(rows[0]) : null;
  }

  async get(id: FindId): Promise<Find | null> {
    const { rows } = await this.#db.query<FindRow>(`select ${COLUMNS} from mq.finds where id = $1`, [id]);
    return rows[0] ? toFind(rows[0]) : null;
  }

  async listFor(customer: CustomerId, statuses: readonly FindStatus[], limit: number): Promise<Find[]> {
    const { rows } = await this.#db.query<FindRow>(
      `select ${COLUMNS} from mq.finds where customer_id = $1 and status = any($2::text[])
        order by coalesce(decided_at, shown_at, created_at) desc limit $3`,
      [customer, statuses, limit],
    );
    return rows.map(toFind);
  }

  async nextToShow(customer: CustomerId, limit: number): Promise<Find[]> {
    const { rows } = await this.#db.query<FindRow>(
      `select ${COLUMNS} from mq.finds where customer_id = $1 and status = 'new'
        order by (strength = 'strong') desc, posted_at desc nulls last, created_at
        limit $2`,
      [customer, limit],
    );
    return rows.map(toFind);
  }

  async known(customer: CustomerId, urls: readonly string[]): Promise<Set<string>> {
    if (!urls.length) return new Set();
    const { rows } = await this.#db.query<{ url: string }>(`select url from mq.finds where customer_id = $1 and url = any($2::text[])`, [customer, urls]);
    return new Set(rows.map((r) => r.url));
  }

  async markShown(id: FindId, cardRef: string | null): Promise<void> {
    await this.#db.query(`update mq.finds set status = 'shown', shown_at = now(), card_ref = $2 where id = $1 and status = 'new'`, [id, cardRef]);
  }

  async decide(id: FindId, decision: FindDecision): Promise<Find | null> {
    const { rows } = await this.#db.query<FindRow>(
      // A kept one ("That's me" on a take, or kept for later) may still be skipped or replied to by hand.
      `update mq.finds set status = $2, decided_at = now()
        where id = $1 and (status = 'shown' or (status = 'kept' and $2 <> 'kept' and sent_at is null)) returning ${COLUMNS}`,
      [id, decision],
    );
    return rows[0] ? toFind(rows[0]) : null;
  }

  async giveReason(id: FindId, reason: SkipReason): Promise<Find | null> {
    const { rows } = await this.#db.query<FindRow>(
      `update mq.finds set skip_reason = $2 where id = $1 and status = 'skipped' returning ${COLUMNS}`,
      [id, reason],
    );
    return rows[0] ? toFind(rows[0]) : null;
  }

  async markSent(id: FindId, url: string, account: string, alone = false): Promise<Find | null> {
    // Posted is replied, whatever was tapped while it went up.
    const { rows } = await this.#db.query<FindRow>(
      `update mq.finds set status = 'replied', post_state = 'posted', skip_reason = null, decided_at = now(), sent_url = $2, sent_as = $3, sent_at = now(), sent_alone = $4
        where id = $1 and sent_at is null returning ${COLUMNS}`,
      [id, url, account, alone],
    );
    return rows[0] ? toFind(rows[0]) : null;
  }

  async revise(id: FindId, reply: string): Promise<Find | null> {
    const { rows } = await this.#db.query<FindRow>(
      `update mq.finds set reply = $2 where id = $1 and sent_at is null and post_state = 'open' and status in ('new', 'shown', 'kept') returning ${COLUMNS}`,
      [id, reply],
    );
    return rows[0] ? toFind(rows[0]) : null;
  }

  async byCard(customer: CustomerId, cardRef: string): Promise<Find | null> {
    const { rows } = await this.#db.query<FindRow>(`select ${COLUMNS} from mq.finds where customer_id = $1 and (card_ref = $2 or $2 = any(other_refs)) order by card_ref = $2 desc limit 1`, [customer, cardRef]);
    return rows[0] ? toFind(rows[0]) : null;
  }

  async moveCard(id: FindId, cardRef: string): Promise<void> {
    // The old ref is read before the update: every expression in a set list sees the row as it was.
    await this.#db.query(
      `update mq.finds set other_refs = case when card_ref is null or card_ref = $2 then other_refs else array_append(other_refs, card_ref) end, card_ref = $2 where id = $1`,
      [id, cardRef],
    );
  }

  async addRef(id: FindId, ref: string): Promise<void> {
    await this.#db.query(`update mq.finds set other_refs = array_append(other_refs, $2) where id = $1`, [id, ref]);
  }

  async dropWaiting(customer: CustomerId, ids: readonly FindId[]): Promise<number> {
    if (!ids.length) return 0;
    const { rowCount } = await this.#db.query(`delete from mq.finds where customer_id = $1 and id = any($2::uuid[]) and status = 'new'`, [customer, ids]);
    return rowCount ?? 0;
  }

  async sentSince(customer: CustomerId, since: Date): Promise<number> {
    const { rows } = await this.#db.query<{ n: string }>(`select count(*) as n from mq.finds where customer_id = $1 and sent_at >= $2`, [customer, since]);
    return Number(rows[0]?.n ?? 0);
  }

  async dueWatches(now: Date, limit: number, only?: readonly CustomerId[]): Promise<WatchedFind[]> {
    if (only && !only.length) return [];
    const { rows } = await this.#db.query<FindRow & { watch_checks: number; watch_seen: string[] }>(
      `select ${COLUMNS}, watch_checks, watch_seen from mq.finds
        where watch_next_at <= $1 and customer_id in (select id from mq.customers where lane = $2) and ($4::uuid[] is null or customer_id = any($4::uuid[]))
        order by watch_checks, watch_next_at limit $3`,
      [now, this.#lane, limit, only ? [...only] : null],
    );
    return rows.map((r) => ({ find: toFind(r), checks: r.watch_checks, seen: r.watch_seen }));
  }

  async watch(id: FindId, next: Date | null, checks: number, seen: readonly string[]): Promise<void> {
    await this.#db.query(`update mq.finds set watch_next_at = $2, watch_checks = $3, watch_seen = $4::text[] where id = $1`, [id, next, checks, seen]);
  }

  async toldAnswers(customer: CustomerId): Promise<ToldAnswers[]> {
    const { rows } = await this.#db.query<ToldAnswers>(`select url, watch_seen as seen from mq.finds where customer_id = $1 and cardinality(watch_seen) > 0`, [customer]);
    return rows;
  }

  async counts(customer: CustomerId): Promise<FindCounts> {
    const { rows } = await this.#db.query<{ status: FindStatus; n: string }>(
      `select status, count(*) as n from mq.finds where customer_id = $1 group by status`,
      [customer],
    );
    const counts: Record<FindStatus, number> = { new: 0, shown: 0, kept: 0, skipped: 0, replied: 0 };
    for (const r of rows) counts[r.status] = Number(r.n);
    return counts;
  }
}
