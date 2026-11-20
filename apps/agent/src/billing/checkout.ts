import { customerId as toCustomerId, type BillingRepository, type CustomerId, type CustomerRepository, type Logger, type ToppedUp } from "@mq/core";
import type { StripeApi, StripeCheckoutSession, StripeEvent } from "../infra/stripe.ts";
import { packOf } from "./plans.ts";

/** Stamped on everything Quest v2 sells, so the webhook leaves v1's payments in the same Stripe account alone. */
export const PRODUCT = "quest";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Not one of the packs: nothing to sell. */
export class NotForSale extends Error {}

/**
 * Credit packs through Stripe: a Checkout page that takes one payment for a pack (no subscription), and its webhook's
 * word that it was paid, which credits their wallet once per session (with the bonus on their very first top-up).
 * Only cards, so a payment is paid or not when Checkout completes; a late payment is counted when Stripe says it is.
 */
export class Checkout {
  readonly #stripe: StripeApi;
  readonly #billing: Pick<BillingRepository, "topUp">;
  readonly #customers: Pick<CustomerRepository, "get">;
  readonly #credited: (customerId: CustomerId, top: ToppedUp) => Promise<void>;
  readonly #log: Logger;

  constructor(deps: {
    stripe: StripeApi;
    billing: Pick<BillingRepository, "topUp">;
    customers: Pick<CustomerRepository, "get">;
    /** What follows a top-up: their stop ends and they hear it (Energy.toppedUp). */
    credited: (customerId: CustomerId, top: ToppedUp) => Promise<void>;
    log: Logger;
  }) {
    this.#stripe = deps.stripe;
    this.#billing = deps.billing;
    this.#customers = deps.customers;
    this.#credited = deps.credited;
    this.#log = deps.log;
  }

  /** Stripe's Checkout page for a pack of `usd`; `back` is their credits page. `bonus` is shown when it is their first top-up. */
  async start(customerId: CustomerId, usd: number, bonus: boolean, back: string): Promise<string> {
    const pack = packOf(usd);
    if (!pack) throw new NotForSale(`no pack of $${usd}`);
    const session = await this.#stripe.checkout({
      mode: "payment",
      "payment_method_types[0]": "card",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": pack.usd * 100,
      "line_items[0][price_data][product_data][name]": `Quest credits: $${pack.usd}`,
      "line_items[0][price_data][product_data][description]": bonus
        ? `$${pack.usd + pack.bonus} of credits: $${pack.usd}, plus a $${pack.bonus} bonus for your first top-up.`
        : `$${pack.usd} of credits for the AI Quest uses for you.`,
      "line_items[0][quantity]": 1,
      client_reference_id: customerId,
      "metadata[customer_id]": customerId,
      "metadata[product]": PRODUCT,
      "metadata[pack]": pack.usd,
      "payment_intent_data[metadata][customer_id]": customerId,
      "payment_intent_data[metadata][product]": PRODUCT,
      success_url: `${back}?paid=1`,
      cancel_url: back,
      locale: "auto",
    });
    if (!session.url) throw new Error("Stripe gave no Checkout address");
    this.#log.info("credits.checkout", { customerId, pack: pack.usd, test: this.#stripe.testMode });
    return session.url;
  }

  /** One of Stripe's webhook events: a Checkout for credits that is paid. */
  async handle(event: StripeEvent): Promise<void> {
    if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") return;
    const session = event.data.object as unknown as StripeCheckoutSession;
    if (session.mode !== "payment" || session.metadata?.["product"] !== PRODUCT || session.payment_status !== "paid") return;
    const raw = session.metadata?.["customer_id"] ?? session.client_reference_id ?? null;
    if (!raw || !UUID.test(raw)) return;
    const customerId = toCustomerId(raw);
    try {
      await this.#customers.get(customerId);
    } catch {
      this.#log.warn("credits.unknown_customer", { customerId });
      return;
    }
    if ((session.currency ?? "usd") !== "usd" || !session.amount_total) {
      this.#log.warn("credits.odd_payment", { customerId, session: session.id, currency: session.currency ?? null, amount: session.amount_total ?? null });
      return;
    }
    // What they paid is what Stripe took; the bonus only when it is a whole pack.
    const paid = session.amount_total / 100;
    const pack = packOf(paid);
    const top = await this.#billing.topUp({ session: session.id, customerId, paid, bonus: pack?.bonus ?? 0 });
    if (!top) return; // Stripe sent it again
    this.#log.info("credits.topped_up", { customerId, paid, credit: top.credit, test: this.#stripe.testMode });
    await this.#credited(customerId, top);
  }
}
