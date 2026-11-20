import { customerId, draftId, findId, type CustomerId, type NewOutboxItem, type OutboxApproval, type OutboxItem, type OutboxRef, type OutboxRepository, type OutboxStatus } from "@mq/core";
import type { Queryable } from "./db.ts";

interface Row {
  id: string;
  customer_id: string;
  draft_id: string | null;
  find_id: string | null;
  target: string | null;
  site: string;
  approved: OutboxApproval;
  light: boolean;
  status: OutboxStatus;
  due_at: Date;
  tries: number;
  reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const toItem = (r: Row): OutboxItem => ({
  id: String(r.id),
  customerId: customerId(r.customer_id),
  draftId: r.draft_id ? draftId(r.draft_id) : null,
  findId: r.find_id ? findId(r.find_id) : null,
  target: r.target,
  site: r.site,
  approved: r.approved,
  light: r.light,
  status: r.status,
  dueAt: r.due_at,
  tries: r.tries,
  reason: r.reason,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const COLUMNS = "o.id, o.customer_id, o.draft_id, o.find_id, o.target, o.site, o.approved, o.light, o.status, o.due_at, o.tries, o.reason, o.created_at, o.updated_at";
const refColumn = (ref: OutboxRef): [string, string] => ("draftId" in ref ? ["draft_id", ref.draftId] : ["find_id", ref.findId]);

/** The outbox in Postgres (`mq.outbox`). What is due is read in this agent's lane only. */
export class PgOutbox implements OutboxRepository {
  readonly #db: Queryable;
  readonly #lane: string;

  constructor(db: Queryable, lane = "live") {
    this.#db = db;
    this.#lane = lane;
  }

  async add(item: NewOutboxItem): Promise<OutboxItem | null> {
    const [column, id] = refColumn(item.ref);
    const { rows } = await this.#db.query<Row>(
      `insert into mq.outbox as o (customer_id, ${column}, target, site, approved, light, due_at) values ($1, $2, $3, $4, $5, $6, coalesce($7, now()))
       on conflict do nothing returning ${COLUMNS}`,
      [item.customerId, id, item.target ?? null, item.site, item.approved, item.light ?? false, item.dueAt ?? null],
    );
    return rows[0] ? toItem(rows[0]) : null;
  }

  async of(ref: OutboxRef): Promise<OutboxItem | null> {
    const [column, id] = refColumn(ref);
    const { rows } = await this.#db.query<Row>(`select ${COLUMNS} from mq.outbox o where o.${column} = $1 and o.status in ('queued', 'sending')`, [id]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  async due(now: Date, limit: number): Promise<OutboxItem[]> {
    const { rows } = await this.#db.query<Row>(
      `select ${COLUMNS} from mq.outbox o join mq.customers c on c.id = o.customer_id
        where o.status = 'queued' and o.due_at <= $1 and c.lane = $2 and c.off_at is null
        -- Their taps and words first; then an answer to someone waiting (a run that answers people drafted it, or it
        -- goes under an answer on record) before an opener to a stranger; then by time.
        order by o.approved = 'trust',
                 not (exists (select 1 from mq.drafts d join mq.tasks t on t.id = d.task_id where d.id = o.draft_id and t.priority = 0)
                      or exists (select 1 from mq.drafts d join mq.results r on r.customer_id = d.customer_id and r.url = d.url
                                  where d.id = o.draft_id and r.stage = 'conversation' and r.created_at > now() - interval '7 days')),
                 o.due_at, o.id limit $3`,
      [now, this.#lane, limit],
    );
    return rows.map(toItem);
  }

  async active(customer: CustomerId): Promise<OutboxItem[]> {
    const { rows } = await this.#db.query<Row>(`select ${COLUMNS} from mq.outbox o where o.customer_id = $1 and o.status in ('queued', 'sending') order by o.id`, [customer]);
    return rows.map(toItem);
  }

  async sentSince(customer: CustomerId, since: Date): Promise<{ site: string; light: boolean; at: Date }[]> {
    const { rows } = await this.#db.query<{ site: string; light: boolean; at: Date }>(
      `select site, light, max(updated_at) as at from mq.outbox
        where customer_id = $1 and status in ('sending', 'done') and updated_at > $2 group by site, light`,
      [customer, since],
    );
    return rows;
  }

  async claim(id: string): Promise<boolean> {
    const { rowCount } = await this.#db.query(`update mq.outbox set status = 'sending', updated_at = now() where id = $1 and status = 'queued'`, [id]);
    return (rowCount ?? 0) > 0;
  }

  async wait(id: string, dueAt: Date, reason: string, approved?: OutboxApproval): Promise<void> {
    await this.#db.query(
      `update mq.outbox set status = 'queued', due_at = $2, reason = $3, approved = coalesce($4, approved), updated_at = now() where id = $1 and status in ('queued', 'sending')`,
      [id, dueAt, reason, approved ?? null],
    );
  }

  async settle(id: string, status: "done" | "dropped", reason: string): Promise<void> {
    await this.#db.query(
      `update mq.outbox set status = $2, reason = $3, tries = tries + case when $2 = 'dropped' and status = 'sending' then 1 else 0 end, updated_at = now()
        where id = $1 and status in ('queued', 'sending')`,
      [id, status, reason],
    );
  }

  async drop(ref: OutboxRef, reason: string): Promise<boolean> {
    const [column, id] = refColumn(ref);
    const { rowCount } = await this.#db.query(`update mq.outbox set status = 'dropped', reason = $2, updated_at = now() where ${column} = $1 and status = 'queued'`, [id, reason]);
    return (rowCount ?? 0) > 0;
  }

  async leftSending(): Promise<OutboxItem[]> {
    const { rows } = await this.#db.query<Row>(
      `select ${COLUMNS} from mq.outbox o join mq.customers c on c.id = o.customer_id where o.status = 'sending' and c.lane = $1`,
      [this.#lane],
    );
    return rows.map(toItem);
  }
}
