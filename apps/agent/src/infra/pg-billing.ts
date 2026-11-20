import type { BillingRepository, CustomerId, DaySpend, ToppedUp, TopUp, Wallet } from "@mq/core";
import { PACKS } from "../billing/plans.ts";
import type { Queryable } from "./db.ts";
import { customerChanged } from "./pg-customers.ts";

/** What `mq.customers.invite` says of someone credits they bought let in. */
export const BY_PACK = "pack";

/** A top-up under the smallest pack is never their first: the first pack's bonus is still theirs. */
const SMALLEST_PACK = Math.min(...PACKS.map((p) => p.usd));

interface WalletRow {
  paid: string | null;
  spent: string | null;
  top_ups: string | number | null;
}

const toWallet = (r: WalletRow): Wallet => ({ paid: Number(r.paid ?? 0), spent: Number(r.spent ?? 0), topUps: Number(r.top_ups ?? 0) });

/** Each day's spend, rests and the credits they buy, in Postgres (supabase/migrations/20261103150000_credits.sql). */
export class PgBilling implements BillingRepository {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async day(id: CustomerId, since: Date): Promise<DaySpend> {
    const { rows } = await this.#db.query<{ spent: string | null; rest_until: Date | null; bought: boolean | null; wallet: boolean; paid: string | null; drawn: string | null; top_ups: string | null }>(
      `select (select coalesce(sum(m.cost), 0) from mq.model_calls m where m.customer_id = c.id and m.at >= $2) as spent,
              c.rest_until, c.invite = $3 as bought, w.customer_id is not null as wallet, w.paid, w.spent as drawn,
              (select count(*) from mq.topups t where t.customer_id = c.id and t.paid >= $4) as top_ups
         from mq.customers c left join mq.wallets w on w.customer_id = c.id
        where c.id = $1`,
      [id, since, BY_PACK, SMALLEST_PACK],
    );
    const r = rows[0];
    if (!r) return { spent: 0, wallet: null, bought: false, restUntil: null };
    return {
      spent: Number(r.spent ?? 0),
      wallet: r.wallet ? toWallet({ paid: r.paid, spent: r.drawn, top_ups: r.top_ups }) : null,
      bought: Boolean(r.bought),
      restUntil: r.rest_until,
    };
  }

  async rest(id: CustomerId, until: Date): Promise<boolean> {
    const { rowCount } = await this.#db.query(
      `update mq.customers set rest_until = $2 where id = $1 and (rest_until is null or rest_until <= now())`,
      [id, until],
    );
    return (rowCount ?? 0) > 0;
  }

  async endRest(id: CustomerId): Promise<void> {
    await this.#db.query(`update mq.customers set rest_until = null where id = $1`, [id]);
  }

  async draw(id: CustomerId, upTo: Date): Promise<void> {
    // Each call once: counted_to moves on with every draw, and what is drawn never takes the credits below zero.
    await this.#db.query(
      `update mq.wallets w
          set spent = least(w.paid, w.spent + coalesce((
                        select sum(m.cost) from mq.model_calls m where m.customer_id = w.customer_id and m.at > w.counted_to and m.at <= $2), 0)),
              counted_to = $2, updated_at = now()
        where w.customer_id = $1 and w.counted_to < $2`,
      [id, upTo],
    );
  }

  async startFree(id: CustomerId, usd: number): Promise<boolean> {
    // Once ever: someone with an invite, a pack or an old trial on record is let in with no new credits.
    const { rows } = await this.#db.query<{ let_in: boolean }>(
      `with was as (select invite is null as fresh from mq.customers where id = $1 and activated_at is null),
       let_in as (
         update mq.customers set activated_at = now(), invite = coalesce(nullif(invite, 'trial'), $3)
          where id = $1 and activated_at is null returning id
       ), wallet as (
         insert into mq.wallets (customer_id, paid) select $1, $2 from was where was.fresh and exists (select 1 from let_in)
         on conflict (customer_id) do nothing returning customer_id
       )
       select exists (select 1 from let_in) as let_in`,
      [id, usd, BY_PACK],
    );
    customerChanged(id);
    return Boolean(rows[0]?.let_in);
  }

  async topUp(t: TopUp): Promise<ToppedUp | null> {
    // Kept once per session, with the bonus when they never topped up before; then credited, and someone waiting let in.
    // Setting `invite` with activated_at keeps mq.let_in quiet: this one is welcomed in the chat.
    const { rows } = await this.#db.query<{ credit: string; bonus: string; let_in: boolean } & WalletRow>(
      `with first as (
         select not exists (select 1 from mq.topups where customer_id = $2 and paid >= $6) as yes
       ), kept as (
         insert into mq.topups (session, customer_id, paid, bonus)
         select $1, $2, $3, case when first.yes then $4 else 0 end from first
         on conflict (session) do nothing
         returning customer_id, paid + bonus as credit, bonus
       ), wallet as (
         insert into mq.wallets (customer_id, paid) select customer_id, credit from kept
         on conflict (customer_id) do update set paid = mq.wallets.paid + excluded.paid, updated_at = now()
         returning paid, spent
       ), let_in as (
         update mq.customers c set activated_at = now(), invite = $5 from kept where c.id = kept.customer_id and c.activated_at is null returning c.id
       )
       select kept.credit, kept.bonus, wallet.paid, wallet.spent,
              (select count(*) from mq.topups where customer_id = $2) + 1 as top_ups,
              exists (select 1 from let_in) as let_in
         from kept, wallet`,
      [t.session, t.customerId, t.paid, t.bonus, BY_PACK, SMALLEST_PACK],
    );
    customerChanged(t.customerId);
    const r = rows[0];
    if (!r) return null;
    return { credit: Number(r.credit), bonus: Number(r.bonus), wallet: toWallet(r), letIn: r.let_in };
  }
}
