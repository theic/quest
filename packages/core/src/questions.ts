import type { CustomerId, QuestionId, TaskId } from "./ids.ts";

/**
 * A question a subagent needs a human to answer. The subagent's run stops while
 * it waits; the manager decides when, and whether, the person is asked.
 *
 *   pending ──ask──▶ asked ──▶ answered
 *      └──────────────┴──────▶ dismissed
 */
export type QuestionStatus = "pending" | "asked" | "answered" | "dismissed";
export type AnsweredBy = "user" | "manager";

export interface Question {
  readonly id: QuestionId;
  readonly customerId: CustomerId;
  readonly taskId: TaskId;
  /** The LangGraph interrupt that is waiting for this answer. */
  readonly interruptId: string;
  readonly agent: string;
  readonly text: string;
  readonly options: readonly string[];
  readonly why: string | null;
  readonly status: QuestionStatus;
  readonly answer: string | null;
  readonly answeredBy: AnsweredBy | null;
  /** The channel message that carries the question, so a reply to it answers it. */
  readonly askedRef: string | null;
  readonly createdAt: Date;
  readonly askedAt: Date | null;
  readonly answeredAt: Date | null;
}

export interface NewQuestion {
  readonly customerId: CustomerId;
  readonly taskId: TaskId;
  readonly interruptId: string;
  readonly agent: string;
  readonly text: string;
  readonly options: readonly string[];
  readonly why: string | null;
}

export const isOpen = (q: Pick<Question, "status">): boolean => q.status === "pending" || q.status === "asked";

/**
 * How many more questions may go to the person right now. A few at a time keeps
 * the chat readable; the rest wait in the queue until earlier ones are answered.
 */
export const askBudget = (outstanding: number, cap: number): number => Math.max(0, cap - outstanding);
