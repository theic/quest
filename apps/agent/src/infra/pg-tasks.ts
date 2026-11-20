import {
  priorityOf,
  customerId,
  taskId,
  type AgentPace,
  type ClaimedTask,
  type CustomerId,
  type NewTask,
  type Task,
  type TaskId,
  type TaskInput,
  type TaskOutcome,
  type TaskQueue,
  type TaskRepository,
  type TaskSignals,
  type TaskStatus,
} from "@mq/core";
import { ms, type Queryable } from "./db.ts";

interface TaskRow {
  id: string;
  customer_id: string;
  agent: string;
  title: string;
  instructions: string;
  site: string | null;
  status: TaskStatus;
  next_input: TaskInput;
  result: string | null;
  error: string | null;
  attempts: number;
  cancel_requested: boolean;
  interrupt_requested: boolean;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

const COLUMNS = `t.id, t.customer_id, t.agent, t.title, t.instructions, t.site, t.status, t.next_input, t.result, t.error,
  t.attempts, t.cancel_requested, t.interrupt_requested, t.created_at, t.updated_at, t.finished_at`;

const toTask = (r: TaskRow): Task => ({
  id: taskId(r.id),
  customerId: customerId(r.customer_id),
  agent: r.agent,
  title: r.title,
  instructions: r.instructions,
  site: r.site,
  status: r.status,
  nextInput: r.next_input,
  result: r.result,
  error: r.error,
  attempts: r.attempts,
  cancelRequested: r.cancel_requested,
  interruptRequested: r.interrupt_requested,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  finishedAt: r.finished_at,
});

const one = (rows: TaskRow[]): Task | null => (rows[0] ? toTask(rows[0]) : null);

/**
 * Tasks in Postgres. The manager's side creates and steers them; the runner's
 * side claims them under a lease, so a task survives the worker that ran it:
 * when a lease runs out, the next claim takes the task over.
 */
export class PgTaskStore implements TaskRepository, TaskQueue {
  readonly #db: Queryable;
  readonly #lane: string;
  readonly #customer: string | null;

  /** `lane` keeps test rows away from a running agent: it only sees its own lane. */
  constructor(db: Queryable, lane = "live", customer: string | null = null) {
    this.#db = db;
    this.#lane = lane;
    this.#customer = customer;
  }

  async create(input: NewTask): Promise<Task> {
    const { rows } = await this.#db.query<TaskRow>(
      `insert into mq.tasks as t (customer_id, agent, title, instructions, site, priority) values ($1, $2, $3, $4, $5, $6) returning ${COLUMNS}`,
      [input.customerId, input.agent, input.title, input.instructions, input.site ?? null, input.priority ?? priorityOf(input.title)],
    );
    const task = one(rows);
    if (!task) throw new Error("task insert returned nothing");
    return task;
  }

  async get(id: TaskId): Promise<Task | null> {
    const { rows } = await this.#db.query<TaskRow>(`select ${COLUMNS} from mq.tasks t where t.id = $1`, [id]);
    return one(rows);
  }

  async listFor(customerId: CustomerId, opts: { statuses?: readonly TaskStatus[]; limit?: number; light?: boolean } = {}): Promise<Task[]> {
    // Light: without each run's instructions, about two thirds of a row. Live, 2026-11-12: the rotation read 400 whole
    // rows every 30 s, about 4 GB a day out of the database.
    // A report too, past the 12 hours the rotation reads it for (a sign-in wall, a run that found nobody): about 1.4 KB a
    // row, 200 MB in two and a half days on dev.
    const columns = opts.light
      ? COLUMNS.replace("t.instructions", "'' as instructions").replace("t.next_input", "null as next_input").replace("t.result", "case when t.finished_at > now() - interval '12 hours' then t.result end as result")
      : COLUMNS;
    const { rows } = await this.#db.query<TaskRow>(
      `select ${columns} from mq.tasks t
        where t.customer_id = $1 and ($2::text[] is null or t.status = any($2::text[]))
        order by t.created_at desc limit $3`,
      [customerId, opts.statuses ? [...opts.statuses] : null, opts.limit ?? 50],
    );
    return rows.map(toTask);
  }

  async requeue(id: TaskId, input: TaskInput): Promise<Task | null> {
    const { rows } = await this.#db.query<TaskRow>(
      `update mq.tasks t set status = 'queued', next_input = $2, available_at = now(), updated_at = now()
        where t.id = $1 and t.status = 'waiting' returning ${COLUMNS}`,
      [id, JSON.stringify(input)],
    );
    return one(rows);
  }

  async requestCancel(id: TaskId): Promise<Task | null> {
    const { rows } = await this.#db.query<TaskRow>(
      `update mq.tasks t set
          status = case when t.status in ('queued', 'waiting') then 'cancelled' else t.status end,
          finished_at = case when t.status in ('queued', 'waiting') then now() else t.finished_at end,
          cancel_requested = (t.status = 'running'),
          updated_at = now()
        where t.id = $1 and t.status in ('queued', 'running', 'waiting')
        returning ${COLUMNS}`,
      [id],
    );
    return one(rows);
  }

  async requestInterrupt(id: TaskId, input: TaskInput): Promise<Task | null> {
    const { rows } = await this.#db.query<TaskRow>(
      `update mq.tasks t set next_input = $2, interrupt_requested = (t.status = 'running'), updated_at = now()
        where t.id = $1 and t.status in ('queued', 'running') returning ${COLUMNS}`,
      [id, JSON.stringify(input)],
    );
    return one(rows);
  }

  async paces(since: Date): Promise<AgentPace[]> {
    const { rows } = await this.#db.query<{ agent: string; runs: number; median: number; p80: number }>(
      `select agent, count(*)::int as runs,
              percentile_cont(0.5) within group (order by extract(epoch from finished_at - coalesce(started_at, created_at)))::float8 * 1000 as median,
              percentile_cont(0.8) within group (order by extract(epoch from finished_at - coalesce(started_at, created_at)))::float8 * 1000 as p80
         from mq.tasks
        where status = 'succeeded' and finished_at >= $1
        group by agent`,
      [since],
    );
    return rows.map((r) => ({ agent: r.agent, runs: r.runs, medianMs: Math.round(r.median), p80Ms: Math.round(r.p80) }));
  }

  async claim(worker: string, leaseMs: number, perCustomer: number, solo: readonly string[] = []): Promise<ClaimedTask | null> {
    const { rows } = await this.#db.query<TaskRow & { was: TaskStatus }>(
      `with next as (
         select t.id, t.status as was from mq.tasks t
          where ((t.status = 'queued' and t.available_at <= now())
                 or (t.status = 'running' and t.lease_until < now()))
            -- A customer resting (their day's credits spent) starts nothing until their rest ends; one who switched Quest off, until it is on.
            and exists (select 1 from mq.customers c where c.id = t.customer_id and c.lane = $4 and c.off_at is null and (c.rest_until is null or c.rest_until <= now()))
            and ($5::uuid is null or t.customer_id = $5::uuid)
            and (select count(*) from mq.tasks r
                  where r.customer_id = t.customer_id and r.status = 'running' and r.lease_until >= now()) < $3
            -- A task kept to a site waits while another of theirs works there: on a site, one at a time, in turn.
            and (t.site is null or not exists (select 1 from mq.tasks s
                  where s.customer_id = t.customer_id and s.site = t.site and s.id <> t.id and s.status = 'running' and s.lease_until >= now()))
            -- One run in their Chrome at a time: two took the front of the window from each other between every step.
            and (not (t.agent = any($6::text[])) or not exists (select 1 from mq.tasks b
                  where b.customer_id = t.customer_id and b.id <> t.id and b.agent = any($6::text[]) and b.status = 'running' and b.lease_until >= now()))
          -- Whoever answers someone waiting goes first, then asked-for work, then routine browsing; in each, by time.
          order by t.priority, t.available_at
          for update of t skip locked
          limit 1
       )
       update mq.tasks t set status = 'running', worker = $1, lease_until = now() + $2::interval,
              attempts = t.attempts + 1, started_at = coalesce(t.started_at, now()), updated_at = now()
         from next where t.id = next.id
       returning ${COLUMNS}, next.was`,
      [worker, ms(leaseMs), perCustomer, this.#lane, this.#customer, [...solo]],
    );
    const row = rows[0];
    return row ? { task: toTask(row), recovered: row.was === "running" } : null;
  }

  async heartbeat(id: TaskId, worker: string, leaseMs: number): Promise<TaskSignals> {
    const { rows } = await this.#db.query<{ cancel_requested: boolean; interrupt_requested: boolean }>(
      `update mq.tasks set lease_until = now() + $3::interval
        where id = $1 and worker = $2 and status = 'running'
        returning cancel_requested, interrupt_requested`,
      [id, worker, ms(leaseMs)],
    );
    const row = rows[0];
    return row
      ? { held: true, cancelRequested: row.cancel_requested, interruptRequested: row.interrupt_requested }
      : { held: false, cancelRequested: false, interruptRequested: false };
  }

  async finish(id: TaskId, worker: string, outcome: TaskOutcome): Promise<void> {
    await this.#db.query(
      `update mq.tasks set status = $3, result = $4, error = $5, finished_at = now(), updated_at = now(),
              worker = null, lease_until = null, cancel_requested = false, interrupt_requested = false
        where id = $1 and worker = $2 and status = 'running'`,
      [
        id,
        worker,
        outcome.status,
        outcome.status === "succeeded" ? outcome.result : null,
        outcome.status === "failed" ? outcome.error.slice(0, 4000) : null,
      ],
    );
  }

  async park(id: TaskId, worker: string): Promise<void> {
    await this.#db.query(
      `update mq.tasks set status = 'waiting', worker = null, lease_until = null, attempts = greatest(0, attempts - 1), updated_at = now()
        where id = $1 and worker = $2 and status = 'running'`,
      [id, worker],
    );
  }

  async release(id: TaskId, worker: string, input: TaskInput, delayMs: number, clean = false): Promise<void> {
    await this.#db.query(
      `update mq.tasks set status = 'queued', next_input = $3, available_at = now() + $4::interval,
              worker = null, lease_until = null, interrupt_requested = false, updated_at = now(),
              attempts = case when $5 then greatest(0, attempts - 1) else attempts end
        where id = $1 and worker = $2 and status = 'running'`,
      [id, worker, JSON.stringify(input), ms(delayMs), clean],
    );
  }
}
