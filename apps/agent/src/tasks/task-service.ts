import {
  OPEN_TASK_STATUSES,
  taskId as toTaskId,
  type AgentPace,
  type CustomerId,
  type QuestionRepository,
  type Task,
  type TaskRepository,
  type TaskStatus,
} from "@mq/core";
import type { QuestionAnswerer } from "../questions/question-service.ts";
import type { SubagentCatalog } from "./subagents.ts";

export class UnknownAgentError extends Error {
  constructor(agent: string, known: readonly string[]) {
    super(`There is no "${agent}" on the team. Available: ${known.join(", ")}.`);
    this.name = "UnknownAgentError";
  }
}

export type SteerOutcome =
  | { readonly kind: "unknown" }
  | { readonly kind: "finished"; readonly task: Task }
  | { readonly kind: "queued"; readonly task: Task }
  | { readonly kind: "interrupting"; readonly task: Task }
  | { readonly kind: "answered"; readonly task: Task; readonly questions: number };

export interface BoardCounts {
  readonly queued: number;
  readonly running: number;
  readonly waiting: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The manager's hands on the task queue: start work, look at it, steer it, stop it. */
export class TaskService {
  readonly #tasks: TaskRepository;
  readonly #questions: QuestionRepository;
  readonly #answerer: QuestionAnswerer;
  readonly #catalog: SubagentCatalog;

  constructor(deps: {
    tasks: TaskRepository;
    questions: QuestionRepository;
    answerer: QuestionAnswerer;
    catalog: SubagentCatalog;
  }) {
    this.#tasks = deps.tasks;
    this.#questions = deps.questions;
    this.#answerer = deps.answerer;
    this.#catalog = deps.catalog;
  }

  /** `site`: the one site the work happens on, when the customer named one (x.com); its tools refuse every other. */
  async start(customerId: CustomerId, agent: string, title: string, instructions: string, site: string | null = null, priority?: number): Promise<Task> {
    if (!this.#catalog.get(agent)) throw new UnknownAgentError(agent, this.#catalog.names());
    return this.#tasks.create({ customerId, agent, title: title.slice(0, 120), instructions, site, ...(priority === undefined ? {} : { priority }) });
  }

  /** The task, if it exists and belongs to this customer. */
  async find(customerId: CustomerId, id: string): Promise<Task | null> {
    if (!UUID.test(id)) return null;
    const task = await this.#tasks.get(toTaskId(id));
    return task && task.customerId === customerId ? task : null;
  }

  list(customerId: CustomerId, statuses?: readonly TaskStatus[]): Promise<Task[]> {
    return this.#tasks.listFor(customerId, statuses ? { statuses } : { limit: 30 });
  }

  /** How long each teammate's runs took since then: what estimates are made from. */
  paces(since: Date): Promise<AgentPace[]> {
    return this.#tasks.paces(since);
  }

  async counts(customerId: CustomerId): Promise<BoardCounts> {
    const open = await this.#tasks.listFor(customerId, { statuses: OPEN_TASK_STATUSES, limit: 200 });
    const n = (s: TaskStatus) => open.filter((t) => t.status === s).length;
    return { queued: n("queued"), running: n("running"), waiting: n("waiting") };
  }

  /**
   * New instructions for a task, whatever state it is in: a waiting task gets them
   * as the answer to what it asked; a queued or running one restarts with them.
   */
  async steer(customerId: CustomerId, id: string, text: string): Promise<SteerOutcome> {
    const task = await this.find(customerId, id);
    if (!task) return { kind: "unknown" };
    switch (task.status) {
      case "waiting": {
        const n = await this.#answerer.answerAllForTask(task.id, `New instructions from your manager instead of an answer: ${text}`, "manager");
        return { kind: "answered", task, questions: n };
      }
      case "queued":
      case "running": {
        const updated = await this.#tasks.requestInterrupt(task.id, { kind: "instructions", text });
        if (!updated) return { kind: "finished", task };
        return task.status === "running" ? { kind: "interrupting", task: updated } : { kind: "queued", task: updated };
      }
      default:
        return { kind: "finished", task };
    }
  }

  async cancel(customerId: CustomerId, id: string): Promise<Task | null> {
    const task = await this.find(customerId, id);
    if (!task) return null;
    const updated = await this.#tasks.requestCancel(task.id);
    if (updated?.status === "cancelled") await this.#questions.closeForTask(task.id);
    return updated;
  }
}
