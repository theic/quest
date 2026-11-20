/**
 * The models take no calls for a while (the Claude subscription's usage limit on a dev laptop): nobody's fault, so it is
 * a rest, not a failure. Live, 2026-11-10: the limit hit at 21:17, every run on every site failed three times, the
 * rotation read each site as "its last two runs failed" and rested them 12 hours, and nothing ran from 22:00, when the
 * limit was over, to the morning. Whoever starts work looks here first; a call made meanwhile fails at once, unspawned.
 */

/** How a call says it: the words every reader matches, with when it is over (or "later"). */
export const limitError = (until: string): Error => new Error(`claude-cli: the Claude subscription's usage limit is reached, until ${until}`);
const SAID = /usage limit is reached, until (\S+)/;
/** With no time given, looked at again after this. */
const LATER_MS = 15 * 60_000;

/** Whether an error (or a task's kept error) is the models' limit, not the work's own failure. */
export const isModelLimit = (error: unknown): boolean => SAID.test(error instanceof Error ? error.message : String(error ?? ""));

export class ModelRest {
  #until = 0;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** A call was turned away until then ("later": a while). */
  note(until: string): void {
    const at = Date.parse(until);
    this.#until = Math.max(this.#until, Number.isFinite(at) ? at : this.#now() + LATER_MS);
  }

  /** Hears an error: when it is the limit, the rest it names is kept. Returns when the rest ends, or null. */
  heard(error: unknown): Date | null {
    const m = SAID.exec(error instanceof Error ? error.message : String(error ?? ""));
    if (m) this.note(m[1]!);
    return m ? this.until() ?? new Date(this.#now()) : null;
  }

  /** Until when the models rest, or null when they take calls. */
  until(): Date | null {
    return this.#until > this.#now() ? new Date(this.#until) : null;
  }
}

/** One for the process: the models are one subscription. */
export const modelRest = new ModelRest();
