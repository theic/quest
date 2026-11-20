import type { HeartbeatSource, Logger } from "@mq/core";
import { errorText } from "../lib/sleeper.ts";

/**
 * Wakes each active customer's manager on a schedule, so it can review its board
 * and plan even when nothing else happened. Safe to run on every machine: a
 * customer gets at most one pending heartbeat.
 */
export class HeartbeatScheduler {
  readonly #source: HeartbeatSource;
  readonly #everyMs: number;
  readonly #checkMs: number;
  readonly #firstTickMs: number;
  readonly #onQueued: () => void;
  readonly #log: Logger;
  #timer: ReturnType<typeof setInterval> | null = null;
  #first: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: { source: HeartbeatSource; everyMs: number; checkMs: number; firstTickMs?: number; onQueued: () => void; log: Logger }) {
    this.#source = deps.source;
    this.#everyMs = deps.everyMs;
    this.#checkMs = deps.checkMs;
    this.#firstTickMs = deps.firstTickMs ?? 0;
    this.#onQueued = deps.onQueued;
    this.#log = deps.log;
  }

  /** Never busy: a tick only queues events, and the manager does the work. */
  readonly busy = false;

  /**
   * Ticks soon, then on schedule: after a sleep, heartbeats that fell due go out first.
   * "Soon" is `firstTickMs`: a connected Chrome takes up to half a minute to ask for work
   * again after the agent starts, and a turn before that would think it closed (live, 2026-09-28).
   */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.#checkMs);
    this.#first = setTimeout(() => void this.tick(), this.#firstTickMs);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#first) clearTimeout(this.#first);
    this.#timer = null;
    this.#first = null;
  }

  /** Queues due heartbeats and evening reports; returns how many customers got either. */
  async tick(): Promise<number> {
    try {
      const beats = await this.#source.queueDue(this.#everyMs);
      const reports = await this.#source.queueDayReports();
      if (beats || reports) {
        this.#log.info("heartbeat.queued", { customers: beats, reports });
        this.#onQueued();
      }
      return beats + reports;
    } catch (e) {
      this.#log.error("heartbeat.failed", { error: errorText(e) });
      return 0;
    }
  }
}
