import { forLanguage } from "@mq/i18n";
import type { Access, Clock, CustomerId, CustomerRepository, EventSink, Logger, OutgoingLink, ToppedUp } from "@mq/core";
import { DONE_MARK, type Messenger } from "../conversation/messenger.ts";
import { money, restLeft, type PlanLinks } from "./plans.ts";
import { SUPPORT_LINK, SUPPORT_URL } from "../conversation/support.ts";

/** Where a customer stands today, for their page, /plan and the manager. */
export interface CreditView {
  readonly access: Access;
  /** Dollars of the AI used since their midnight, and the day's limit. */
  readonly used: number;
  readonly limit: number;
  /** Their credits left, in dollars; null when they never bought any. */
  readonly balance: number | null;
  /** They never topped up: a pack's bonus is theirs. */
  readonly firstTopUp: boolean;
  readonly restUntil: Date | null;
  /** Why they rest: the day's limit, or their credits ran out (until they top up). */
  readonly resting: "day" | "credits" | null;
}

/** The words Quest says about its day and their credits; English is the catalog's source (packages/i18n). */
export const SAID = {
  dayDone: "That's a full day's work for me, so I'm resting for {time}. Anything you send meanwhile, I'll pick up when I'm back.",
  outOfCredits: "I'm out of credits, so I've stopped for now. Top up and I'll pick up right where I left off.",
  resting: "Resting for {time} more. I'll pick this up when I'm back.",
  noCredits: "I'm out of credits. Top up and I'll pick this up.",
  toppedUp: "{credit} in credits added. Back to work.",
  toppedUpBonus: "{credit} in credits added: {paid}, plus a {bonus} bonus for your first top-up. Back to work.",
  letIn: "You're in, with {credit} in credits.",
  invite: "You're on an invite, so Quest is free for you.",
  credits: "Credits left: {balance}.",
  buy: "Buy credits",
  topUp: "Top up",
} as const;

/**
 * What Quest says about its day and their credits: that the day's work is done and it rests until their midnight,
 * that their credits ran out, that it rests when they write meanwhile, what they have when they ask (/plan), and that
 * a top-up came in. Every word is code's: the model never prices anything.
 */
export class CreditWords {
  readonly #customers: Pick<CustomerRepository, "get">;
  readonly #messenger: Pick<Messenger, "say" | "sendLinks" | "react">;
  readonly #events: EventSink | null;
  readonly #links: PlanLinks | null;
  readonly #welcome: ((customerId: CustomerId, said: string) => Promise<void>) | null;
  readonly #clock: Clock;
  readonly #log: Logger;
  /** The rest each customer was told about when they wrote during it (a second message gets a 😴 instead). */
  readonly #toldResting = new Map<CustomerId, number>();

  constructor(deps: {
    customers: Pick<CustomerRepository, "get">;
    messenger: Pick<Messenger, "say" | "sendLinks" | "react">;
    /** Wakes the manager once they bought more, so the work starts again at once. */
    events?: EventSink;
    /** Signed addresses of their credits page; null where the agent has no address of its own. */
    links: PlanLinks | null;
    /** Welcomes someone a purchase let in (conversation/way-in.ts), `said` standing for "You're in." */
    welcome?: (customerId: CustomerId, said: string) => Promise<void>;
    clock: Clock;
    log: Logger;
  }) {
    this.#customers = deps.customers;
    this.#messenger = deps.messenger;
    this.#events = deps.events ?? null;
    this.#links = deps.links;
    this.#welcome = deps.welcome ?? null;
    this.#clock = deps.clock;
    this.#log = deps.log;
  }

  /** Their credits page. */
  link(customerId: CustomerId): string | null {
    return this.#links?.url(customerId) ?? null;
  }

  /** The day's limit is reached: they hear that Quest rests until their midnight. */
  async dayDone(customerId: CustomerId, until: Date): Promise<void> {
    const t = forLanguage((await this.#customers.get(customerId)).language);
    const left = restLeft(until.getTime() - this.#clock.now().getTime());
    await this.#messenger.say(customerId, t(SAID.dayDone, { time: t(left.key, { count: left.count }) }));
  }

  /** Their credits ran out: they hear it, with the way to top up. */
  async outOfCredits(customerId: CustomerId): Promise<void> {
    const t = forLanguage((await this.#customers.get(customerId)).language);
    await this.#withButton(customerId, t(SAID.outOfCredits), t(SAID.topUp));
  }

  /** They wrote while Quest rests: told once a rest how long it has left (or how to top up), then a 😴 on their message. */
  async whileResting(customerId: CustomerId, view: Pick<CreditView, "restUntil" | "resting">, ref: string | null): Promise<void> {
    const until = view.restUntil;
    if (!until) return;
    if (this.#toldResting.get(customerId) === until.getTime()) {
      if (ref) await this.#messenger.react(customerId, ref, "😴").catch(() => false);
      return;
    }
    this.#toldResting.set(customerId, until.getTime());
    const t = forLanguage((await this.#customers.get(customerId)).language);
    if (view.resting === "credits") {
      await this.#withButton(customerId, t(SAID.noCredits), t(SAID.topUp));
      return;
    }
    const left = restLeft(until.getTime() - this.#clock.now().getTime());
    await this.#messenger.say(customerId, t(SAID.resting, { time: t(left.key, { count: left.count }) }));
  }

  /** What they have, with the button to buy credits when they pay as they go (/plan). */
  async show(customerId: CustomerId, view: CreditView): Promise<void> {
    const { language } = await this.#customers.get(customerId);
    const t = forLanguage(language);
    if (view.access === "invite" && view.balance === null) {
      await this.#messenger.say(customerId, t(SAID.invite));
      return;
    }
    await this.#withButton(customerId, t(SAID.credits, { balance: money(view.balance ?? 0, language) }), t(SAID.topUp));
  }

  /**
   * A pack was paid for: someone it let in is welcomed with their credits; anyone else hears what came in, and when
   * their credits had run out the manager picks the work back up.
   */
  async toppedUp(customerId: CustomerId, top: ToppedUp, stopped: boolean): Promise<void> {
    const { language } = await this.#customers.get(customerId);
    const t = forLanguage(language);
    const credit = money(top.credit, language);
    if (top.letIn && this.#welcome) {
      await this.#welcome(customerId, t(SAID.letIn, { credit }));
      return;
    }
    const words = top.bonus > 0
      ? t(SAID.toppedUpBonus, { credit, paid: money(top.credit - top.bonus, language), bonus: money(top.bonus, language) })
      : t(SAID.toppedUp, { credit });
    await this.#messenger.say(customerId, `${DONE_MARK}${words}`);
    if (stopped) await this.#events?.push(customerId, { kind: "system", topic: "credits", text: `They topped up: ${money(top.credit, "en")} in credits. Your stop for credits is over: pick the work back up.` });
  }

  /** The words, with a button to their credits page where there is one. */
  async #withButton(customerId: CustomerId, words: string, label: string): Promise<void> {
    const url = this.link(customerId);
    const links: OutgoingLink[] = url ? [{ label, url }] : [];
    if (!links.length) {
      await this.#messenger.say(customerId, words);
      return;
    }
    try {
      await this.#messenger.sendLinks(customerId, words, [...links, { label: SUPPORT_LINK, url: SUPPORT_URL }]);
    } catch (e) {
      // A chat that refuses the button (Telegram takes no localhost address in one) still gets the words and the address.
      this.#log.warn("credits.button_failed", { customerId, error: e instanceof Error ? e.message : String(e) });
      await this.#messenger.say(customerId, url ? `${words}\n\n${url}` : words);
    }
  }
}

