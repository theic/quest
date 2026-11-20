import type { CustomerId, InviteRepository } from "@mq/core";
import type { Queryable } from "./db.ts";
import { customerChanged } from "./pg-customers.ts";

/** mq.invites: the codes the founder hands out (conversation/way-in.ts). */
export class PgInvites implements InviteRepository {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async redeem(customerId: CustomerId, codes: readonly string[]): Promise<boolean> {
    if (!codes.length) return false;
    // One use, taken under the invite's row lock (`uses_left > 0` is checked again there), and only for someone who
    // waits. Setting `invite` with activated_at keeps mq.let_in quiet: this one is welcomed in the chat.
    const { rowCount } = await this.#db.query(
      `with used as (
         update mq.invites i set uses_left = i.uses_left - 1
          where i.code = (select code from mq.invites where lower(code) = any($2::text[]) and uses_left > 0 order by created_at limit 1)
            and i.uses_left > 0
            and exists (select 1 from mq.customers c where c.id = $1 and c.activated_at is null)
         returning i.code
       )
       update mq.customers c set activated_at = now(), invite = used.code from used where c.id = $1 and c.activated_at is null`,
      [customerId, codes.map((c) => c.toLowerCase())],
    );
    customerChanged(customerId);
    return (rowCount ?? 0) > 0;
  }

  async mint(note: string): Promise<string | null> {
    const { rows } = await this.#db.query<{ code: string }>(`insert into mq.invites (note, uses_left) values ($1, 1) returning code`, [note.slice(0, 2000)]);
    return rows[0]?.code ?? null;
  }

  async noteOf(customerId: CustomerId): Promise<string | null> {
    const { rows } = await this.#db.query<{ note: string | null }>(
      `select i.note from mq.customers c join mq.invites i on lower(i.code) = lower(c.invite) where c.id = $1`,
      [customerId],
    );
    return rows[0]?.note ?? null;
  }

}
