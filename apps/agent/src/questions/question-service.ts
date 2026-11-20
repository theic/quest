import {
  askBudget,
  type AnsweredBy,
  type CustomerId,
  type EventSink,
  type Logger,
  type OutgoingQuestion,
  type Question,
  type QuestionId,
  type QuestionRepository,
  type Task,
  type TaskId,
  type TaskRepository,
} from "@mq/core";
import type { AskDeck } from "../asks/deck.ts";
import type { Messenger } from "../conversation/messenger.ts";

/** What a subagent's `ask_human` interrupt carries. */
export interface RaisedQuestion {
  readonly interruptId: string;
  readonly text: string;
  readonly options: readonly string[];
  readonly why: string | null;
}

export interface AskOutcome {
  /** Now in front of the person (or already were). */
  readonly sent: readonly QuestionId[];
  /** Kept back: the person already has as many open questions as the chat should hold. */
  readonly held: readonly QuestionId[];
  readonly unknown: readonly string[];
}

/** What steering a waiting task needs from the question queue. */
export interface QuestionAnswerer {
  answerAllForTask(taskId: TaskId, text: string, by: AnsweredBy): Promise<number>;
}

const outgoing = (q: Question): OutgoingQuestion => ({ id: q.id, text: q.text, options: q.options });

/** What the waiting subagent reads back from its `ask_human` call. */
const resumeValue = (q: Question): string =>
  q.status === "answered" ? `The person answered: ${q.answer ?? ""}` : `Nobody answered this. ${q.answer ?? ""}`.trim();

/**
 * The queue of questions subagents need a human for. Subagents raise them and
 * stop; the manager chooses which reach the person and when, or answers them
 * itself; an answer resumes the task once every question it asked is settled.
 */
export class QuestionService implements QuestionAnswerer {
  readonly #questions: QuestionRepository;
  readonly #tasks: TaskRepository;
  readonly #events: EventSink;
  readonly #messenger: Messenger;
  readonly #askCap: number;
  readonly #log: Logger;
  #deck: AskDeck | null;

  constructor(deps: {
    questions: QuestionRepository;
    tasks: TaskRepository;
    events: EventSink;
    messenger: Messenger;
    askCap: number;
    log: Logger;
    /** Your move (asks/deck.ts): a question goes there, not on a card of its own. */
    deck?: AskDeck;
  }) {
    this.#deck = deps.deck ?? null;
    this.#questions = deps.questions;
    this.#tasks = deps.tasks;
    this.#events = deps.events;
    this.#messenger = deps.messenger;
    this.#askCap = deps.askCap;
    this.#log = deps.log;
  }

  /** The deck comes after the questions in the wiring (it reads them): it is handed over once made. */
  useDeck(deck: AskDeck): void {
    this.#deck = deck;
  }

  /** A subagent's run stopped on questions: queue them and tell the manager about the new ones. */
  async raise(task: Task, raised: readonly RaisedQuestion[]): Promise<Question[]> {
    const known = new Set((await this.#questions.listForTask(task.id, ["pending", "asked", "answered", "dismissed"])).map((q) => q.interruptId));
    const out: Question[] = [];
    for (const r of raised) {
      const q = await this.#questions.create({
        customerId: task.customerId,
        taskId: task.id,
        interruptId: r.interruptId,
        agent: task.agent,
        text: r.text,
        options: r.options,
        why: r.why,
      });
      out.push(q);
      if (known.has(r.interruptId)) continue; // a replayed run raising the same interrupt again
      await this.#events.push(task.customerId, {
        kind: "question_raised",
        questionId: q.id,
        taskId: task.id,
        agent: task.agent,
        text: q.text,
      });
    }
    return out;
  }

  open(customerId: CustomerId): Promise<Question[]> {
    return this.#questions.listFor(customerId, ["pending", "asked"]);
  }

  /** Puts questions in front of the person, never more than the chat should hold at once. */
  async ask(customerId: CustomerId, ids: readonly string[]): Promise<AskOutcome> {
    const open = await this.open(customerId);
    const byId = new Map<string, Question>(open.map((q) => [q.id, q]));
    let budget = askBudget(open.filter((q) => q.status === "asked").length, this.#askCap);
    const sent: QuestionId[] = [];
    const held: QuestionId[] = [];
    const unknown: string[] = [];
    for (const id of ids) {
      const q = byId.get(id);
      if (!q) {
        unknown.push(id);
      } else if (q.status === "asked") {
        sent.push(q.id);
      } else if (budget <= 0) {
        held.push(q.id);
      } else {
        const ref = this.#deck ? null : await this.#messenger.ask(customerId, outgoing(q));
        await this.#questions.markAsked(q.id, ref);
        budget--;
        sent.push(q.id);
      }
    }
    if (this.#deck && sent.length) await this.#deck.changed(customerId);
    return { sent, held, unknown };
  }

  /** The question this reply answers, if the person replied to a question message. */
  async findAskedByRef(customerId: CustomerId, ref: string): Promise<Question | null> {
    const q = await this.#questions.findByAskedRef(customerId, ref);
    return q && q.status === "asked" ? q : null;
  }

  async answer(id: QuestionId, answer: string, by: AnsweredBy): Promise<Question | null> {
    const q = await this.#questions.answer(id, answer, by);
    if (!q) return null;
    await this.#showOnCard(q, by === "manager" ? `${answer} (answered by Quest)` : answer);
    if (by === "user") await this.#events.push(q.customerId, { kind: "question_answered", questionId: q.id, answer });
    await this.resumeIfSettled(q.taskId);
    return q;
  }

  /** A button press: the option's words are the answer. Only the customer who was asked can answer. */
  async choose(customerId: CustomerId, id: QuestionId, option: number): Promise<Question | null> {
    const q = await this.#questions.get(id);
    const text = q?.options[option];
    if (!q || q.customerId !== customerId || text === undefined) return null;
    return this.answer(id, text, "user");
  }

  async dismiss(id: QuestionId, note: string): Promise<Question | null> {
    const q = await this.#questions.dismiss(id, note);
    if (!q) return null;
    await this.#showOnCard(q, "No longer needed");
    await this.resumeIfSettled(q.taskId);
    return q;
  }

  async answerAllForTask(taskId: TaskId, text: string, by: AnsweredBy): Promise<number> {
    const open = await this.#questions.listForTask(taskId, ["pending", "asked"]);
    for (const q of open) {
      const answered = await this.#questions.answer(q.id, text, by);
      if (answered) await this.#showOnCard(answered, by === "manager" ? "Settled by Quest" : text);
    }
    await this.resumeIfSettled(taskId);
    return open.length;
  }

  async #showOnCard(q: Question, answer: string): Promise<void> {
    try {
      if (!q.askedRef) {
        await this.#deck?.changed(q.customerId, { last: answer });
        return;
      }
      await this.#messenger.showAnswer(q.customerId, q.askedRef, outgoing(q), answer);
    } catch (e) {
      this.#log.warn("questions.show_answer_failed", { questionId: q.id, error: String(e) });
    }
  }

  /**
   * Once nothing the task asked is still open, its run resumes with every answer at
   * once. Also called by the runner right after it parks a task, in case the answers
   * arrived while the run was still stopping.
   */
  async resumeIfSettled(taskId: TaskId): Promise<void> {
    if ((await this.#questions.listForTask(taskId, ["pending", "asked"])).length) return;
    const settled = await this.#questions.listForTask(taskId, ["answered", "dismissed"]);
    if (!settled.length) return;
    const answers = Object.fromEntries(settled.map((q) => [q.interruptId, resumeValue(q)]));
    await this.#tasks.requeue(taskId, { kind: "resume", answers });
  }
}
