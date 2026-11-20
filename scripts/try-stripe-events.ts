/**
 * Stripe cannot reach a laptop agent's webhook, so this delivers Stripe's own recent events to it, signed with the env
 * file's STRIPE_WEBHOOK_SECRET the way Stripe signs them: a test payment on Checkout, then this, is the whole flow.
 * Prints each event's type and the agent's answer, never a secret. Test mode only.
 *
 *   node --experimental-strip-types scripts/try-stripe-events.ts [minutes back, 30] [newest|oldest] [agent, http://localhost:8080]
 */
import { StripeApi, stripeSignature } from "../apps/agent/src/infra/stripe.ts";
import { ENV_PATH, readEnvFile } from "./env-file.ts";

const [minutes = "30", order = "newest", agent = "http://localhost:8080"] = process.argv.slice(2);
const env = readEnvFile();
const key = env.get("STRIPE_SECRET_KEY");
const secret = env.get("STRIPE_WEBHOOK_SECRET");
if (!key || !secret) throw new Error(`STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must be in ${ENV_PATH}`);
const stripe = new StripeApi(key);
if (!stripe.testMode) throw new Error("a live key: Stripe delivers live events to the deployed agent itself");

const params: Record<string, string | number> = { limit: 50, "created[gte]": Math.floor(Date.now() / 1000) - Number(minutes) * 60 };
["checkout.session.completed", "checkout.session.async_payment_succeeded"].forEach((t, i) => (params[`types[${i}]`] = t));
const { data } = await stripe.call<{ data: { id: string; type: string; created: number }[] }>("GET", "events", params);
// Newest first by default: Stripe promises no order, and the agent must not care.
for (const event of order === "oldest" ? [...data].reverse() : data) {
  const body = JSON.stringify(event);
  const res = await fetch(`${agent.replace(/\/+$/, "")}/stripe/webhook`, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json", "Stripe-Signature": stripeSignature(body, secret, Math.floor(Date.now() / 1000)) },
  });
  console.log(new Date(event.created * 1000).toISOString(), event.type, res.status, (await res.text()).slice(0, 80));
}
if (!data.length) console.log(`no Stripe events in the last ${minutes} minutes`);
