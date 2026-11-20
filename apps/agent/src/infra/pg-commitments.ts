import { customerId, taskId, type Commitment, type CommitmentKind, type CommitmentRepository, type CommitmentStatus, type CustomerId, type NewCommitment } from "@mq/core";
import type { Queryable } from "./db.ts";

interface Row {
  id: string;
  customer_id: string;
  kind: CommitmentKind;
  what: string;
  words: string | null;
  person: string | null;
  url: string | null;
  task_id: string | null;
  due_at: Date;
  check_at: Date;
  on_time: boolean;
  source: Commitment["source"];
  status: CommitmentStatus;
  moves: number;
  note: string | null;
  created_at: Date;
  closed_at: Date | null;
  held: string | null;
}

const COLUMNS = "id, customer_id, kind, what, words, person, url, task_id, due_at, check_at, on_time, source, status, moves, note, created_at, closed_at, held";

const toCommitment = (r: Row): Commitment => ({
  id: String(r.id),
  customerId: customerId(r.customer_id),
  kind: r.kind,
  what: r.what,
  words: r.words,
  person: r.person,
  url: r.url,
  taskId: r.task_id ? taskId(r.task_id) : null,
  dueAt: r.due_at,
  checkAt: r.check_at,
  onTime: r.on_time,
  source: r.source,
  status: r.status,
  moves: r.moves,
  note: r.note,
  createdAt: r.created_at,
  closedAt: r.closed_at,
  held: r.held,
});

const isId = (id: string): boolean => /^\d+$/.test(id);
const clip = (s: string | null, n: number): string | null => (s === null ? null : s.trim().slice(0, n));

/** What Quest owes, in mq.commitments. Settled ones stay, with how they were settled. */
export class PgCommitmentRepository implements CommitmentRepository {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async add(id: CustomerId, c: NewCommitment, checkAt: Date): Promise<Commitment> {
    const { rows } = await this.#db.query<Row>(
      `insert into mq.commitments (customer_id, kind, what, words, person, url, task_id, due_at, check_at, on_time, source, held)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning ${COLUMNS}`,
      [id, c.kind, c.what.trim().slice(0, 500), clip(c.words, 200), clip(c.person, 200), clip(c.url, 2000), c.taskId, c.dueAt, checkAt, c.onTime, c.source, clip(c.held ?? null, 4000)],
    );
    return toCommitment(rows[0]!);
  }

  async get(id: CustomerId, commitment: string): Promise<Commitment | null> {
    if (!isId(commitment)) return null;
    const { rows } = await this.#db.query<Row>(`select ${COLUMNS} from mq.commitments where customer_id = $1 and id = $2`, [id, commitment]);
    return rows[0] ? toCommitment(rows[0]) : null;
  }

  async open(id: CustomerId): Promise<Commitment[]> {
    const { rows } = await this.#db.query<Row>(`select ${COLUMNS} from mq.commitments where customer_id = $1 and status = 'open' order by due_at, id`, [id]);
    return rows.map(toCommitment);
  }

  async close(id: CustomerId, commitment: string, status: "kept" | "dropped", note: string | null): Promise<Commitment | null> {
    if (!isId(commitment)) return null;
    const { rows } = await this.#db.query<Row>(
      `update mq.commitments set status = $3, note = coalesce($4, note), closed_at = now()
        where customer_id = $1 and id = $2 and status = 'open' returning ${COLUMNS}`,
      [id, commitment, status, clip(note, 500)],
    );
    return rows[0] ? toCommitment(rows[0]) : null;
  }

  async move(id: CustomerId, commitment: string, change: { dueAt: Date; checkAt: Date; words: string | null; note: string | null }): Promise<Commitment | null> {
    if (!isId(commitment)) return null;
    const { rows } = await this.#db.query<Row>(
      `update mq.commitments set due_at = $3, check_at = $4, words = coalesce($5, words), note = coalesce($6, note), moves = moves + 1
        where customer_id = $1 and id = $2 and status = 'open' returning ${COLUMNS}`,
      [id, commitment, change.dueAt, change.checkAt, clip(change.words, 200), clip(change.note, 500)],
    );
    return rows[0] ? toCommitment(rows[0]) : null;
  }

  async settled(id: CustomerId, limit: number): Promise<Commitment[]> {
    const { rows } = await this.#db.query<Row>(
      `select ${COLUMNS} from mq.commitments where customer_id = $1 and status <> 'open' order by closed_at desc limit $2`,
      [id, limit],
    );
    return rows.map(toCommitment);
  }
}
