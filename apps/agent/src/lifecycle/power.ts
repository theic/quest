import type { Clock, CustomerId, CustomerRepository, EventSink, Logger } from "@mq/core";
import type { Messenger } from "../conversation/messenger.ts";

/** What is said when Quest goes off, and when it comes back. */
export const OFF_SAID = "Browsing is off. Nothing happens in your Chrome and nothing gets posted until you switch it on. I still answer here.";
export const ON_SAID = "I'm back on, picking up where I left off.";

/**
 * The off switch (the founder, 2026-10-19: "an off switch in the main menu, so I could use my desktop without the
 * agent intervening"): the bar in the side panel, the one on their page, and `/off` and
 * `/on`. Off stops the heavy work (`mq.customers.off_at`): the task queue claims none of theirs, their runs in flight
 * stop and go back to the queue with their try given back, their Chrome gets nothing from Quest (waiting jobs fail,
 * nothing sent), nothing goes up by itself or on a tap, no heartbeat or report is queued, and `mq.next_work_at()`
 * wakes nobody for them. The manager still answers what they write (the founder, 2026-11-12: "the manager should
 * always be there to answer, both switches should only turn off the heavy stuff, like browsing, the queue"): their own
 * messages and answers get a turn (`pg-events.ts`, `THEIRS`), told that browsing is off; everything else waits for
 * on. Known in memory too, for the checks that cannot wait on the database (the Chrome broker, autopilot), loaded at
 * start.
 */
export interface PowerDeps {
  readonly customers: Pick<CustomerRepository, "get" | "update" | "switchedOff">;
  readonly messenger: Pick<Messenger, "sendSwitch">;
  readonly events: EventSink;
  /** Their runs in flight stop when it goes off. */
  readonly runs?: { pause(customerId: CustomerId): void };
  /** Their Chrome gets nothing while it is off. */
  readonly chrome?: { switchOff(customerId: CustomerId, off: boolean): void };
  readonly wakeManager: () => void;
  /**
   * What waited only for on: their first sweep (live, production, 2026-11-14: the brief was saved while they were off,
   * their Chrome was already online, and nothing ever started it).
   */
  readonly whenOn?: (customerId: CustomerId) => void;
  readonly clock: Clock;
  readonly log: Logger;
}

export class Power {
  readonly #off = new Set<string>();
  readonly #d: PowerDeps;

  constructor(deps: PowerDeps) {
    this.#d = deps;
  }

  /** At start: who switched Quest off before. */
  async load(): Promise<void> {
    for (const id of await this.#d.customers.switchedOff()) {
      this.#off.add(id);
      this.#d.chrome?.switchOff(id, true);
    }
  }

  isOff(customerId: CustomerId): boolean {
    return this.#off.has(customerId);
  }

  /**
   * Switches Quest on or off for them. It is told in the chat with the button that switches it
   * back. False when it already was (a second tap, `/off` twice): then they hear nothing more.
   */
  async set(customerId: CustomerId, on: boolean, from: "chat" | "page" | "tap"): Promise<boolean> {
    const was = Boolean((await this.#d.customers.get(customerId)).offAt);
    if (was === !on) {
      if (on) this.#off.delete(customerId);
      else this.#off.add(customerId);
      return false;
    }
    const where = from === "page" ? "from their page" : "in the chat";
    await this.#apply(customerId, on, `switched ${on ? "on" : "off"} ${where}`, "They switched browsing back on. Pick up the work.");
    this.#d.log.info(on ? "power.on" : "power.off", { customerId, from });
    await this.#d.messenger.sendSwitch(customerId, on ? ON_SAID : OFF_SAID, !on);
    return true;
  }

  async #apply(customerId: CustomerId, on: boolean, note: string, back: string): Promise<void> {
    await this.#d.customers.update(customerId, { offAt: on ? null : this.#d.clock.now() });
    if (on) {
      this.#off.delete(customerId);
      this.#d.chrome?.switchOff(customerId, false);
      // Whatever waited while off (finished runs, what was due) is the manager's again now.
      await this.#d.events.push(customerId, { kind: "system", topic: "switched_on", text: back });
      this.#d.wakeManager();
      this.#d.whenOn?.(customerId);
    } else {
      this.#off.add(customerId);
      this.#d.chrome?.switchOff(customerId, true);
      this.#d.runs?.pause(customerId);
    }
  }
}
