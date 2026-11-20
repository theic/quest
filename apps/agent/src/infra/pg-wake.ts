import type { WorkSchedule } from "@mq/core";
import { ms, type Queryable } from "./db.ts";

/**
 * The queue's clock, from Postgres: when the next turn, task or heartbeat falls
 * due. The same function drives the database's wake job
 * (supabase/migrations/20260926120000_agent_sleep.sql), so the agent and the job
 * never disagree about whether there is work.
 */
export class PgWakeSchedule implements WorkSchedule {
  readonly #db: Queryable;
  readonly #heartbeatMs: number;
  readonly #lane: string;

  constructor(db: Queryable, heartbeatMs: number, lane = "live") {
    this.#db = db;
    this.#heartbeatMs = heartbeatMs;
    this.#lane = lane;
  }

  async nextWorkAt(): Promise<Date | null> {
    const { rows } = await this.#db.query<{ due: Date | null }>("select mq.next_work_at($1::interval, $2) as due", [ms(this.#heartbeatMs), this.#lane]);
    return rows[0]?.due ?? null;
  }

  /** Tells the database where this agent listens; returns the key the wake job's calls carry. */
  async register(url: string): Promise<string> {
    const { rows } = await this.#db.query<{ key: string }>("select mq.register_agent($1, $2::interval) as key", [url, ms(this.#heartbeatMs)]);
    const key = rows[0]?.key;
    if (!key) throw new Error("mq.register_agent returned no key: is the agent_sleep migration applied?");
    return key;
  }
}
