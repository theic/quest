import { forLanguage } from "@mq/i18n";
import type { BillingRepository, Customer, CustomerId, CustomerRepository, EventSink, Inbound, InviteRepository, Logger, Transcript } from "@mq/core";
import type { ChannelRegistry } from "./channel-registry.ts";

/** What someone new may spend on the hosted Quest before buying credits: the setup, the first sweep and its first people. */
export const FREE_START_USD = 1;
/** The first words to someone let in by a purchase or by hand, before the choice of language. */
export const LET_IN = "You're in.";
/** The event's topic when they are let in by hand in the database (the trigger mq.let_in queues it). */
export const LET_IN_TOPIC = "let_in";

/**
 * What in their message could be an invite's code: the message when it is one word, and a start link's parameter
 * (t.me/<bot>?start=<code>) pasted in it.
 */
export function inviteCodes(text: string): string[] {
  const said = text.trim();
  return [...(/^[\w-]{4,64}$/.test(said) ? [said] : []), ...[...said.matchAll(/[?&]start=([\w-]{4,64})/g)].map((m) => m[1]!)];
}

/**
 * The way in to the hosted Quest: nobody waits. Someone new is in at once, free on an invite's code they bring (a start
 * link, the extension's hello, a code Quest handed them in a thread), else on FREE_START_USD of credits, once ever; then
 * credits they buy (billing/checkout.ts). What they sent is then handled as anyone's.
 */
export class WayIn {
  readonly #customers: CustomerRepository;
  readonly #invites: Pick<InviteRepository, "redeem" | "noteOf">;
  readonly #billing: Pick<BillingRepository, "startFree">;
  readonly #transcript: Transcript;
  readonly #channels: ChannelRegistry;
  readonly #events: EventSink | null;
  readonly #wake: ((customerId: CustomerId) => void) | null;
  readonly #log: Logger;

  constructor(deps: {
    customers: CustomerRepository;
    invites: Pick<InviteRepository, "redeem" | "noteOf">;
    billing: Pick<BillingRepository, "startFree">;
    transcript: Transcript;
    channels: ChannelRegistry;
    /** Their manager hears where Quest met them, when their code carries it. */
    events?: EventSink;
    wake?: (customerId: CustomerId) => void;
    log: Logger;
  }) {
    this.#customers = deps.customers;
    this.#invites = deps.invites;
    this.#billing = deps.billing;
    this.#transcript = deps.transcript;
    this.#channels = deps.channels;
    this.#events = deps.events ?? null;
    this.#wake = deps.wake ?? null;
    this.#log = deps.log;
  }

  /** Someone not in yet wrote: in on an invite's code, else on a free start. True when they are in now. */
  async letIn(customer: Customer, inbound: Inbound): Promise<boolean> {
    const said = inbound.type === "text" ? inbound.text : inbound.type === "command" && inbound.command === "start" ? inbound.args : "";
    const codes = inviteCodes(said);
    if (codes.length && (await this.#invites.redeem(customer.id, codes))) {
      this.#log.info("way_in.invited", { customerId: customer.id });
      const note = await this.#invites.noteOf(customer.id).catch(() => null);
      if (note) await this.metBy(customer.id, note);
      return true;
    }
    if (!(await this.#billing.startFree(customer.id, FREE_START_USD))) return false;
    this.#log.info("way_in.started", { customerId: customer.id });
    return true;
  }

  /** Their manager hears where Quest met them (a thread, a message, a page made for them), and starts from that. */
  async metBy(customerId: CustomerId, note: string): Promise<void> {
    if (!this.#events) return;
    await this.#events.push(customerId, {
      kind: "system",
      topic: "met",
      text:
        `They came by the link Quest gave them where they met: ${note}\n` +
        "Pick up from that conversation: they know you. Use what it says (their product, their site, what they're after) and ask only what it leaves out; if it names their site, save it and start on it.",
    });
    this.#wake?.(customerId);
  }

  /**
   * They are in by a purchase or by hand: Quest says so and asks their language, which starts the first use as /start
   * does. Someone it talked with before hears only that they are in. `said`, in their language, stands for "You're in.".
   */
  async welcome(customerId: CustomerId, said?: string): Promise<void> {
    const [customer, to, recent] = await Promise.all([this.#customers.get(customerId), this.#customers.primaryChannel(customerId), this.#transcript.recent(customerId, 20)]);
    if (!to) return;
    const channel = this.#channels.get(to.kind);
    await channel.sendText(to, said ?? forLanguage(customer.language)(LET_IN));
    if (!recent.some((e) => e.direction === "out")) await channel.sendLanguageChoice(to, customer.language ?? "en");
  }
}
