import type { CustomerId, QuestionId, TaskId } from "./ids.ts";

/**
 * Everything that wakes the manager. Events queue per customer in the database,
 * so none is lost to a crash, and the manager reads them in one turn.
 */
export type ManagerEvent =
  /** `ref` is the channel's id for their message, so Quest can react to it. */
  | { readonly kind: "user_message"; readonly text: string; readonly ref?: string }
  | {
      readonly kind: "task_finished";
      readonly taskId: TaskId;
      readonly agent: string;
      readonly outcome: "succeeded" | "failed" | "cancelled";
      readonly summary: string;
    }
  | {
      readonly kind: "question_raised";
      readonly questionId: QuestionId;
      readonly taskId: TaskId;
      readonly agent: string;
      readonly text: string;
    }
  | { readonly kind: "question_answered"; readonly questionId: QuestionId; readonly answer: string }
  | { readonly kind: "heartbeat" }
  /** Time to follow up a question the customer has not answered (set by the turn that asked it). */
  | { readonly kind: "follow_up" }
  /** Something Quest owes falls due, or is about to: deliver it, or say it needs longer (commitments.ts). */
  | { readonly kind: "commitment_due"; readonly commitmentId: string }
  /** The customer's evening: time for the day's report. `day` is their local date. */
  | { readonly kind: "day_report"; readonly day: string }
  | { readonly kind: "system"; readonly topic: string; readonly text: string };

export type ManagerEventKind = ManagerEvent["kind"];

export interface QueuedEvent {
  readonly id: string;
  readonly customerId: CustomerId;
  readonly event: ManagerEvent;
  /** How many turns have tried this event, this one included. */
  readonly attempts: number;
  readonly createdAt: Date;
}

/** A turn is a "user turn" when the person said something: its final words go back to them. */
export const hasUserMessage = (events: readonly QueuedEvent[]): boolean =>
  events.some((e) => e.event.kind === "user_message");
