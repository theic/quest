import type { Queryable } from "./db.ts";

/**
 * The accounts people made on the website (mq.accounts), as far as the agent may touch them:
 * an unsubscribe link's token finds one, and the opt-out is recorded on it. Nothing else.
 */
export class PgAccounts {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async byUnsubscribeToken(token: string): Promise<{ email: string; optedOut: boolean } | null> {
    const { rows } = await this.#db.query<{ email: string | null; news_opt_out: boolean }>(
      "select email, news_opt_out from mq.accounts where unsubscribe_token = $1",
      [token],
    );
    const row = rows[0];
    return row ? { email: row.email ?? "", optedOut: row.news_opt_out } : null;
  }

  async optOut(token: string): Promise<{ email: string } | null> {
    const { rows } = await this.#db.query<{ email: string | null }>(
      "update mq.accounts set news_opt_out = true where unsubscribe_token = $1 returning email",
      [token],
    );
    const row = rows[0];
    return row ? { email: row.email ?? "" } : null;
  }
}
