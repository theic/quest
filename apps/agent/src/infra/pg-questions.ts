import {
  customerId,
  questionId,
  taskId,
  type AnsweredBy,
  type CustomerId,
  type NewQuestion,
  type Question,
  type QuestionId,
  type QuestionRepository,
  type QuestionStatus,
  type TaskId,
} from "@mq/core";
import type { Queryable } from "./db.ts";

interface QuestionRow {
  id: string;
  customer_id: string;
  task_id: string;
  interrupt_id: string;
  agent: string;
  body: string;
  options: string[];
  why: string | null;
  status: QuestionStatus;
  answer: string | null;
  answered_by: AnsweredBy | null;
  asked_ref: string | null;
  created_at: Date;
  asked_at: Date | null;
  answered_at: Date | null;
}

const COLUMNS = `q.id, q.customer_id, q.task_id, q.interrupt_id, q.agent, q.body, q.options, q.why, q.status,
  q.answer, q.answered_by, q.asked_ref, q.created_at, q.asked_at, q.answered_at`;

const toQuestion = (r: QuestionRow): Question => ({
  id: questionId(r.id),
  customerId: customerId(r.customer_id),
  taskId: taskId(r.task_id),
  interruptId: r.interrupt_id,
  agent: r.agent,
  text: r.body,
  options: r.options,
  why: r.why,
  status: r.status,
  answer: r.answer,
  answeredBy: r.answered_by,
  askedRef: r.asked_ref,
  createdAt: r.created_at,
  askedAt: r.asked_at,
  answeredAt: r.answered_at,
});

const one = (rows: QuestionRow[]): Question | null => (rows[0] ? toQuestion(rows[0]) : null);

export class PgQuestionRepository implements QuestionRepository {
  readonly #db: Queryable;

  constructor(db: Queryable) {
    this.#db = db;
  }

  async create(input: NewQuestion): Promise<Question> {
    // The same interrupt raised again (a run replayed after a crash) is the same question.
    const { rows } = await this.#db.query<QuestionRow>(
      `insert into mq.questions as q (customer_id, task_id, interrupt_id, agent, body, options, why)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (task_id, interrupt_id) do update set body = excluded.body
       returning ${COLUMNS}`,
      [
        input.customerId,
        input.taskId,
        input.interruptId,
        input.agent,
        input.text,
        JSON.stringify(input.options),
        input.why,
      ],
    );
    const q = one(rows);
    if (!q) throw new Error("question insert returned nothing");
    return q;
  }

  async get(id: QuestionId): Promise<Question | null> {
    const { rows } = await this.#db.query<QuestionRow>(`select ${COLUMNS} from mq.questions q where q.id = $1`, [id]);
    return one(rows);
  }

  async listFor(customerId: CustomerId, statuses: readonly QuestionStatus[]): Promise<Question[]> {
    const { rows } = await this.#db.query<QuestionRow>(
      `select ${COLUMNS} from mq.questions q where q.customer_id = $1 and q.status = any($2::text[])
        order by q.created_at`,
      [customerId, [...statuses]],
    );
    return rows.map(toQuestion);
  }

  async listForTask(taskId: TaskId, statuses: readonly QuestionStatus[]): Promise<Question[]> {
    const { rows } = await this.#db.query<QuestionRow>(
      `select ${COLUMNS} from mq.questions q where q.task_id = $1 and q.status = any($2::text[])
        order by q.created_at`,
      [taskId, [...statuses]],
    );
    return rows.map(toQuestion);
  }

  async findByAskedRef(customerId: CustomerId, ref: string): Promise<Question | null> {
    const { rows } = await this.#db.query<QuestionRow>(
      `select ${COLUMNS} from mq.questions q where q.customer_id = $1 and q.asked_ref = $2
        order by q.created_at desc limit 1`,
      [customerId, ref],
    );
    return one(rows);
  }

  async markAsked(id: QuestionId, ref: string | null): Promise<void> {
    await this.#db.query(
      `update mq.questions set status = 'asked', asked_ref = coalesce($2, asked_ref), asked_at = now()
        where id = $1 and status in ('pending', 'asked')`,
      [id, ref],
    );
  }

  async answer(id: QuestionId, answer: string, by: AnsweredBy): Promise<Question | null> {
    const { rows } = await this.#db.query<QuestionRow>(
      `update mq.questions q set status = 'answered', answer = $2, answered_by = $3, answered_at = now()
        where q.id = $1 and q.status in ('pending', 'asked') returning ${COLUMNS}`,
      [id, answer, by],
    );
    return one(rows);
  }

  async dismiss(id: QuestionId, note: string): Promise<Question | null> {
    const { rows } = await this.#db.query<QuestionRow>(
      `update mq.questions q set status = 'dismissed', answer = $2, answered_by = 'manager', answered_at = now()
        where q.id = $1 and q.status in ('pending', 'asked') returning ${COLUMNS}`,
      [id, note],
    );
    return one(rows);
  }

  async closeForTask(id: TaskId): Promise<void> {
    await this.#db.query(
      `update mq.questions set status = 'dismissed', answered_at = now()
        where task_id = $1 and status in ('pending', 'asked')`,
      [id],
    );
  }
}
