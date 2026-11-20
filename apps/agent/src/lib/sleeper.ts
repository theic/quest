/** A sleep that `wake()` can cut short, so a polling loop reacts at once when it knows there is work. */
export class Sleeper {
  #wake: (() => void) | null = null;
  #pending = false;

  sleep(ms: number): Promise<void> {
    if (this.#pending) {
      this.#pending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        self.#wake = null;
        resolve();
      }
      this.#wake = done;
    });
  }

  wake(): void {
    if (this.#wake) this.#wake();
    else this.#pending = true;
  }
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
