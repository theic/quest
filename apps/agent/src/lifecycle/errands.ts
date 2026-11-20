import type { Logger } from "@mq/core";
import type { Loop } from "./idle-sleeper.ts";

/** How long `stop` lets errands finish, then how long it waits for the ones it stopped to give their claims back. */
export interface ErrandTimes {
  readonly finishMs: number;
  readonly stopMs: number;
}

/**
 * Inside Fly's kill_timeout (30 s, apps/agent/fly.toml), with time left for the rest of the shutdown. Live, 2026-10-17:
 * a post tapped 5 s before a deploy was waited on until Fly killed the machine, and its card stayed claimed as posting.
 */
export const ERRAND_TIMES: ErrandTimes = { finishMs: 10_000, stopMs: 8_000 };

interface Errand {
  readonly done: Promise<void>;
  readonly stop: AbortController;
}

/**
 * Work a tap starts that outlives the request it came in (a reply being posted
 * in the customer's Chrome). One at a time per key, and the agent does not
 * sleep while any is running; a shutdown stops what does not finish in time.
 */
export class Errands implements Loop {
  readonly #running = new Map<string, Errand>();
  readonly #log: Logger;
  readonly #times: ErrandTimes;
  /** Shutting down (a deploy): nothing new starts, so nothing starts that the exit would cut off mid-send. */
  #closed = false;

  constructor(log: Logger, times: ErrandTimes = ERRAND_TIMES) {
    this.#log = log;
    this.#times = times;
  }

  get busy(): boolean {
    return this.#running.size > 0;
  }

  running(key: string): boolean {
    return this.#running.has(key);
  }

  /**
   * Starts the work unless the same key is already running, or the agent is shutting down; false then (the outbox
   * keeps a send in line, and it goes after the restart). `signal` aborts when the agent stops.
   */
  run(key: string, work: (signal: AbortSignal) => Promise<void>): boolean {
    if (this.#closed || this.#running.has(key)) return false;
    const stop = new AbortController();
    const done = work(stop.signal)
      .catch((e) => this.#log.error("errand.failed", { key, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => this.#running.delete(key));
    this.#running.set(key, { done, stop });
    return true;
  }

  start(): void {
    // Errands start on taps, not on a clock.
  }

  /** The agent is shutting down: nothing new starts from now, and what runs is let finish, or stopped. */
  close(): Promise<void> {
    this.#closed = true;
    return this.stop();
  }

  /** Lets what is running finish; what has not by `finishMs` is stopped, so a post not yet sent gives its card back. */
  async stop(): Promise<void> {
    if (await this.#settled(this.#times.finishMs)) return;
    const keys = [...this.#running.keys()];
    this.#log.warn("errand.stopping", { keys });
    for (const errand of this.#running.values()) errand.stop.abort();
    if (!(await this.#settled(this.#times.stopMs))) this.#log.error("errand.left_running", { keys: [...this.#running.keys()] });
  }

  /** True once everything running now has settled, false if it has not within `ms`. */
  async #settled(ms: number): Promise<boolean> {
    if (!this.#running.size) return true;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
    try {
      return await Promise.race([Promise.allSettled([...this.#running.values()].map((e) => e.done)).then(() => true), late]);
    } finally {
      clearTimeout(timer);
    }
  }
}
