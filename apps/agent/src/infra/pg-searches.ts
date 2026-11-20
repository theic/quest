import type { CustomerId, SearchLog, SearchRecord, SearchRun, TaskId } from "@mq/core";
import type { Queryable } from "./db.ts";

interface SearchRow {
  agent: string;
  site: string;
  query: string;
  hits: number;
  at: Date;
}

/** mq.searches: every search a run made, and how many people came of it. */
export class PgSearches implements SearchLog {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async record(customer: CustomerId, task: TaskId, agent: string, runs: readonly SearchRun[]): Promise<void> {
    if (!runs.length) return;
    await this.#db.query(
      `insert into mq.searches (customer_id, task_id, agent, site, query, hits)
       select $1, $2, $3, r.site, r.query, r.hits
         from jsonb_to_recordset($4::jsonb) as r(site text, query text, hits int)`,
      [customer, task, agent, JSON.stringify(runs.map((r) => ({ site: r.site, query: r.query.slice(0, 500), hits: r.hits })))],
    );
  }

  async recent(customer: CustomerId, opts: { site?: string | null; days: number; limit: number }): Promise<SearchRecord[]> {
    const { rows } = await this.#db.query<SearchRow>(
      `select agent, site, query, hits, at from mq.searches
        where customer_id = $1 and at > now() - make_interval(days => $2) and ($3::text is null or site = $3)
        order by at desc limit $4`,
      [customer, opts.days, opts.site ?? null, opts.limit],
    );
    return rows.map((r) => ({ agent: r.agent, site: r.site, query: r.query, hits: r.hits, at: r.at }));
  }
}
