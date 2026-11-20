import type { BoardRepository, ChannelKind, CustomerId, PinnedBoard } from "@mq/core";
import { customerId as toCustomerId } from "@mq/core";
import type { Queryable } from "./db.ts";

interface BoardRow {
  customer_id: string;
  channel: ChannelKind;
  address: string;
  ref: string;
}

const pinned = (r: BoardRow): PinnedBoard => ({ to: { kind: r.channel, address: r.address }, ref: r.ref });

/** mq.task_boards: where each customer's progress board is pinned, while one is. */
export class PgBoards implements BoardRepository {
  readonly #db: Queryable;
  readonly #lane: string;

  /** `lane`: the boards this agent tidies after a restart are its own lane's. */
  constructor(db: Queryable, lane = "live") {
    this.#db = db;
    this.#lane = lane;
  }

  async get(customer: CustomerId): Promise<PinnedBoard | null> {
    const { rows } = await this.#db.query<BoardRow>(`select customer_id, channel, address, ref from mq.task_boards where customer_id = $1`, [customer]);
    return rows[0] ? pinned(rows[0]) : null;
  }

  async save(customer: CustomerId, board: PinnedBoard): Promise<void> {
    await this.#db.query(
      `insert into mq.task_boards (customer_id, channel, address, ref) values ($1, $2, $3, $4)
       on conflict (customer_id) do update set channel = excluded.channel, address = excluded.address, ref = excluded.ref, created_at = now()`,
      [customer, board.to.kind, board.to.address, board.ref],
    );
  }

  async clear(customer: CustomerId, ref: string): Promise<void> {
    await this.#db.query(`delete from mq.task_boards where customer_id = $1 and ref = $2`, [customer, ref]);
  }

  async list(): Promise<{ customerId: CustomerId; board: PinnedBoard }[]> {
    const { rows } = await this.#db.query<BoardRow>(
      `select b.customer_id, b.channel, b.address, b.ref from mq.task_boards b join mq.customers c on c.id = b.customer_id where c.lane = $1`,
      [this.#lane],
    );
    return rows.map((r) => ({ customerId: toCustomerId(r.customer_id), board: pinned(r) }));
  }
}
