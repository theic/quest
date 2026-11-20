import type { CustomerId, TaskId } from "./ids.ts";

/**
 * What Quest keeps for good about one customer, whatever happens to the chat:
 *   decision  what the customer decided, wants or does not want
 *   lesson    what went wrong or worked, and what to do differently
 *   fact      about them, beyond the brief (where they are, their constraints)
 *   voice     how their words sound, or what they never say: the writer reads every one
 * The manager reads all of it at the start of every turn, and every teammate
 * reads the decisions, voice and lessons before a task, so a mistake is made once.
 */
export const MEMORY_KINDS = ["decision", "lesson", "fact", "voice"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface Memory {
  readonly id: string;
  readonly customerId: CustomerId;
  readonly kind: MemoryKind;
  readonly text: string;
  /** "system" when the code noticed it (a reply taken down), not the manager. */
  readonly source: "manager" | "system";
  readonly createdAt: Date;
}

export interface NewMemory {
  readonly kind: MemoryKind;
  readonly text: string;
  readonly source: Memory["source"];
}

/** What happened in a customer's day, counted from the record, for the evening report. */
export interface DayFacts {
  readonly since: Date;
  readonly tasks: readonly { readonly agent: string; readonly title: string; readonly status: string }[];
  /** Finds saved, by where they came from: "reddit:r/nocode" → 2. */
  readonly saved: Readonly<Record<string, number>>;
  readonly shown: number;
  readonly kept: number;
  readonly skipped: number;
  readonly replied: number;
  readonly posted: number;
  /** Replies someone answered, and replies taken down, from the reply watch. */
  readonly answers: number;
  readonly removed: number;
  readonly places: readonly { readonly name: string; readonly verdict: string }[];
  readonly messagesIn: number;
  readonly messagesOut: number;
}
