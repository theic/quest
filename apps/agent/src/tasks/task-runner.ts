import { languageBriefing } from "@mq/i18n";
import { HumanMessage } from "@langchain/core/messages";
import { keepLessons, WHAT_WORKS } from "./kept-lessons.ts";
import { Command, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { CustomerId, CustomerRepository, EventSink, Logger, MemoryRepository, PlaceRepository, SearchLog, SpendLog, Task, TaskId, TaskInput, TaskQueue, TaskRepository, WebReach } from "@mq/core";
import { buildAgent, finalText, interruptsOf, type PendingInterrupt, type RunnableAgent, type ThreadConfig } from "../agents/harness.ts";
import type { ModelProvider, ModelRole } from "../agents/models.ts";
import { noteModelCall } from "../agents/spend.ts";
import { clip, errorText, Sleeper } from "../lib/sleeper.ts";
import type { QuestionService, RaisedQuestion } from "../questions/question-service.ts";
import { askHumanTool, isAskHumanRequest } from "./ask-human.ts";
import type { FindLedger } from "../finds/find-service.ts";
import type { PairFinder } from "../finds/pair-finder.ts";
import type { KnownPeople } from "../infra/pg-known.ts";
import type { PlayFinder } from "../finds/play-finder.ts";
import type { Acquaintances } from "../contacts/acquaintances.ts";
import type { SubagentCatalog, SubagentContext, SubagentSpec } from "./subagents.ts";
import { BROWSING, type CustomerBrowser } from "../chrome/browser.ts";
import type { DraftService } from "../drafts/draft-service.ts";
import type { TaskProgress } from "./task-board.ts";
import { SearchTrail, searchesBlock } from "./search-trail.ts";
import { pinToSite, siteBriefing } from "./site-pin.ts";
import { modelRest } from "../lib/model-rest.ts";

/** How far back a run looks at the searches before it, and at most how many it reads. */
const SEARCHES_LOOKED_AT = { days: 30, limit: 300 } as const;

/** A teammate whose runs find people (it saves finds or drafts messages): what its searches came to is kept and shown. */
const findsPeople = (tools: readonly { name: string }[]): boolean => tools.some((t) => t.name === "save_find" || t.name === "outreach_draft");

export interface TaskRunnerOptions {
  readonly worker: string;
  /** Tasks this process runs at once. */
  readonly concurrency: number;
  /** Tasks one customer may have running at once, across all workers. */
  readonly perCustomer: number;
  /** Teammates of whom a customer has one at work at a time: those that work in their Chrome, whose front one run holds. */
  readonly solo?: readonly string[];
  readonly leaseMs: number;
  readonly pollMs: number;
  readonly maxAttempts: number;
  /** First pause before retrying a failed model call inside a run. */
  readonly modelRetryDelayMs?: number;
}

/** How long a run that needs their Chrome waits before it looks for it again. */
const CHROME_WAIT_MS = 20_000;

export interface TaskRunnerDeps {
  /** Whether their Chrome is asking for work (`ChromeBroker.online`). */
  readonly chromeOnline?: (customerId: CustomerId) => boolean;
  readonly browser?: CustomerBrowser;
  readonly drafts?: DraftService;
  readonly queue: TaskQueue;
  readonly tasks: TaskRepository;
  readonly questions: QuestionService;
  readonly events: EventSink;
  readonly catalog: SubagentCatalog;
  readonly models: ModelProvider;
  /** What each customer's tasks read and search the web with (their Chrome, and the public APIs). */
  readonly reach: WebReach;
  readonly customers: Pick<CustomerRepository, "get">;
  readonly finds: FindLedger;
  readonly places: PlaceRepository;
  /** What the customer decided and what the team learned: every task reads it before it starts. */
  readonly memory: MemoryRepository;
  readonly checkpointer: BaseCheckpointSaver;
  /** Every model call's tokens and cost. */
  readonly spend?: SpendLog;
  /** What each run's searches came to: kept as the run ends, and shown to the next run. */
  readonly searches?: SearchLog;
  /** People for a play, found by code: outreach's find_people. */
  readonly finder?: PlayFinder;
  /** A page of people for what someone built: outreach's page_for. */
  readonly pageFor?: (customerId: CustomerId, who: { readonly maker: string; readonly url: string; readonly made: string }) => Promise<{ readonly link: string; readonly people: number } | string>;
  /** People who need each other, matched by code: outreach's find_pairs. */
  readonly pairs?: PairFinder;
  /** The shared cache of people: what a check finds that is public goes there too. */
  readonly known?: KnownPeople;
  /** The people Quest got to know for them, kept for good. */
  readonly people?: Acquaintances;
  /** The customer's view of each run as it goes: the progress board pinned in their chat. */
  readonly progress?: TaskProgress;
  /** Teammates moved to another seat than their spec's (`AGENT_SEATS`), by name. */
  readonly seats?: Readonly<Record<string, ModelRole>>;
  readonly log: Logger;
}

/** Why a run stopped: "rest" when its customer's day's credits ran out (billing/energy.ts), "off" when they switched Quest off. */
type StopReason = "cancel" | "interrupt" | "lost" | "shutdown" | "rest" | "off";

/** Where a claimed task's next run starts from. */
type RunPlan = { readonly kind: "invoke"; readonly input: unknown } | { readonly kind: "wait"; readonly interrupts: readonly PendingInterrupt[] };

interface Running {
  readonly customerId: CustomerId;
  readonly controller: AbortController;
  reason: StopReason | null;
  /** When a run stopped for its customer's rest may go on. */
  restUntil: Date | null;
  done: Promise<void>;
}

const threadOf = (id: TaskId): string => `task:${id}`;

/**
 * Runs subagent tasks in the background. Each task runs on its own LangGraph
 * thread, checkpointed in Postgres, under a lease it renews while it works:
 *
 * - a question (`ask_human`) parks the task and frees the worker until it is answered;
 * - a cancel or new instructions from the manager stop the run at once;
 * - a worker that dies loses its lease, and the next claim continues from the checkpoint.
 */
export class TaskRunner {
  readonly #d: TaskRunnerDeps;
  readonly #o: TaskRunnerOptions;
  readonly #running = new Map<TaskId, Running>();
  readonly #sleeper = new Sleeper();
  #started = false;
  #stopping = false;
  #loop: Promise<void> | null = null;

  constructor(deps: TaskRunnerDeps, options: TaskRunnerOptions) {
    this.#d = deps;
    this.#o = options;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#stopping = false;
    this.#loop = this.#pollLoop();
  }

  wake(): void {
    this.#sleeper.wake();
  }

  /** True while a task is running here. */
  get busy(): boolean {
    return this.#running.size > 0;
  }

  /** Stops claiming, stops the runs in flight and hands their tasks back to the queue; `start()` picks up again. */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#sleeper.wake();
    for (const r of this.#running.values()) {
      r.reason = "shutdown";
      r.controller.abort();
    }
    await Promise.allSettled([this.#loop, ...[...this.#running.values()].map((r) => r.done)]);
    this.#loop = null;
    this.#started = false;
  }

  /**
   * Their day's credits are spent: their runs in flight stop and go back to the queue, to go on from where they were
   * once the rest is over (the queue claims nothing of theirs until then).
   */
  rest(customerId: CustomerId, until: Date): void {
    for (const r of this.#running.values()) {
      if (r.customerId !== customerId || r.reason) continue;
      r.reason = "rest";
      r.restUntil = until;
      r.controller.abort();
    }
  }

  /**
   * They switched Quest off: their runs in flight stop and go back to the queue, to go on from where they were once it
   * is on again (the queue claims nothing of theirs meanwhile).
   */
  pause(customerId: CustomerId): void {
    for (const r of this.#running.values()) {
      if (r.customerId !== customerId || r.reason) continue;
      r.reason = "off";
      r.controller.abort();
    }
  }

  /** Claims and runs one task to its next stop; returns false when nothing was claimable. For tests and the loop. */
  async runNext(): Promise<boolean> {
    const claimed = await this.#d.queue.claim(this.#o.worker, this.#o.leaseMs, this.#o.perCustomer, this.#o.solo);
    if (!claimed) return false;
    await this.#track(claimed.task, claimed.recovered);
    return true;
  }

  async #pollLoop(): Promise<void> {
    while (!this.#stopping) {
      try {
        if (this.#running.size < this.#o.concurrency) {
          const claimed = await this.#d.queue.claim(this.#o.worker, this.#o.leaseMs, this.#o.perCustomer, this.#o.solo);
          if (claimed) {
            void this.#track(claimed.task, claimed.recovered);
            continue;
          }
        }
      } catch (e) {
        this.#d.log.error("tasks.claim_failed", { error: errorText(e) });
      }
      await this.#sleeper.sleep(this.#o.pollMs);
    }
  }

  #track(task: Task, recovered: boolean): Promise<void> {
    const running: Running = { customerId: task.customerId, controller: new AbortController(), reason: null, restUntil: null, done: Promise.resolve() };
    this.#running.set(task.id, running);
    running.done = this.#execute(task, recovered, running)
      .catch((e) => this.#d.log.error("tasks.execute_crashed", { taskId: task.id, error: errorText(e) }))
      .finally(() => {
        this.#running.delete(task.id);
        this.#sleeper.wake();
      });
    return running.done;
  }

  async #execute(task: Task, recovered: boolean, running: Running): Promise<void> {
    const { queue, log } = this.#d;
    const { worker } = this.#o;
    const spec = this.#d.catalog.get(task.agent);
    if (!spec) return this.#fail(task, `there is no "${task.agent}" on the team`);
    if (task.attempts > this.#o.maxAttempts) return this.#fail(task, `gave up after ${task.attempts - 1} tries: ${task.error ?? "it kept failing"}`);
    // A run that needs their Chrome waits for it: started the second the agent came up, before their Chrome asked for
    // work again, it found every page offline and ended in 20 s with nothing done (live, 2026-11-14, twice).
    if (spec.needsChrome && this.#d.chromeOnline && !this.#d.chromeOnline(task.customerId)) {
      await queue.release(task.id, worker, task.nextInput, CHROME_WAIT_MS, true);
      log.info("tasks.waits_for_chrome", { taskId: task.id });
      return;
    }

    const { reader, posts } = this.#d.reach.forCustomer(task.customerId);
    const trail = new SearchTrail();
    const ctx: SubagentContext = {
      customerId: task.customerId,
      taskId: task.id,
      browserSession: threadOf(task.id),
      reader,
      posts,
      customer: () => this.#d.customers.get(task.customerId),
      finds: this.#d.finds,
      places: this.#d.places,
      trail,
      ...(this.#d.browser ? { browser: this.#d.browser } : {}),
      ...(this.#d.drafts ? { drafts: this.#d.drafts } : {}),
      ...(this.#d.finder ? { finder: this.#d.finder } : {}),
      ...(this.#d.pairs ? { pairs: this.#d.pairs } : {}),
      ...(this.#d.pageFor ? { pageFor: (who: { readonly maker: string; readonly url: string; readonly made: string }) => this.#d.pageFor!(task.customerId, who) } : {}),
      ...(this.#d.known ? { known: this.#d.known } : {}),
      ...(this.#d.searches ? { searchLog: this.#d.searches } : {}),
      ...(this.#d.people ? { people: this.#d.people } : {}),
    };
    // The run's calls stay with one provider, whose cache holds its growing prompt; the seat may be moved by config.
    const run = { session: threadOf(task.id), customerId: task.customerId };
    const seat = this.#d.seats?.[spec.name] ?? spec.role;
    const tools = [...spec.tools(ctx), askHumanTool];
    const learns = findsPeople(tools);
    const agent = buildAgent(
      {
        name: spec.name,
        model: this.#d.models.modelFor(seat, run),
        fallback: this.#d.models.fallbackFor?.(seat, run) ?? null,
        summaryModel: this.#d.models.summarizer?.(run) ?? null,
        // A teammate that works pages also gets how to work them: standing text, so the prompt stays the same run to run.
        systemPrompt: tools.some((t) => t.name === "browser_open") ? `${spec.systemPrompt}\n\n${BROWSING}` : spec.systemPrompt,
        images: () => { const screen = this.#d.browser?.screen(task.customerId, threadOf(task.id)); return screen ? [screen] : []; },
        // A task the customer asked for on one site works there only: its tools refuse the rest.
        tools: task.site ? pinToSite(tools, task.site) : tools,
        stepBudget: spec.stepBudget,
        onTool: (tool, args) => {
          log.info("tasks.tool", { taskId: task.id, tool });
          this.#d.progress?.tool(task.id, tool, args);
        },
        onModel: (call) => {
          noteModelCall(log, "tasks.model", this.#d.spend, { customerId: task.customerId, taskId: task.id, agent: spec.name }, call);
          this.#d.progress?.step(task.id);
        },
        onTrimmed: (dropped) => log.warn("tasks.calls_trimmed", { customerId: task.customerId, taskId: task.id, dropped }),
        onToolResult: (tool, args, out) => trail.note(tool, args, out),
        onRepeat: (tool) => log.warn("tasks.repeat_refused", { customerId: task.customerId, taskId: task.id, tool }),
        onFallback: (error) => log.warn("tasks.model_fallback", { customerId: task.customerId, taskId: task.id, error }),
        ...(spec.finishUp ? { finishUp: spec.finishUp } : {}),
        ...(this.#o.modelRetryDelayMs !== undefined ? { retryDelayMs: this.#o.modelRetryDelayMs } : {}),
      },
      this.#d.checkpointer,
    );
    const config: ThreadConfig = {
      configurable: { thread_id: threadOf(task.id) },
      signal: running.controller.signal,
    };

    const beat = setInterval(() => void this.#heartbeat(task.id, running), Math.max(1_000, this.#o.leaseMs / 3));
    log.info("tasks.run", { taskId: task.id, agent: task.agent, input: task.nextInput.kind, recovered });
    let finished = false;
    try {
      const plan = await this.#plan(agent, config, task, () => this.#opening(spec, ctx, task, learns));
      if (plan.kind === "wait") return await this.#park(task, plan.interrupts);
      // Only a run that works goes on the board: one still waiting for its answers parks again at once.
      this.#d.progress?.started(task, spec.stepBudget);
      const result = await agent.invoke(plan.input, config);
      const pending = interruptsOf(result);
      if (pending.length) return await this.#park(task, pending);
      const facts = spec.facts ? await spec.facts(ctx) : null;
      const report = [finalText(result) || "(finished without a report)", facts ? `On record: ${facts}` : null].filter(Boolean).join("\n\n");
      await queue.finish(task.id, worker, { status: "succeeded", result: report });
      finished = true;
      await this.#d.events.push(task.customerId, {
        kind: "task_finished",
        taskId: task.id,
        agent: task.agent,
        outcome: "succeeded",
        summary: clip(report, 1_500),
      });
      log.info("tasks.succeeded", { taskId: task.id });
      if (task.title.startsWith(WHAT_WORKS)) {
        const kept = await keepLessons(this.#d.memory, task.customerId, report).catch(() => 0);
        log.info("tasks.lessons_kept", { taskId: task.id, kept });
      }
    } catch (e) {
      await this.#afterStop(task, running.reason, e, running.restUntil);
    } finally {
      clearInterval(beat);
      this.#d.progress?.stopped(task.id, finished);
      if (learns && this.#d.searches) {
        await this.#d.searches
          .record(task.customerId, task.id, task.agent, trail.runs())
          .catch((e) => log.warn("tasks.searches_not_kept", { taskId: task.id, error: errorText(e) }));
      }
      await this.#d.browser?.close(task.customerId, threadOf(task.id)).catch(() => undefined);
    }
  }

  /**
   * Decides how the run starts, from where the task's thread actually stands:
   * a run that stopped on questions resumes only with their answers; one that
   * stopped partway continues from its checkpoint; otherwise it starts fresh.
   */
  async #plan(agent: RunnableAgent, config: ThreadConfig, task: Task, opening: () => Promise<string>): Promise<RunPlan> {
    const state = await agent.state(config);
    const input: TaskInput = task.nextInput;
    if (state.interrupts.length) {
      const answers = input.kind === "resume" ? input.answers : {};
      const unanswered = state.interrupts.filter((i) => !(i.id in answers));
      if (unanswered.length) return { kind: "wait", interrupts: state.interrupts };
      const resume = Object.fromEntries(state.interrupts.map((i) => [i.id, answers[i.id]]));
      return { kind: "invoke", input: new Command({ resume }) };
    }
    if (input.kind === "instructions") {
      const text = state.hasCheckpoint
        ? `New instructions from your manager (they replace what you were doing where they conflict):\n${input.text}`
        : `${await opening()}\n\nUpdate from your manager:\n${input.text}`;
      return { kind: "invoke", input: { messages: [new HumanMessage(text)] } };
    }
    if (state.next.length) return { kind: "invoke", input: null };
    if (!state.hasCheckpoint) return { kind: "invoke", input: { messages: [new HumanMessage(await opening())] } };
    return { kind: "invoke", input: { messages: [new HumanMessage("Continue your task and finish with your report.")] } };
  }

  /**
   * A fresh task's first message: the site it is kept to, the manager's instructions, what its spec adds
   * (the brief, earlier decisions), what earlier searches came to, then what the customer decided and the
   * team learned, kept for good.
   */
  async #opening(spec: SubagentSpec, ctx: SubagentContext, task: Task, learns: boolean): Promise<string> {
    const [extra, kept, past] = await Promise.all([
      spec.opening ? spec.opening(ctx).then((s) => s.trim()) : Promise.resolve(""),
      this.#d.memory.list(task.customerId, 60),
      learns && this.#d.searches ? this.#d.searches.recent(task.customerId, { site: task.site, ...SEARCHES_LOOKED_AT }).catch(() => []) : Promise.resolve([]),
    ]);
    const rules = kept.filter((m) => m.kind !== "fact");
    const memory = rules.length
      ? `What the customer decided and what the team learned, kept for good (follow these):\n${rules.map((m) => `- ${m.text}`).join("\n")}`
      : "";
    return [
      languageBriefing((await ctx.customer()).language),
      task.site ? siteBriefing(task.site) : "",
      task.instructions,
      extra,
      searchesBlock(past, task.site),
      memory,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async #park(task: Task, interrupts: readonly PendingInterrupt[]): Promise<void> {
    const raised: RaisedQuestion[] = interrupts.map((i) =>
      isAskHumanRequest(i.value)
        ? { interruptId: i.id, text: i.value.question, options: [...i.value.options], why: i.value.why }
        : { interruptId: i.id, text: String(i.value), options: [], why: null },
    );
    await this.#d.questions.raise(task, raised);
    await this.#d.queue.park(task.id, this.#o.worker);
    // Answers that arrived while this run was still stopping would otherwise never resume it.
    await this.#d.questions.resumeIfSettled(task.id);
    this.#d.log.info("tasks.waiting", { taskId: task.id, questions: raised.length });
  }

  async #afterStop(task: Task, reason: StopReason | null, error: unknown, restUntil: Date | null = null): Promise<void> {
    const { queue, tasks, log } = this.#d;
    const { worker } = this.#o;
    switch (reason) {
      case "cancel":
        await queue.finish(task.id, worker, { status: "cancelled" });
        await this.#d.questions.resumeIfSettled(task.id).catch(() => undefined);
        log.info("tasks.cancelled", { taskId: task.id });
        return;
      case "interrupt": {
        const fresh = await tasks.get(task.id);
        // New instructions are not a failed try: the claim they cost is given back.
        await queue.release(task.id, worker, fresh?.nextInput ?? task.nextInput, 0, true);
        log.info("tasks.restarting", { taskId: task.id });
        return;
      }
      case "shutdown":
        // A restart or a deploy is not the task's fault either (live, 2026-09-29: three restarts
        // and a steer ended a healthy scout run as "gave up after 3 tries").
        await queue.release(task.id, worker, task.nextInput, 0, true);
        return;
      case "off":
        // Not the task's fault: it goes on from its checkpoint once they switch Quest on.
        await queue.release(task.id, worker, task.nextInput, 0, true);
        log.info("tasks.switched_off", { taskId: task.id });
        return;
      case "rest":
        // Not the task's fault either: it goes on from its checkpoint when their rest is over.
        await queue.release(task.id, worker, task.nextInput, Math.max(0, (restUntil?.getTime() ?? Date.now()) - Date.now()), true);
        log.info("tasks.resting", { taskId: task.id, until: restUntil?.toISOString() ?? null });
        return;
      case "lost":
        log.warn("tasks.lease_lost", { taskId: task.id });
        return;
      default: {
        const message = errorText(error);
        // The models' own limit is nobody's failure: the run waits for it to be over, its try given back.
        const rests = modelRest.heard(error);
        if (rests) {
          await queue.release(task.id, worker, task.nextInput, Math.max(30_000, rests.getTime() - Date.now()), true);
          log.info("tasks.models_rest", { taskId: task.id, until: rests.toISOString() });
          return;
        }
        if (task.attempts >= this.#o.maxAttempts) return this.#fail(task, message);
        const delay = Math.min(10 * 60_000, 15_000 * 2 ** (task.attempts - 1));
        await queue.release(task.id, worker, task.nextInput, delay);
        log.warn("tasks.retry", { taskId: task.id, attempt: task.attempts, delayMs: delay, error: message });
      }
    }
  }

  async #fail(task: Task, error: string): Promise<void> {
    await this.#d.queue.finish(task.id, this.#o.worker, { status: "failed", error });
    await this.#d.events.push(task.customerId, {
      kind: "task_finished",
      taskId: task.id,
      agent: task.agent,
      outcome: "failed",
      summary: clip(error, 600),
    });
    this.#d.log.warn("tasks.failed", { taskId: task.id, error });
  }

  async #heartbeat(id: TaskId, running: Running): Promise<void> {
    try {
      const signals = await this.#d.queue.heartbeat(id, this.#o.worker, this.#o.leaseMs);
      const reason: StopReason | null = !signals.held
        ? "lost"
        : signals.cancelRequested
          ? "cancel"
          : signals.interruptRequested
            ? "interrupt"
            : null;
      if (reason && !running.reason) {
        running.reason = reason;
        running.controller.abort();
      }
    } catch (e) {
      this.#d.log.warn("tasks.heartbeat_failed", { taskId: id, error: errorText(e) });
    }
  }
}
