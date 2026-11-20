import type { CustomerId, TaskId } from "./ids.ts";

/**
 * What Quest owes, with a time on it:
 *   promise    to the customer: "give me 5 min", "within the hour", "this afternoon"
 *   next_step  in a conversation with someone it found: "check whether dana tried it on Friday"
 * Each one wakes the manager before its time passes, so Quest delivers, or says it needs longer
 * while there is still time to say so. Live, 2026-10-07: asked to come back with a shortlist in two
 * minutes, Quest sent it in 13 seconds and then said it could not schedule anything. Kept or
 * dropped when settled, never deleted.
 */
export const COMMITMENT_KINDS = ["promise", "next_step"] as const;
export type CommitmentKind = (typeof COMMITMENT_KINDS)[number];
export type CommitmentStatus = "open" | "kept" | "dropped";

export interface Commitment {
  readonly id: string;
  readonly customerId: CustomerId;
  readonly kind: CommitmentKind;
  /** What is owed: "the three best people found so far, with links and why". */
  readonly what: string;
  /** How Quest put it to them: "give me 5 min". */
  readonly words: string | null;
  /** Who a next step is about, and where that conversation is. */
  readonly person: string | null;
  readonly url: string | null;
  /** The task doing the work, when one is. */
  readonly taskId: TaskId | null;
  /** The time Quest gave. */
  readonly dueAt: Date;
  /** When the manager is woken for it: a little before dueAt, or at it when `onTime`. */
  readonly checkAt: Date;
  /** They asked for it at that time: it goes out then, not before. */
  readonly onTime: boolean;
  /**
   * "manager" when the manager kept it with a tool; "said" when the code heard a time in what Quest wrote;
   * "asked" when the code heard the time in what they asked for ("get back to me in 5 min").
   */
  readonly source: "manager" | "said" | "asked";
  /** The answer, written already and sent at dueAt without another model call: they asked for it then, not before. */
  readonly held: string | null;
  readonly status: CommitmentStatus;
  /** How often its time was moved. */
  readonly moves: number;
  /** Why it was settled or moved, in a line. */
  readonly note: string | null;
  readonly createdAt: Date;
  readonly closedAt: Date | null;
}

export interface NewCommitment {
  readonly kind: CommitmentKind;
  readonly what: string;
  readonly words: string | null;
  readonly person: string | null;
  readonly url: string | null;
  readonly taskId: TaskId | null;
  readonly dueAt: Date;
  readonly onTime: boolean;
  readonly source: Commitment["source"];
  readonly held?: string | null;
}

const MINUTE = 60_000;

/**
 * When the manager looks at what it owes: early enough to say "I need another 20 min" before the
 * time it gave runs out. A fifth of the window, at least a minute and at most twenty; a window of two
 * minutes or less, and anything they asked for at a time, at the time itself. A next step is done
 * when it falls due.
 */
export function checkTimeFor(kind: CommitmentKind, from: Date, due: Date, onTime: boolean): Date {
  const window = due.getTime() - from.getTime();
  if (kind === "next_step" || onTime || window <= 2 * MINUTE) return due;
  const margin = Math.min(Math.max(window * 0.2, MINUTE), 20 * MINUTE);
  return new Date(due.getTime() - margin);
}
