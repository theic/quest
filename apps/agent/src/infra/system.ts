import type { Clock, Logger } from "@mq/core";

export const systemClock: Clock = { now: () => new Date() };

/** One JSON line per event: what Fly's log viewer and `fly logs` read best. */
export class JsonLogger implements Logger {
  readonly #base: Record<string, unknown>;

  constructor(base: Record<string, unknown> = {}) {
    this.#base = base;
  }

  info(event: string, data?: Record<string, unknown>): void {
    this.#write("info", event, data);
  }

  warn(event: string, data?: Record<string, unknown>): void {
    this.#write("warn", event, data);
  }

  error(event: string, data?: Record<string, unknown>): void {
    this.#write("error", event, data);
  }

  #write(level: string, event: string, data?: Record<string, unknown>): void {
    const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...this.#base, ...data });
    if (level === "error") console.error(line);
    else console.log(line);
  }
}

/** Keeps tests and scripts quiet. */
export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
