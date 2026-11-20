import type { CustomerId } from "@mq/core";
import type { Queryable } from "./db.ts";


type Row = Record<string, unknown>;

/**
 * What their settings and status page shows, read straight from the database: the runs at work, the team's
 * questions, what goes up alone where, and what went up in the last day.
 */
export class PgGlass {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async snapshot(customer: CustomerId): Promise<Record<string, Row[]>> {
    const q = async (sql: string): Promise<Row[]> => (await this.#db.query<Row>(sql, [customer])).rows;
    const [tasks, questions, trust, sentToday] = await Promise.all([
      q(`select agent, title, status, created_at as at from mq.tasks
          where customer_id = $1 and status in (running, waiting) order by created_at desc limit 10`),
      q(`select agent, body as text, status, created_at as at from mq.questions where customer_id = $1 and status in (pending, asked) order by created_at`),
      q(`select platform, approved, ask_first, granted from mq.trust where customer_id = $1`),
      // For the day limits: what went up in the last day, by kind and platform.
      q(`select kind, platform, url from mq.drafts where customer_id = $1 and sent_at > now() - interval '1 day'`),
    ]);
    return { tasks, questions, trust, sentToday };
  }
}
