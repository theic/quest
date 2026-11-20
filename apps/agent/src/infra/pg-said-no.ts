import type { CustomerId } from "@mq/core";
import type { Refusal, SaidNoStore } from "../contacts/said-no.ts";
import type { Queryable } from "./db.ts";

/** mq.said_no: whoever asked a customer to be left alone, kept for good. */
export class PgSaidNo implements SaidNoStore {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async list(customer: CustomerId): Promise<Refusal[]> {
    const { rows } = await this.#db.query<Refusal>(`select site, person, words from mq.said_no where customer_id = $1`, [customer]);
    return rows;
  }

  async add(customer: CustomerId, no: Refusal & { url: string | null }): Promise<void> {
    await this.#db.query(`insert into mq.said_no (customer_id, site, person, words, url) values ($1, $2, $3, $4, $5)`, [customer, no.site, no.person, no.words, no.url]);
  }
}
