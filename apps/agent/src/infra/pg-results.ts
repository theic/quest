import {
  customerId,
  routeKey,
  SPENT_AFTER,
  type CustomerId,
  type NewResult,
  type ResultEntry,
  type ResultRepository,
  type ResultSource,
  type ResultStage,
  type Route,
  type RouteRepository,
  type RouteResult,
  type RouteStatus,
} from "@mq/core";
import type { Queryable } from "./db.ts";
import { ReadCache } from "./read-cache.ts";

interface ResultRow {
  id: string;
  customer_id: string;
  stage: ResultStage;
  person: string | null;
  count: number;
  url: string | null;
  evidence: string;
  source: ResultSource;
  created_at: Date;
}

const RESULT_COLUMNS = "id, customer_id, stage, person, count, url, evidence, source, created_at";

const toResult = (r: ResultRow): ResultEntry => ({
  id: String(r.id),
  customerId: customerId(r.customer_id),
  stage: r.stage,
  person: r.person,
  count: r.count,
  url: r.url,
  evidence: r.evidence,
  source: r.source,
  at: r.created_at,
});

/** What the work came to, in mq.results: a person once per stage, a count as often as it is given. */
export class PgResultRepository implements ResultRepository {
  readonly #db: Queryable;
  readonly #list: ReadCache<ResultEntry>;

  /** `cacheMs` keeps `list` for a moment (read-cache.ts). */
  constructor(db: Queryable, cacheMs = 0) {
    this.#db = db;
    this.#list = new ReadCache(cacheMs, 500);
  }

  async record(id: CustomerId, r: NewResult): Promise<{ entry: ResultEntry; added: boolean }> {
    const person = r.person?.trim().slice(0, 200) || null;
    const { rows } = await this.#db.query<ResultRow>(
      `insert into mq.results (customer_id, stage, person, count, url, evidence, source) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (customer_id, stage, lower(person)) where person is not null do nothing
       returning ${RESULT_COLUMNS}`,
      [id, r.stage, person, person ? 1 : Math.max(0, Math.round(r.count)), r.url?.slice(0, 2000) ?? null, r.evidence.trim().slice(0, 500), r.source],
    );
    if (rows[0]) {
      // The kept list takes the new row at its top (it is the newest); a result already there changed nothing.
      const entry = toResult(rows[0]);
      this.#list.prepend(id, entry);
      return { entry, added: true };
    }
    const had = await this.#db.query<ResultRow>(
      `select ${RESULT_COLUMNS} from mq.results where customer_id = $1 and stage = $2 and lower(person) = lower($3)`,
      [id, r.stage, person],
    );
    if (!had.rows[0]) throw new Error("result neither recorded nor found");
    return { entry: toResult(had.rows[0]), added: false };
  }

  async list(id: CustomerId, limit: number): Promise<ResultEntry[]> {
    return this.#list.get(id, limit, async (limit) => {
      const { rows } = await this.#db.query<ResultRow>(
        `select ${RESULT_COLUMNS} from mq.results where customer_id = $1 order by created_at desc, id desc limit $2`,
        [id, limit],
      );
      return rows.map(toResult);
    });
  }
}

interface RouteRow {
  id: string;
  customer_id: string;
  name: string;
  status: RouteStatus;
  tries: number;
  wins: number;
  misses: number;
  last_note: string | null;
  updated_at: Date;
}

const ROUTE_COLUMNS = "id, customer_id, name, status, tries, wins, misses, last_note, updated_at";

const toRoute = (r: RouteRow): Route => ({
  id: String(r.id),
  customerId: customerId(r.customer_id),
  name: r.name,
  status: r.status,
  tries: r.tries,
  wins: r.wins,
  misses: r.misses,
  lastNote: r.last_note,
  updatedAt: r.updated_at,
});

/** The ways Quest goes after results, in mq.routes. The arithmetic is routes.ts `afterTry`, in SQL so two tries never race. */
export class PgRouteRepository implements RouteRepository {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async log(id: CustomerId, name: string, result: RouteResult, note: string | null): Promise<Route> {
    const worked = result === "worked";
    const { rows } = await this.#db.query<RouteRow>(
      `insert into mq.routes as r (customer_id, key, name, status, tries, wins, misses, last_note)
       values ($1, $2, $3, case when $4 then 'working' when 1 >= $6 then 'spent' else 'trying' end, 1, $4::int, (not $4)::int, $5)
       on conflict (customer_id, key) do update set
         tries = r.tries + 1,
         wins = r.wins + $4::int,
         misses = case when $4 then 0 else r.misses + 1 end,
         status = case when $4 then 'working' when r.misses + 1 >= $6 then 'spent' else 'trying' end,
         last_note = coalesce($5, r.last_note),
         updated_at = now()
       returning ${ROUTE_COLUMNS}`,
      [id, routeKey(name), name.trim().replace(/\s+/g, " ").slice(0, 120), worked, note?.trim().slice(0, 500) || null, SPENT_AFTER],
    );
    return toRoute(rows[0]!);
  }

  async reopen(id: CustomerId, name: string, why: string): Promise<Route | null> {
    const { rows } = await this.#db.query<RouteRow>(
      `update mq.routes set status = 'trying', misses = $4, last_note = $3, updated_at = now()
        where customer_id = $1 and key = $2 and status = 'spent' returning ${ROUTE_COLUMNS}`,
      [id, routeKey(name), `tried again: ${why}`.slice(0, 500), SPENT_AFTER - 1],
    );
    return rows[0] ? toRoute(rows[0]) : null;
  }

  async get(id: CustomerId, name: string): Promise<Route | null> {
    const { rows } = await this.#db.query<RouteRow>(`select ${ROUTE_COLUMNS} from mq.routes where customer_id = $1 and key = $2`, [id, routeKey(name)]);
    return rows[0] ? toRoute(rows[0]) : null;
  }

  async list(id: CustomerId): Promise<Route[]> {
    const { rows } = await this.#db.query<RouteRow>(`select ${ROUTE_COLUMNS} from mq.routes where customer_id = $1 order by updated_at desc limit 40`, [id]);
    return rows.map(toRoute);
  }
}
