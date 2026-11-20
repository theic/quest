import { forLanguage } from "@mq/i18n";
import type { CustomerRepository, Logger } from "@mq/core";
import { Hono, type Context } from "hono";
import { NotForSale, type Checkout } from "../billing/checkout.ts";
import type { Energy } from "../billing/energy.ts";
import type { PlanLinks } from "../billing/plans.ts";
import { StripeError, stripeSigned, type StripeEvent } from "../infra/stripe.ts";
import { planPage } from "./plan-page.ts";

const NOT_FOUND = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quest</title><body style="background:#0b0c0b;color:#e8e8dc;font:15px system-ui;padding:40px 16px;text-align:center">This link is not valid. Open your credits from Quest's chat in Telegram (/plan).</body>`;

/**
 * Their credits page, by the signed address in their chat (`/plan/<token>`): no sign-in, the link is the key. Its
 * packs post to `/checkout`, which sends them to Stripe's page. Stripe's webhook (`/stripe/webhook`) answers only to
 * events signed with the endpoint's secret.
 */
export function planRoutes(deps: {
  links: PlanLinks;
  energy: Pick<Energy, "view">;
  customers: Pick<CustomerRepository, "get">;
  /** Null while Stripe is not set up: the page shows the packs, and paying waits. */
  checkout: Checkout | null;
  webhookSecret: string | null;
  log: Logger;
  now?: () => Date;
}): Hono {
  const app = new Hono();
  const now = deps.now ?? (() => new Date());

  const render = async (c: Context, token: string, problem: string | null = null) => {
    const link = deps.links.read(token);
    if (!link) return c.html(NOT_FOUND, 404);
    const customer = await deps.customers.get(link.customerId).catch(() => null);
    if (!customer) return c.html(NOT_FOUND, 404);
    c.header("Cache-Control", "no-store");
    const view = await deps.energy.view(customer.id);
    const paid = c.req.query("paid") === "1";
    const sells = !customer.activatedAt || view.access === "credits" || view.balance !== null;
    return c.html(
      planPage({
        language: customer.language,
        view,
        waiting: !customer.activatedAt,
        self: `/plan/${token}`,
        paid,
        problem,
        now: now(),
      }),
    );
  };

  app.get("/plan/:token", (c) => render(c, c.req.param("token")));

  app.post("/plan/:token/checkout", async (c) => {
    const token = c.req.param("token");
    const link = deps.links.read(token);
    if (!link) return c.html(NOT_FOUND, 404);
    const customer = await deps.customers.get(link.customerId).catch(() => null);
    if (!customer) return c.html(NOT_FOUND, 404);
    const t = forLanguage(customer.language);
    if (!deps.checkout) return render(c, token, t("Payments aren't open yet. Try again a little later."));
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const usd = Number(form["pack"]);
    try {
      // Stripe sends them back to the page's public address (behind Fly's proxy the request's own reads http).
      const back = deps.links.url(link.customerId);
      const { firstTopUp } = await deps.energy.view(customer.id);
      return c.redirect(await deps.checkout.start(customer.id, usd, firstTopUp, back), 303);
    } catch (e) {
      if (e instanceof NotForSale) return render(c, token);
      deps.log.error("credits.checkout_failed", { customerId: customer.id, error: e instanceof Error ? e.message : String(e) });
      // A key Stripe no longer takes (live, 2026-10-16: v1's test key had expired): not open yet.
      const closed = e instanceof StripeError && (e.status === 401 || e.status === 403);
      return render(c, token, closed ? t("Payments aren't open yet. Try again a little later.") : t("Stripe didn't answer. Try again in a minute."));
    }
  });


  /** Stripe's events: signed with the endpoint's secret, or refused. A failure answers 500, so Stripe sends it again. */
  app.post("/stripe/webhook", async (c) => {
    if (!deps.webhookSecret || !deps.checkout) return c.json({ error: "Stripe is not set up here." }, 503);
    const payload = await c.req.text();
    if (!stripeSigned(payload, c.req.header("stripe-signature"), deps.webhookSecret, Math.floor(now().getTime() / 1000))) return c.json({ error: "Bad signature." }, 400);
    let event: StripeEvent;
    try {
      event = JSON.parse(payload) as StripeEvent;
    } catch {
      return c.json({ error: "Not JSON." }, 400);
    }
    try {
      await deps.checkout.handle(event);
    } catch (e) {
      deps.log.error("credits.webhook_failed", { type: event.type, id: event.id, error: e instanceof Error ? e.message : String(e) });
      return c.json({ error: "Not kept; send it again." }, 500);
    }
    deps.log.info("credits.webhook", { type: event.type, id: event.id });
    return c.json({ received: true });
  });

  return app;
}
