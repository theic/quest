import { NO_DECK, type CustomerId, type DeckState, type DeckStore } from "@mq/core";
import type { Queryable } from "./db.ts";

/** mq.customers.deck: where each customer's deck is (asks/deck.ts). */
export class PgDecks implements DeckStore {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async get(customer: CustomerId): Promise<DeckState | null> {
    const { rows } = await this.#db.query<{ deck: Partial<DeckState> | null }>(`select deck from mq.customers where id = $1`, [customer]);
    const deck = rows[0]?.deck;
    return deck ? { ...NO_DECK, ...deck } : null;
  }

  async save(customer: CustomerId, state: DeckState): Promise<void> {
    await this.#db.query(`update mq.customers set deck = $2 where id = $1`, [customer, JSON.stringify(state)]);
  }
}
