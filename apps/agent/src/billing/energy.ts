import type { Access, BillingRepository, Clock, CustomerId, CustomerRepository, Logger, ModelCall, SpendLog, ToppedUp } from "@mq/core";
import type { CreditView, CreditWords } from "./credit-words.ts";
import { balance, DAY_LIMIT_USD, theirDay, TIRED_AT } from "./plans.ts";

/** What stops a customer's runs when they rest: the task runner. */
export interface RestStop {
  /** Stops the customer's runs in flight; each goes back to the queue, to go on from where it was after `until`. */
  rest(customerId: CustomerId, until: Date): void;
}

/** A customer's day, for the manager's turn: how much is left, and whether Quest is tired or resting. */
export interface EnergyView extends CreditView {
  /** Past TIRED_AT of the day's limit. */
  readonly tired: boolean;
  /** Their credits page, to give them when they ask about paying; null without an address. */
  readonly link: string | null;
}

/** How long after a model call its customer's day is looked at again: one read covers the calls in between. */
const CHECK_AFTER_MS = 3_000;
/** Calls younger than this are drawn from their credits at the next look, once their rows are surely written. */
const SETTLE_MS = 10_000;
/** How long Quest stops when their credits run out: until they top up, which ends it; then it looks again. */
const OUT_OF_CREDITS_MS = 30 * 24 * 3_600_000;

/**
 * Each customer's day and credits (billing/plans.ts). Every model call made for a customer brings a look at their day
 * a moment later (one read for the calls in between): what the calls cost is drawn from their credits, and past the day's limit (the same for everyone) they rest until their next midnight;
 * someone on credits stops when they run out, until a top-up. The rest is set in the database, so
 * their queued work waits and nothing of theirs is claimed (pg-events.ts, pg-tasks.ts), their runs in flight stop and
 * go back to the queue, and they hear it once (credit-words.ts). A turn already running finishes.
 */
export class Energy {
  readonly #billing: BillingRepository;
  readonly #customers: Pick<CustomerRepository, "get">;
  readonly #words: CreditWords;
  readonly #runs: RestStop | null;
  readonly #limit: number;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #checkAfterMs: number;
  readonly #pending = new Map<CustomerId, ReturnType<typeof setTimeout>>();

  constructor(deps: {
    billing: BillingRepository;
    customers: Pick<CustomerRepository, "get">;
    words: CreditWords;
    runs?: RestStop;
    /** The day's limit in dollars (a laptop agent can make a day short, to see it run out). */
    dayLimitUsd?: number;
    clock: Clock;
    log: Logger;
    checkAfterMs?: number;
  }) {
    this.#billing = deps.billing;
    this.#customers = deps.customers;
    this.#words = deps.words;
    this.#runs = deps.runs ?? null;
    this.#limit = deps.dayLimitUsd ?? DAY_LIMIT_USD;
    this.#clock = deps.clock;
    this.#log = deps.log;
    this.#checkAfterMs = deps.checkAfterMs ?? CHECK_AFTER_MS;
  }

  /** The spend log, with each customer's day looked at after their calls. */
  watching(spend: SpendLog): SpendLog {
    return {
      record: (call: ModelCall) => {
        spend.record(call);
        if (call.customerId && (call.usage.cost ?? 0) > 0) this.note(call.customerId);
      },
    };
  }

  /** A model call was made for them: their day is looked at shortly, once for the calls in between. */
  note(customerId: CustomerId): void {
    if (this.#pending.has(customerId)) return;
    const timer = setTimeout(() => {
      this.#pending.delete(customerId);
      void this.check(customerId).catch((e: unknown) => this.#log.warn("energy.check_failed", { customerId, error: e instanceof Error ? e.message : String(e) }));
    }, this.#checkAfterMs);
    timer.unref?.();
    this.#pending.set(customerId, timer);
  }

  /** Draws today's calls from their credits and looks at their day; past the limit or out of credits, they rest. */
  async check(customerId: CustomerId): Promise<EnergyView> {
    const now = this.#clock.now();
    await this.#billing.draw(customerId, new Date(now.getTime() - SETTLE_MS));
    const view = await this.view(customerId);
    if (view.restUntil) {
      // Resting already (a rest set by another check, or before a restart): nothing of theirs runs.
      this.#runs?.rest(customerId, view.restUntil);
      return view;
    }
    if (view.access === "credits" && (view.balance ?? 0) <= 0) {
      const until = new Date(now.getTime() + OUT_OF_CREDITS_MS);
      if (!(await this.#billing.rest(customerId, until))) return view;
      this.#log.info("energy.out_of_credits", { customerId, used: view.used });
      this.#runs?.rest(customerId, until);
      await this.#words.outOfCredits(customerId);
      return { ...view, restUntil: until, resting: "credits" };
    }
    if (view.used < view.limit) return view;
    const customer = await this.#customers.get(customerId);
    const until = theirDay(now, customer.timezone).end;
    if (!(await this.#billing.rest(customerId, until))) return view;
    this.#log.info("energy.resting", { customerId, access: view.access, used: view.used, until: until.toISOString() });
    this.#runs?.rest(customerId, until);
    await this.#words.dayDone(customerId, until);
    return { ...view, restUntil: until, resting: "day" };
  }

  /** How they pay, what today used, their credits, and the rest they are on. */
  async view(customerId: CustomerId): Promise<EnergyView> {
    const customer = await this.#customers.get(customerId);
    const now = this.#clock.now();
    const day = await this.#billing.day(customerId, theirDay(now, customer.timezone).start);
    const access: Access = day.bought ? "credits" : "invite";
    const left = day.wallet || access === "credits" ? balance(day.wallet) : null;
    const restUntil = day.restUntil && day.restUntil.getTime() > now.getTime() ? day.restUntil : null;
    const resting = !restUntil
      ? null
      : access === "credits" && (left ?? 0) <= 0
        ? "credits"
        : "day";
    return {
      access,
      used: day.spent,
      limit: this.#limit,
      balance: left,
      firstTopUp: !day.wallet?.topUps,
      restUntil,
      resting,
      tired: day.spent >= this.#limit * TIRED_AT,
      link: this.#words.link(customerId),
    };
  }

  /**
   * Credits came in (Stripe's webhook): a stop for credits ends at once, and they hear what came in. A rest for the
   * day's limit holds: the limit is everyone's, paid or not.
   */
  async toppedUp(customerId: CustomerId, top: ToppedUp): Promise<void> {
    const customer = await this.#customers.get(customerId);
    const midnight = theirDay(this.#clock.now(), customer.timezone).end;
    const view = await this.view(customerId);
    // A stop for credits runs past their midnight; a rest for the day ends at it.
    const stopped = view.restUntil !== null && view.restUntil.getTime() > midnight.getTime();
    if (stopped) {
      await this.#billing.endRest(customerId);
      if (view.used >= view.limit) await this.#billing.rest(customerId, midnight);
    }
    const back = stopped && view.used < view.limit;
    this.#log.info("energy.topped_up", { customerId, credit: top.credit, bonus: top.bonus, letIn: top.letIn, back });
    await this.#words.toppedUp(customerId, top, back);
  }

  /** They wrote: while Quest rests they hear how long it has left (once a rest), and what they said waits for it. */
  async heard(customerId: CustomerId, ref: string | null): Promise<void> {
    const view = await this.view(customerId);
    if (view.restUntil) await this.#words.whileResting(customerId, view, ref);
  }

  /** /plan: how they pay, what today used, and the way to buy credits. */
  async show(customerId: CustomerId): Promise<void> {
    await this.#words.show(customerId, await this.view(customerId));
  }

  /** Stops the looks still waiting (the agent is stopping). */
  stop(): void {
    for (const timer of this.#pending.values()) clearTimeout(timer);
    this.#pending.clear();
  }
}
