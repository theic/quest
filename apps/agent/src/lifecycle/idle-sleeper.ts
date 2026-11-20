import type { Clock, Logger, MachinePower, WorkSchedule } from "@mq/core";
import { errorText } from "../lib/sleeper.ts";
import type { Traffic } from "./traffic.ts";

/** Something that keeps the agent working: the manager's loop, the task runner, the heartbeat. */
export interface Loop {
  start(): void;
  /** Stops taking new work and settles; `start()` picks up again. */
  stop(): Promise<void>;
  /** True while it is doing something (a turn, a task). */
  readonly busy: boolean;
}

export interface IdleSleeperDeps {
  readonly loops: readonly Loop[];
  readonly traffic: Traffic;
  readonly work: WorkSchedule;
  /** Open database connections. They are let close before a suspend, so none is stale on resume. */
  readonly connections: { readonly open: number };
  readonly power: MachinePower;
  readonly clock: Clock;
  readonly log: Logger;
}

export interface IdleSleeperOptions {
  /** How long nothing must happen before the agent sleeps. */
  readonly idleMs: number;
  readonly checkMs: number;
  /** Work due within this keeps the agent up; later work wakes it through the database's wake job. */
  readonly horizonMs: number;
  /** The longest wait for database connections to close before giving up on a sleep. */
  readonly drainMs: number;
  /** If no request arrives this long after a suspend, the suspend did not happen: carry on. */
  readonly resumeTimeoutMs: number;
}

type State = "awake" | "settling" | "asleep";

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Puts the agent's machine to sleep when there is nothing to do, and gets out of
 * the way when there is.
 *
 * Fly's proxy only sees HTTP traffic, so left to itself it would suspend a
 * machine in the middle of a task. The agent decides instead: nothing running,
 * no request for `idleMs`, no work due soon. It then stops its loops, lets its
 * database connections close, and suspends itself. The next request (a Telegram
 * update, or the database's wake job when work falls due) resumes the machine,
 * and the loops start again.
 */
export class IdleSleeper {
  readonly #d: IdleSleeperDeps;
  readonly #o: IdleSleeperOptions;
  #state: State = "awake";
  #timer: ReturnType<typeof setInterval> | null = null;
  #lastBusyAt: number;
  #wokeAt: number;
  #interrupted = false;
  #resume: (() => void) | null = null;

  constructor(deps: IdleSleeperDeps, options: IdleSleeperOptions) {
    this.#d = deps;
    this.#o = options;
    this.#lastBusyAt = this.#wokeAt = this.#now();
    deps.traffic.onRequest(() => this.#onRequest());
  }

  get state(): State {
    return this.#state;
  }

  start(): void {
    if (!this.#d.power.canSleep) return;
    this.#timer ??= setInterval(() => void this.check(), this.#o.checkMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Looks once; sleeps if the agent is idle. Resolves when it is awake again. For the timer and tests. */
  async check(): Promise<void> {
    if (this.#state !== "awake" || !this.#d.power.canSleep) return;
    const now = this.#now();
    if (this.#working()) {
      this.#lastBusyAt = now;
      return;
    }
    const lastActive = Math.max(this.#lastBusyAt, this.#wokeAt, this.#d.traffic.lastAt);
    if (now - lastActive < this.#o.idleMs) return;
    if (await this.#workDueSoon()) return;
    await this.#sleep();
  }

  async #sleep(): Promise<void> {
    const { log } = this.#d;
    this.#state = "settling";
    this.#interrupted = false;
    await Promise.allSettled(this.#d.loops.map((l) => l.stop()));

    // Stopping may have handed something back to the queue, and a request may have come in.
    if (this.#interrupted || this.#working()) return this.#wake("traffic while settling");
    if (await this.#workDueSoon()) return this.#wake("work came due while settling");
    for (let waited = 0; this.#d.connections.open > 0 && !this.#interrupted && waited < this.#o.drainMs; waited += 250) await pause(250);
    if (this.#interrupted) return this.#wake("traffic while settling");
    if (this.#d.connections.open > 0) return this.#wake(`${this.#d.connections.open} database connections stayed open`);

    const resumed = new Promise<string>((resolve) => {
      this.#resume = () => resolve("request");
      setTimeout(() => resolve("no request after suspending"), this.#o.resumeTimeoutMs).unref?.();
    });
    this.#state = "asleep";
    const sleptAt = this.#now();
    log.info("agent.sleeping", { idleMs: this.#now() - Math.max(this.#lastBusyAt, this.#d.traffic.lastAt) });
    try {
      await this.#d.power.suspend();
    } catch (e) {
      log.error("agent.suspend_failed", { error: errorText(e) });
      return this.#wake("suspend failed");
    }
    // The suspend call may answer before the machine freezes, so the loops wait for
    // the request that resumes it rather than for the call.
    const reason = await resumed;
    this.#wake(reason, this.#now() - sleptAt);
  }

  #wake(reason: string, sleptMs?: number): void {
    this.#resume = null;
    this.#wokeAt = this.#now();
    this.#state = "awake";
    for (const loop of this.#d.loops) loop.start();
    this.#d.log.info("agent.awake", { reason, ...(sleptMs !== undefined ? { sleptMs } : {}) });
  }

  #onRequest(): void {
    if (this.#state === "settling") this.#interrupted = true;
    if (this.#state === "asleep") this.#resume?.();
  }

  #working(): boolean {
    return this.#d.traffic.inFlight > 0 || this.#d.loops.some((l) => l.busy);
  }

  async #workDueSoon(): Promise<boolean> {
    try {
      const due = await this.#d.work.nextWorkAt();
      return due !== null && due.getTime() - this.#now() < this.#o.horizonMs;
    } catch (e) {
      // Not knowing is a reason to stay up.
      this.#d.log.warn("agent.next_work_unknown", { error: errorText(e) });
      return true;
    }
  }

  #now(): number {
    return this.#d.clock.now().getTime();
  }
}
