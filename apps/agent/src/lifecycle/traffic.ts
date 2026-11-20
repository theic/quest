/**
 * Requests in flight and when the last one came: how an idle agent learns that
 * someone needs it. Fly's health checks are not traffic; the HTTP layer leaves
 * them out.
 */
export class Traffic {
  readonly #now: () => number;
  readonly #listeners: (() => void)[] = [];
  #inFlight = 0;
  #lastAt: number;

  constructor(now: () => number) {
    this.#now = now;
    this.#lastAt = now();
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  get lastAt(): number {
    return this.#lastAt;
  }

  /** Marks a request as started; call the returned function when it is done. */
  begin(): () => void {
    this.#inFlight++;
    this.#lastAt = this.#now();
    for (const listener of this.#listeners) listener();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.#inFlight--;
      this.#lastAt = this.#now();
    };
  }

  onRequest(listener: () => void): void {
    this.#listeners.push(listener);
  }
}
