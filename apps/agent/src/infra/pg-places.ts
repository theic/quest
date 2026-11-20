import { customerId, type CustomerId, type NewPlace, type Place, type PlaceRepository, type PlaceVerdict } from "@mq/core";
import type { Queryable } from "./db.ts";

interface PlaceRow {
  customer_id: string;
  key: string;
  name: string;
  url: string;
  verdict: PlaceVerdict;
  rules: string | null;
  why: string;
  found_at: Date;
  updated_at: Date;
  added: boolean;
}

const toPlace = (r: PlaceRow): Place => ({
  customerId: customerId(r.customer_id),
  key: r.key,
  name: r.name,
  url: r.url,
  verdict: r.verdict,
  rules: r.rules,
  why: r.why,
  foundAt: r.found_at,
  updatedAt: r.updated_at,
});

const COLUMNS = "customer_id, key, name, url, verdict, rules, why, found_at, updated_at";

export class PgPlaceRepository implements PlaceRepository {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async save(p: NewPlace): Promise<{ place: Place; added: boolean }> {
    // xmax is 0 on a row this statement inserted, and set on one it updated.
    const { rows } = await this.#db.query<PlaceRow>(
      `insert into mq.places (customer_id, key, name, url, verdict, rules, why)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (customer_id, key) do update
         set name = excluded.name, url = excluded.url, verdict = excluded.verdict, rules = excluded.rules, why = excluded.why, updated_at = now()
       returning ${COLUMNS}, (xmax = 0) as added`,
      [p.customerId, p.key, p.name, p.url, p.verdict, p.rules, p.why],
    );
    const row = rows[0]!;
    return { place: toPlace(row), added: row.added };
  }

  async listFor(customer: CustomerId): Promise<Place[]> {
    const { rows } = await this.#db.query<PlaceRow>(`select ${COLUMNS}, false as added from mq.places where customer_id = $1 order by found_at desc`, [customer]);
    return rows.map(toPlace);
  }
}
