import { customerId, type ChromeLink, type ChromeLinkRepository, type CustomerId } from "@mq/core";
import type { Queryable } from "./db.ts";

interface LinkRow {
  id: string;
  customer_id: string;
  device: string | null;
  paired_at: Date;
  last_seen_at: Date | null;
}

const toLink = (r: LinkRow): ChromeLink => ({
  id: r.id,
  customerId: customerId(r.customer_id),
  device: r.device,
  pairedAt: r.paired_at,
  lastSeenAt: r.last_seen_at,
});

const COLUMNS = "id, customer_id, device, paired_at, last_seen_at";
const ACTIVE = "paired_at is not null and revoked_at is null";

export class PgChromeLinks implements ChromeLinkRepository {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async offer(id: CustomerId, codeHash: string, expiresAt: Date): Promise<void> {
    await this.#db.query(
      `with gone as (
         delete from mq.chrome_links where customer_id = $1 and paired_at is null
       )
       insert into mq.chrome_links (customer_id, code_hash, code_expires_at) values ($1, $2, $3)`,
      [id, codeHash, expiresAt],
    );
  }

  async lastOffer(id: CustomerId): Promise<Date | null> {
    const { rows } = await this.#db.query<{ created_at: Date }>(
      `select created_at from mq.chrome_links
        where customer_id = $1 and paired_at is null and code_hash is not null
        order by created_at desc limit 1`,
      [id],
    );
    return rows[0]?.created_at ?? null;
  }

  /**
   * The code is claimed first, by one update, so two presses of the same link
   * cannot both pair. Then the customer's older Chrome is disconnected, and only
   * then is the new one marked paired: the unique index allows one at a time.
   */
  async redeem(codeHash: string, tokenHash: string, device: string | null, now: Date): Promise<ChromeLink | null> {
    const claimed = await this.#db.query<{ id: string; customer_id: string }>(
      `update mq.chrome_links set code_hash = null, code_expires_at = null, token_hash = $2, device = $3
        where code_hash = $1 and paired_at is null and code_expires_at > $4
       returning id, customer_id`,
      [codeHash, tokenHash, device, now],
    );
    const offer = claimed.rows[0];
    if (!offer) return null;
    await this.#db.query(`update mq.chrome_links set revoked_at = $3 where customer_id = $1 and id <> $2 and ${ACTIVE}`, [
      offer.customer_id,
      offer.id,
      now,
    ]);
    const { rows } = await this.#db.query<LinkRow>(
      `update mq.chrome_links set paired_at = $2, last_seen_at = $2 where id = $1 returning ${COLUMNS}`,
      [offer.id, now],
    );
    return rows[0] ? toLink(rows[0]) : null;
  }

  async byToken(tokenHash: string): Promise<ChromeLink | null> {
    const { rows } = await this.#db.query<LinkRow>(`select ${COLUMNS} from mq.chrome_links where token_hash = $1 and ${ACTIVE}`, [tokenHash]);
    return rows[0] ? toLink(rows[0]) : null;
  }

  async active(id: CustomerId): Promise<ChromeLink | null> {
    const { rows } = await this.#db.query<LinkRow>(`select ${COLUMNS} from mq.chrome_links where customer_id = $1 and ${ACTIVE}`, [id]);
    return rows[0] ? toLink(rows[0]) : null;
  }

  async seen(linkId: string, at: Date): Promise<void> {
    await this.#db.query(`update mq.chrome_links set last_seen_at = $2 where id = $1 and ${ACTIVE}`, [linkId, at]);
  }

  async revoke(linkId: string, at: Date): Promise<ChromeLink | null> {
    const { rows } = await this.#db.query<LinkRow>(
      `update mq.chrome_links set revoked_at = $2 where id = $1 and ${ACTIVE} returning ${COLUMNS}`,
      [linkId, at],
    );
    return rows[0] ? toLink(rows[0]) : null;
  }
}
