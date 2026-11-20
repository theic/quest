import {
  customerId,
  type CommitmentSchedule,
  type CustomerId,
  type EventInbox,
  type EventSink,
  type FollowUpSchedule,
  type HeartbeatSource,
  type ManagerEvent,
  type QueuedEvent,
} from "@mq/core";
import { ms, type Queryable } from "./db.ts";

interface EventRow {
  id: string;
  customer_id: string;
  payload: ManagerEvent;
  attempts: number;
  created_at: Date;
}

const toEvent = (r: EventRow): QueuedEvent => ({
  id: String(r.id),
  customerId: customerId(r.customer_id),
  event: r.payload,
  attempts: r.attempts,
  createdAt: r.created_at,
});

/**
 * An event of customer `c` the manager may take now: none while they rest (their day's credits are spent, until their
 * midnight), but the evening report, which does not wait for the morning.
 */
const AWAKE = `(c.rest_until is null or c.rest_until <= now() or e.kind = 'day_report')`;

/**
 * What they did themselves: a message, an answer to a question. Those get a turn while Quest is off too (the founder,
 * 2026-11-12: "the manager should always be there to answer"), for anyone let in.
 */
const THEIRS = `(e.kind in ('user_message', 'question_answered') and c.activated_at is not null)`;

/** Events of customer `c` due a turn. While they switched Quest off, only their own: the rest waits for on. */
const DUE = `((c.off_at is null or ${THEIRS}) and (e.status = 'processing' or (e.status = 'pending' and e.available_at <= now() and ${AWAKE})))`;

/**
 * The manager's inbox in Postgres. A customer is leased to one worker at a time,
 * so a customer's turns never overlap while different customers run in parallel.
 * Events left "processing" by a worker that died are picked up with the next lease.
 */
export class PgEventQueue implements EventSink, EventInbox, HeartbeatSource, FollowUpSchedule, CommitmentSchedule {
  readonly #db: Queryable;
  readonly #lane: string;
  readonly #customer: string | null;

  /** `lane` keeps test rows away from a running agent: it only sees its own lane. */
  constructor(db: Queryable, lane = "live", customer: string | null = null) {
    this.#db = db;
    this.#lane = lane;
    this.#customer = customer;
  }

  async push(customerId: CustomerId, event: ManagerEvent): Promise<void> {
    await this.#db.query(`insert into mq.events (customer_id, kind, payload) values ($1, $2, $3)`, [
      customerId,
      event.kind,
      JSON.stringify(event),
    ]);
  }

  async claimCustomer(worker: string, leaseMs: number): Promise<CustomerId | null> {
    const { rows } = await this.#db.query<{ id: string }>(
      `with due as (
         select c.id from mq.customers c
          where c.lane = $3
            and ($4::uuid is null or c.id = $4::uuid)
            and (c.manager_lease_until is null or c.manager_lease_until < now())
            and exists (select 1 from mq.events e where e.customer_id = c.id and ${DUE})
          order by (select min(e.id) from mq.events e where e.customer_id = c.id and e.status in ('pending', 'processing'))
          for update of c skip locked
          limit 1
       )
       update mq.customers c set manager_worker = $1, manager_lease_until = now() + $2::interval
         from due where c.id = due.id
       returning c.id`,
      [worker, ms(leaseMs), this.#lane, this.#customer],
    );
    return rows[0] ? customerId(rows[0].id) : null;
  }

  async renew(customerId: CustomerId, worker: string, leaseMs: number): Promise<boolean> {
    const { rowCount } = await this.#db.query(
      `update mq.customers set manager_lease_until = now() + $3::interval where id = $1 and manager_worker = $2`,
      [customerId, worker, ms(leaseMs)],
    );
    return (rowCount ?? 0) > 0;
  }

  async release(customerId: CustomerId, worker: string): Promise<void> {
    await this.#db.query(
      `update mq.customers set manager_worker = null, manager_lease_until = null where id = $1 and manager_worker = $2`,
      [customerId, worker],
    );
  }

  async take(customerId: CustomerId, limit: number): Promise<QueuedEvent[]> {
    const { rows } = await this.#db.query<EventRow>(
      `update mq.events e set status = 'processing', attempts = e.attempts + 1
        where e.id in (
          select e.id from mq.events e join mq.customers c on c.id = e.customer_id
           where e.customer_id = $1 and ${DUE}
           order by e.id limit $2
        )
       returning e.id, e.customer_id, e.payload, e.attempts, e.created_at`,
      [customerId, limit],
    );
    return rows.sort((a, b) => Number(a.id) - Number(b.id)).map(toEvent);
  }

  async done(ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    await this.#db.query(`update mq.events set status = 'done', processed_at = now() where id = any($1::bigint[])`, [
      ids,
    ]);
  }

  async retryLater(ids: readonly string[], error: string, delayMs: number, maxAttempts: number): Promise<void> {
    if (!ids.length) return;
    await this.#db.query(
      `update mq.events
          set status = case when attempts >= $4 then 'failed' else 'pending' end,
              available_at = now() + $3::interval,
              error = $2,
              processed_at = case when attempts >= $4 then now() else null end
        where id = any($1::bigint[])`,
      [ids, error.slice(0, 2000), ms(delayMs), maxAttempts],
    );
  }

  async giveBack(ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    await this.#db.query(
      `update mq.events set status = 'pending', attempts = greatest(attempts - 1, 0), processed_at = null where id = any($1::bigint[]) and status = 'processing'`,
      [ids],
    );
  }

  /**
   * A follow-up is a pending event that falls due at `at`: the queue's clock (mq.next_work_at) already
   * wakes a sleeping agent for it. One set before for another time is closed, not deleted, so the record
   * stays; one set for the same time is left alone (every turn sets it again).
   */
  async followUpAt(customerId: CustomerId, at: Date | null): Promise<void> {
    await this.#db.query(
      `with gone as (
         update mq.events set status = 'done', processed_at = now(), error = 'replaced'
          where customer_id = $1 and kind = 'follow_up' and status = 'pending' and available_at is distinct from $2::timestamptz
       )
       insert into mq.events (customer_id, kind, payload, available_at)
       select $1, 'follow_up', '{"kind":"follow_up"}'::jsonb, $2::timestamptz
        where $2::timestamptz is not null
          and not exists (
            select 1 from mq.events
             where customer_id = $1 and kind = 'follow_up' and status = 'pending' and available_at = $2::timestamptz
          )`,
      [customerId, at],
    );
  }

  /**
   * A commitment's wake is a pending event like a follow-up's, one per commitment: a new time closes
   * the one set before (kept, not deleted), and the same time again is left alone.
   */
  async commitmentAt(customerId: CustomerId, commitmentId: string, at: Date | null): Promise<void> {
    await this.#db.query(
      `with gone as (
         update mq.events set status = 'done', processed_at = now(), error = 'replaced'
          where customer_id = $1 and kind = 'commitment_due' and status = 'pending' and payload->>'commitmentId' = $2
            and available_at is distinct from $3::timestamptz
       )
       insert into mq.events (customer_id, kind, payload, available_at)
       select $1, 'commitment_due', jsonb_build_object('kind', 'commitment_due', 'commitmentId', $2::text), $3::timestamptz
        where $3::timestamptz is not null
          and not exists (
            select 1 from mq.events
             where customer_id = $1 and kind = 'commitment_due' and status = 'pending'
               and payload->>'commitmentId' = $2 and available_at = $3::timestamptz
          )`,
      [customerId, commitmentId, at],
    );
  }

  async queueDue(everyMs: number): Promise<number> {
    const { rowCount } = await this.#db.query(
      `with due as (
         update mq.customers c set last_heartbeat_at = now()
          where c.status = 'active'
            and c.lane = $2
            and c.off_at is null
            and (c.rest_until is null or c.rest_until <= now())
            and coalesce(c.last_heartbeat_at, c.created_at) < now() - $1::interval
            and not exists (
              select 1 from mq.events e
               where e.customer_id = c.id and e.kind = 'heartbeat' and e.status in ('pending', 'processing')
            )
         returning c.id
       )
       insert into mq.events (customer_id, kind, payload)
       select id, 'heartbeat', '{"kind":"heartbeat"}'::jsonb from due`,
      [ms(everyMs), this.#lane],
    );
    return rowCount ?? 0;
  }

  async queueDayReports(): Promise<number> {
    // The same clock as mq.next_work_at, so a sleeping agent is woken exactly when one falls due.
    const { rowCount } = await this.#db.query(
      `with due as (
         update mq.customers c
            set last_report_on = (now() at time zone coalesce(c.timezone, 'UTC'))::date
          where c.status = 'active'
            and c.lane = $1
            and c.off_at is null
            and c.brief is not null
            and mq.next_report_at(c) <= now()
         returning c.id, c.last_report_on
       )
       insert into mq.events (customer_id, kind, payload)
       select id, 'day_report', jsonb_build_object('kind', 'day_report', 'day', last_report_on::text) from due`,
      [this.#lane],
    );
    return rowCount ?? 0;
  }
}
