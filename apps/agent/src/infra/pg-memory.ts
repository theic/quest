import {
  customerId,
  taskId,
  type CustomerId,
  type DayFacts,
  type DayLedger,
  type Memory,
  type MemoryKind,
  type MemoryRepository,
  type NewMemory,
} from "@mq/core";
import type { Queryable } from "./db.ts";

interface MemoryRow {
  id: string;
  customer_id: string;
  kind: MemoryKind;
  body: string;
  source: Memory["source"];
  created_at: Date;
}

const toMemory = (r: MemoryRow): Memory => ({
  id: String(r.id),
  customerId: customerId(r.customer_id),
  kind: r.kind,
  text: r.body,
  source: r.source,
  createdAt: r.created_at,
});

/** What Quest keeps for good, in mq.memories. A memory that stops being true is retired, not deleted. */
export class PgMemoryRepository implements MemoryRepository {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async add(id: CustomerId, m: NewMemory): Promise<{ memory: Memory; added: boolean }> {
    const text = m.text.trim().slice(0, 500);
    const { rows } = await this.#db.query<MemoryRow>(
      `insert into mq.memories (customer_id, kind, body, source) values ($1, $2, $3, $4)
       on conflict (customer_id, lower(body)) where retired_at is null do nothing
       returning id, customer_id, kind, body, source, created_at`,
      [id, m.kind, text, m.source],
    );
    if (rows[0]) return { memory: toMemory(rows[0]), added: true };
    const had = await this.#db.query<MemoryRow>(
      `select id, customer_id, kind, body, source, created_at from mq.memories
        where customer_id = $1 and lower(body) = lower($2) and retired_at is null`,
      [id, text],
    );
    if (!had.rows[0]) throw new Error("memory neither added nor found");
    return { memory: toMemory(had.rows[0]), added: false };
  }

  async retire(id: CustomerId, memoryId: string): Promise<Memory | null> {
    if (!/^\d+$/.test(memoryId)) return null;
    const { rows } = await this.#db.query<MemoryRow>(
      `update mq.memories set retired_at = now()
        where customer_id = $1 and id = $2 and retired_at is null
       returning id, customer_id, kind, body, source, created_at`,
      [id, memoryId],
    );
    return rows[0] ? toMemory(rows[0]) : null;
  }

  async list(id: CustomerId, limit: number): Promise<Memory[]> {
    const { rows } = await this.#db.query<MemoryRow>(
      `select id, customer_id, kind, body, source, created_at from mq.memories
        where customer_id = $1 and retired_at is null
        order by created_at desc, id desc limit $2`,
      [id, limit],
    );
    return rows.map(toMemory);
  }
}

/** A customer's day as the record has it: what ran, what was found, what they did, what came back. */
export class PgDayLedger implements DayLedger {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async day(id: CustomerId, since: Date): Promise<DayFacts> {
    const [tasks, saved, decided, watch, places, chat] = await Promise.all([
      this.#db.query<{ agent: string; title: string; status: string }>(
        `select agent, title, status from mq.tasks
          where customer_id = $1 and (finished_at >= $2 or (status in ('queued', 'running', 'waiting') and created_at >= $2))
          order by created_at`,
        [id, since],
      ),
      this.#db.query<{ source: string; n: number }>(
        `select source, count(*)::int as n from mq.finds where customer_id = $1 and created_at >= $2 group by source order by n desc`,
        [id, since],
      ),
      this.#db.query<{ shown: number; kept: number; skipped: number; replied: number; posted: number }>(
        `select count(*) filter (where shown_at >= $2)::int as shown,
                count(*) filter (where decided_at >= $2 and status = 'kept')::int as kept,
                count(*) filter (where decided_at >= $2 and status = 'skipped')::int as skipped,
                count(*) filter (where decided_at >= $2 and status = 'replied')::int as replied,
                count(*) filter (where sent_at >= $2)::int as posted
           from mq.finds where customer_id = $1`,
        [id, since],
      ),
      this.#db.query<{ answers: number; removed: number }>(
        `select count(*) filter (where payload->>'topic' = 'answers')::int as answers,
                count(*) filter (where payload->>'topic' = 'removed')::int as removed
           from mq.events where customer_id = $1 and kind = 'system' and created_at >= $2`,
        [id, since],
      ),
      this.#db.query<{ name: string; verdict: string }>(
        `select name, verdict from mq.places where customer_id = $1 and updated_at >= $2 order by updated_at`,
        [id, since],
      ),
      this.#db.query<{ incoming: number; outgoing: number }>(
        `select count(*) filter (where direction = 'in')::int as incoming,
                count(*) filter (where direction = 'out')::int as outgoing
           from mq.transcript where customer_id = $1 and created_at >= $2`,
        [id, since],
      ),
    ]);
    const d = decided.rows[0]!;
    return {
      since,
      tasks: tasks.rows,
      saved: Object.fromEntries(saved.rows.map((r) => [r.source, r.n])),
      shown: d.shown,
      kept: d.kept,
      skipped: d.skipped,
      replied: d.replied,
      posted: d.posted,
      answers: watch.rows[0]!.answers,
      removed: watch.rows[0]!.removed,
      places: places.rows,
      messagesIn: chat.rows[0]!.incoming,
      messagesOut: chat.rows[0]!.outgoing,
    };
  }
}
