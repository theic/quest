import type { ChannelKind, CustomerId, Transcript, TranscriptEntry } from "@mq/core";
import type { Queryable } from "./db.ts";

export class PgTranscript implements Transcript {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async recordIncoming(customerId: CustomerId, channel: ChannelKind, ref: string, text: string): Promise<boolean> {
    const { rowCount } = await this.#db.query(
      `insert into mq.transcript (customer_id, direction, channel, ref, body) values ($1, 'in', $2, $3, $4)
       on conflict (customer_id, channel, ref) where direction = 'in' and ref is not null do nothing`,
      [customerId, channel, ref, text],
    );
    return (rowCount ?? 0) > 0;
  }

  async recordOutgoing(customerId: CustomerId, channel: ChannelKind, ref: string | null, text: string): Promise<void> {
    await this.#db.query(
      `insert into mq.transcript (customer_id, direction, channel, ref, body) values ($1, 'out', $2, $3, $4)`,
      [customerId, channel, ref, text],
    );
  }

  async recordReaction(customerId: CustomerId, channel: ChannelKind, ref: string, emoji: string): Promise<void> {
    await this.#db.query(
      `update mq.transcript set reaction = $4 where customer_id = $1 and channel = $2 and ref = $3 and direction = 'in'`,
      [customerId, channel, ref, emoji],
    );
  }

  async recent(customerId: CustomerId, limit: number): Promise<TranscriptEntry[]> {
    const { rows } = await this.#db.query<{ direction: "in" | "out"; body: string; created_at: Date; ref: string | null; reaction: string | null }>(
      `select direction, body, created_at, ref, reaction from mq.transcript where customer_id = $1 order by id desc limit $2`,
      [customerId, limit],
    );
    return rows.reverse().map((r) => ({ direction: r.direction, text: r.body, at: r.created_at, ref: r.ref, reaction: r.reaction }));
  }
}
