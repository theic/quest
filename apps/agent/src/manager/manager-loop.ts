import { hasUserMessage, type CustomerId, type EventInbox, type Logger } from "@mq/core";
import type { Messenger } from "../conversation/messenger.ts";
import { errorText, Sleeper } from "../lib/sleeper.ts";
import { TurnStopped, type ManagerTurn } from "./manager-turn.ts";

export interface ManagerLoopOptions {
  readonly worker: string;
  /** Customers served at once by this process. Turns for one customer never overlap. */
  readonly concurrency: number;
  readonly leaseMs: number;
  readonly pollMs: number;
  readonly maxAttempts: number;
  /** Events handed to one turn at most. */
  readonly batch: number;
}

/**
 * The manager's main thread, per customer: take whatever woke it, run one turn,
 * repeat while more arrived meanwhile. It never waits on background work, which
 * reaches it later as events, so a customer is never kept waiting on a task.
 */
export class ManagerLoop {
  readonly #inbox: EventInbox;
  readonly #turn: ManagerTurn;
  readonly #messenger: Messenger;
  readonly #log: Logger;
  readonly #o: ManagerLoopOptions;
  readonly #active = new Map<CustomerId, Promise<void>>();
  /** The turn in flight for each customer, to stop it when they switch Quest off. */
  readonly #stops = new Map<CustomerId, AbortController>();
  /** Customers whose turn in flight was woken by heartbeats only: it makes way when they write. */
  readonly #looking = new Set<CustomerId>();
  /** Turns stopped to make way for what they sent, not by their off switch: the next one starts at once. */
  readonly #madeWay = new Set<CustomerId>();
  readonly #sleeper = new Sleeper();
  #started = false;
  #stopping = false;
  #loop: Promise<void> | null = null;

  constructor(deps: { inbox: EventInbox; turn: ManagerTurn; messenger: Messenger; log: Logger }, options: ManagerLoopOptions) {
    this.#inbox = deps.inbox;
    this.#turn = deps.turn;
    this.#messenger = deps.messenger;
    this.#log = deps.log;
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

  /** They switched Quest off: the turn in flight for them stops now, and its events wait for them to switch it on. */
  pause(customerId: CustomerId): void {
    this.#stops.get(customerId)?.abort();
  }

  /**
   * Something of theirs came in (a message, an answer). A turn of theirs that only looked around (heartbeats) stops and
   * gives its events back, so the next turn answers them with the look in it. Live, 2026-11-01: a heartbeat turn had
   * browsed X for minutes inside the manager when the founder wrote, and his message waited for it to end.
   */
  heard(customerId: CustomerId): void {
    if (this.#looking.delete(customerId)) {
      this.#log.info("manager.turn_made_way", { customerId });
      this.#madeWay.add(customerId);
      this.#stops.get(customerId)?.abort();
    }
    this.wake();
  }

  /** True while a customer's turn is running. */
  get busy(): boolean {
    return this.#active.size > 0;
  }

  /** Stops claiming and lets the turns in flight finish; `start()` picks up again. */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#sleeper.wake();
    await Promise.allSettled([this.#loop, ...this.#active.values()]);
    this.#loop = null;
    this.#started = false;
  }

  /** Serves one due customer to the end of their queue; false when none was due. For tests and the loop. */
  async serveNext(): Promise<boolean> {
    const customerId = await this.#inbox.claimCustomer(this.#o.worker, this.#o.leaseMs);
    if (!customerId) return false;
    await this.#serve(customerId);
    return true;
  }

  async #pollLoop(): Promise<void> {
    while (!this.#stopping) {
      try {
        if (this.#active.size < this.#o.concurrency) {
          const customerId = await this.#inbox.claimCustomer(this.#o.worker, this.#o.leaseMs);
          if (customerId) {
            const run = this.#serve(customerId).finally(() => {
              this.#active.delete(customerId);
              this.#sleeper.wake();
            });
            this.#active.set(customerId, run);
            continue;
          }
        }
      } catch (e) {
        this.#log.error("manager.claim_failed", { error: errorText(e) });
      }
      await this.#sleeper.sleep(this.#o.pollMs);
    }
  }

  async #serve(customerId: CustomerId): Promise<void> {
    const renew = setInterval(
      () => void this.#inbox.renew(customerId, this.#o.worker, this.#o.leaseMs).catch(() => undefined),
      Math.max(1_000, this.#o.leaseMs / 3),
    );
    try {
      while (!this.#stopping) {
        const events = await this.#inbox.take(customerId, this.#o.batch);
        if (!events.length) break;
        const ids = events.map((e) => e.id);
        const stop = new AbortController();
        this.#stops.set(customerId, stop);
        if (events.every((e) => e.event.kind === "heartbeat")) this.#looking.add(customerId);
        else this.#looking.delete(customerId);
        try {
          await this.#turn.run(customerId, events, stop.signal);
          await this.#inbox.done(ids);
        } catch (e) {
          if (e instanceof TurnStopped) {
            await this.#inbox.giveBack(ids);
            this.#log.info("manager.turn_stopped", { customerId });
            // Stopped to make way for their message: it is due now, so the next turn starts at once.
            if (this.#madeWay.delete(customerId)) continue;
            break;
          }
          const attempt = Math.max(...events.map((ev) => ev.attempts));
          const message = errorText(e);
          this.#log.error("manager.turn_failed", { customerId, attempt, error: message });
          await this.#inbox.retryLater(ids, message, 5_000 * 2 ** (attempt - 1), this.#o.maxAttempts);
          if (attempt >= this.#o.maxAttempts && hasUserMessage(events)) {
            await this.#messenger
              .say(customerId, "Sorry, something went wrong on my side and I couldn't answer that. Could you send it again in a minute?")
              .catch(() => undefined);
          }
          break;
        }
      }
    } finally {
      this.#stops.delete(customerId);
      this.#looking.delete(customerId);
      this.#madeWay.delete(customerId);
      clearInterval(renew);
      await this.#inbox.release(customerId, this.#o.worker).catch(() => undefined);
    }
  }
}
