import { everywhere, type CustomerId, type Logger, type TrustRepository } from "@mq/core";
import type { Queryable } from "./db.ts";

export class PgTrustRepository implements TrustRepository {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async approved(customer: CustomerId, platform: string): Promise<number> {
    const { rows } = await this.#db.query<{ approved: number }>(`select case when ask_first then 0 else approved end as approved from mq.trust where customer_id = $1 and platform in ($2, $3, '*') order by (platform = $2) desc, (platform = $3) desc limit 1`, [customer, platform, everywhere(platform)]);
    return rows[0]?.approved ?? 0;
  }

  async initialize(customer: CustomerId): Promise<void> {
    await this.#db.query(`insert into mq.trust (customer_id, platform, approved, granted) values ($1, '*', 3, true) on conflict (customer_id, platform) do nothing`, [customer]);
  }

  async approve(customer: CustomerId, platform: string): Promise<number> {
    const { rows } = await this.#db.query<{ approved: number }>(
      `insert into mq.trust (customer_id, platform, approved, ask_first, granted)
       select $1, $2, coalesce(s.approved, 0) + 1, coalesce(s.ask_first, false), coalesce(s.granted, false)
         from (select 1) one left join lateral (select * from mq.trust where customer_id = $1 and platform in ($3, '*') order by (platform = $3) desc limit 1) s on true
       on conflict (customer_id, platform) do update set approved = mq.trust.approved + 1, updated_at = now()
       returning approved`,
      [customer, platform, everywhere(platform)],
    );
    return rows[0]?.approved ?? 0;
  }

  async set(customer: CustomerId, platform: string, approved: number, explicit = false): Promise<void> {
    // Set to TRUST_AFTER it is their "go ahead", which is their yes too; set lower, the yes goes with the count.
    await this.#db.query(
      `with reset as (update mq.trust set approved = $3, granted = $3 >= 3, ask_first = case when $4 then $3 < 3 else ask_first end, updated_at = now() where customer_id = $1 and platform <> $2 and ($2 = '*' or ($2 like '* %' and right(platform, length($2) - 1) = substr($2, 2))))
       insert into mq.trust (customer_id, platform, approved, granted, ask_first) values ($1, $2, $3, $3 >= 3, case when $4 then $3 < 3 else coalesce((select ask_first from mq.trust where customer_id = $1 and platform = '*'), false) end)
       on conflict (customer_id, platform) do update set approved = excluded.approved, granted = excluded.granted, ask_first = case when $4 then excluded.ask_first else mq.trust.ask_first end, updated_at = now()`,
      [customer, platform, approved, explicit],
    );
  }

  async alone(customer: CustomerId, platform: string): Promise<boolean> {
    const { rows } = await this.#db.query<{ alone: boolean }>(
      `select approved >= 3 and granted and not ask_first as alone from mq.trust where customer_id = $1 and platform in ($2, $3, '*') order by (platform = $2) desc, (platform = $3) desc limit 1`,
      [customer, platform, everywhere(platform)],
    );
    return rows[0]?.alone ?? false;
  }

  async offered(customer: CustomerId): Promise<string[]> {
    const { rows } = await this.#db.query<{ platform: string }>(
      `select platform from mq.trust where customer_id = $1 and platform not like '*%' and approved >= 3 and not granted and not ask_first order by updated_at`,
      [customer],
    );
    return rows.map((r) => r.platform);
  }

  async answer(customer: CustomerId, platform: string, yes: boolean): Promise<void> {
    await this.#db.query(
      yes
        ? `update mq.trust set granted = true, ask_first = false, updated_at = now() where customer_id = $1 and platform = $2`
        : `update mq.trust set approved = 0, granted = false, updated_at = now() where customer_id = $1 and platform = $2`,
      [customer, platform],
    );
  }
}
