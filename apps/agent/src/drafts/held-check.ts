import type { BrowserView, CustomerId, Logger } from "@mq/core";
import type { Loop } from "../lifecycle/idle-sleeper.ts";
import { pauseFor } from "../lib/pause.ts";

/**
 * A send Quest clicked and never saw land ("uncertain") is Quest's to settle, not theirs (the founder, 2026-11-04: "I
 * don't get 'I can't tell if it went up' ... I would rather ignore those and the agent can check on itself later"). It
 * is not on Your move and nothing is said: while their Chrome is open, code opens its page at `LOOKS` after it was
 * first held, and records it posted when the page shows it (`verifySent`: never sent again). One never seen stays held
 * quietly, which counts as maybe up, so no second reply goes there. Kept in memory: after a restart it looks again.
 */

/** When to look, after the send was first held: each drawn from the send, between these. */
export const LOOKS: readonly (readonly [number, number])[] = [
  [10 * 60_000, 25 * 60_000],
  [3 * 3_600_000, 5 * 3_600_000],
  [20 * 3_600_000, 28 * 3_600_000],
];
/** How often it looks for a held send that is due. */
export const HELD_CHECK_EVERY_MS = 2 * 60_000;
/** Older than this, a held send is left as it is. */
const OLDEST_MS = 7 * 86_400_000;

/** A send that may have gone up: where it went, and how its page is read as a receipt. */
export interface HeldSend {
  /** "draft:<id>" or "find:<id>". */
  readonly key: string;
  readonly url: string;
  readonly since: Date;
  /** The page as a receipt: what it came to, or why it is still held. */
  readonly verify: (view: BrowserView) => Promise<{ readonly posted: boolean; readonly why?: string }>;
}

export interface HeldCheckDeps {
  /** Customers whose Chrome is open now. */
  readonly online: () => readonly CustomerId[];
  readonly held: (customerId: CustomerId) => Promise<readonly HeldSend[]>;
  readonly browser: {
    open(customer: CustomerId, session: string, url: string, opts?: { drawn?: boolean }): Promise<BrowserView>;
    close(customer: CustomerId, session: string): Promise<void>;
  };
  readonly now: () => Date;
  readonly log: Logger;
}

export class HeldCheck implements Loop {
  readonly #d: HeldCheckDeps;
  readonly #everyMs: number;
  /** Each held send's first sight and the looks taken since. */
  readonly #looks = new Map<string, { first: number; taken: number }>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #running: Promise<void> | null = null;

  constructor(deps: HeldCheckDeps, options: { everyMs?: number } = {}) {
    this.#d = deps;
    this.#everyMs = options.everyMs ?? HELD_CHECK_EVERY_MS;
  }

  get busy(): boolean {
    return this.#running !== null;
  }

  start(): void {
    this.#timer ??= setInterval(() => void this.tick(), this.#everyMs);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#running;
  }

  /** One look at every held send that is due, one at a time. */
  tick(): Promise<void> {
    this.#running ??= this.#look().finally(() => (this.#running = null));
    return this.#running;
  }

  async #look(): Promise<void> {
    for (const customerId of this.#d.online()) {
      const sends = await this.#d.held(customerId).catch((e: unknown) => {
        this.#d.log.warn("held.list_failed", { customerId, error: e instanceof Error ? e.message : String(e) });
        return [];
      });
      for (const send of sends) await this.#settle(customerId, send);
    }
  }

  async #settle(customerId: CustomerId, send: HeldSend): Promise<void> {
    const now = this.#d.now().getTime();
    if (now - send.since.getTime() > OLDEST_MS) return;
    const looks = this.#looks.get(send.key) ?? { first: now, taken: 0 };
    this.#looks.set(send.key, looks);
    const next = LOOKS[looks.taken];
    if (!next || now - looks.first < pauseFor(`${send.key}|${looks.taken}`, ...next)) return;
    looks.taken++;
    const session = `held:${send.key}`;
    try {
      const view = await this.#d.browser.open(customerId, session, send.url, { drawn: true });
      const out = await send.verify(view);
      // Not seen: what the page's like and follow controls said, so a site's words for "done" can be learnt.
      const near = out.posted ? [] : view.controls.filter((c) => /like|follow|heart|подоба|стеж|читати|серд/i.test(c.label)).slice(0, 10).map((c) => `${c.label}${c.pressed === true ? "|pressed" : ""}${c.item !== undefined ? `|#${c.item}` : ""}`);
      this.#d.log.info("held.looked", { customerId, key: send.key, look: looks.taken, posted: out.posted, ...(out.why ? { why: out.why.slice(0, 160) } : {}), ...(near.length ? { controls: near } : {}) });
      if (out.posted) this.#looks.delete(send.key);
    } catch (e) {
      this.#d.log.warn("held.look_failed", { customerId, key: send.key, error: e instanceof Error ? e.message : String(e) });
    } finally {
      await this.#d.browser.close(customerId, session).catch(() => undefined);
    }
  }
}
