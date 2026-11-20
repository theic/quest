import type { CustomerId, TaskId } from "./ids.ts";

/**
 * A task is one piece of background work by one subagent.
 *
 *   queued ──claim──▶ running ──▶ succeeded | failed | cancelled
 *     ▲                  │
 *     └── answer ◀── waiting (asked the human a question)
 */
export type TaskStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export const FINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(["succeeded", "failed", "cancelled"]);
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ["queued", "running", "waiting"];
export const isFinal = (s: TaskStatus): boolean => FINAL_TASK_STATUSES.has(s);

/**
 * What the next run feeds the subagent. A run that stopped on questions resumes
 * with every answer at once, keyed by the interrupt that asked it.
 */
export type TaskInput =
  | { readonly kind: "start" }
  | { readonly kind: "resume"; readonly answers: Readonly<Record<string, string>> }
  | { readonly kind: "instructions"; readonly text: string };

export interface Task {
  readonly id: TaskId;
  readonly customerId: CustomerId;
  readonly agent: string;
  readonly title: string;
  readonly instructions: string;
  /** The one site the work happens on, when the customer named one ("on X"): x.com. Its tools refuse every other. */
  readonly site: string | null;
  readonly status: TaskStatus;
  readonly nextInput: TaskInput;
  readonly result: string | null;
  readonly error: string | null;
  readonly attempts: number;
  readonly cancelRequested: boolean;
  readonly interruptRequested: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly finishedAt: Date | null;
}

export interface NewTask {
  readonly customerId: CustomerId;
  readonly agent: string;
  readonly title: string;
  readonly instructions: string;
  readonly site?: string | null;
  /** Its place in the queue: 0 answers someone waiting, 1 asked-for work, 2 routine browsing. Unsaid, read off the title (`priorityOf`). */
  readonly priority?: number;
}

/** A task that answers people goes before the rest, whoever started it: the manager, the rotation, or a person by hand. */
export function priorityOf(title: string): number {
  return /(^|[^a-z])(waiting|answers?|repl(y|ies) to|unanswered|inbox)([^a-z]|$)/i.test(title) ? 0 : 1;
}

/** A claimed task, and whether the claim took it over from a worker that stopped mid-run. */
export interface ClaimedTask {
  readonly task: Task;
  readonly recovered: boolean;
}

/** What a running task learns on each lease heartbeat. */
export interface TaskSignals {
  /** False when the lease was lost: another worker owns the task now. */
  readonly held: boolean;
  readonly cancelRequested: boolean;
  readonly interruptRequested: boolean;
}

export type TaskOutcome =
  | { readonly status: "succeeded"; readonly result: string }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "cancelled" };

/** How long one teammate's runs take, start to finish, over the runs that succeeded lately. */
export interface AgentPace {
  readonly agent: string;
  readonly runs: number;
  /** Half the runs finished within this. */
  readonly medianMs: number;
  /** Eight in ten finished within this: the time to promise. */
  readonly p80Ms: number;
}
