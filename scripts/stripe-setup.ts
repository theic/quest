/**
 * Makes what Quest needs in Stripe, in the mode of the key in the env file (test or live). The credit packs need
 * nothing made: each Checkout carries its pack's price (billing/checkout.ts). Given the agent's public address, it
 * makes the webhook endpoint, whose signing secret it writes to the env file as STRIPE_WEBHOOK_SECRET, or brings an
 * endpoint it made before up to the events Quest reads. Prints names and ids, never a secret.
 *
 * Production's address reads and writes .env.production.local; without an address it is dev's .env.local (test
 * mode: Stripe cannot reach a laptop, scripts/try-stripe-events.ts delivers its events there).
 *
 *   node --experimental-strip-types scripts/stripe-setup.ts                              # dev: checks the key
 *   node --experimental-strip-types scripts/stripe-setup.ts https://mq-v2-agent.fly.dev  # production, with its webhook
 */
import { StripeApi } from "../apps/agent/src/infra/stripe.ts";
import { liveStripeKey, PRODUCTION, stageOfDatabase } from "../apps/agent/src/environments.ts";
import { envPath, readEnvFile, setEnvValue } from "./env-file.ts";

const EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded"];

// Production's address takes production's file (its webhook secret belongs there); without one, dev's.
const base = process.argv[2]?.replace(/\/+$/, "");
const ENV_PATH = envPath(base === PRODUCTION.url ? "production" : "dev");
const env = readEnvFile(ENV_PATH);
const key = env.get("STRIPE_SECRET_KEY");
if (!key) throw new Error(`STRIPE_SECRET_KEY is not in ${ENV_PATH}`);
const stage = stageOfDatabase(env.get("DATABASE_URL") ?? "");
if (base === PRODUCTION.url && stage !== "production") throw new Error(`${ENV_PATH} is not production's: production's webhook secret goes only to production's file`);
if (base && base !== PRODUCTION.url && stage === "production") throw new Error(`production's Stripe webhook goes only to ${PRODUCTION.url}`);
if (stage !== "production" && liveStripeKey(key)) throw new Error(`${ENV_PATH} is not production's, but its Stripe key is live`);
const stripe = new StripeApi(key);
const account = await stripe.call<{ id: string }>("GET", "account");
console.log(`Stripe ${stripe.testMode ? "test" : "LIVE"} mode, account ${account.id}, from ${ENV_PATH}`);

if (base) {
  if (!base.startsWith("https://")) throw new Error("the webhook needs the agent's https address");
  const url = `${base}/stripe/webhook`;
  const hooks = await stripe.call<{ data: { id: string; url: string; enabled_events: string[] }[] }>("GET", "webhook_endpoints", { limit: 100 });
  const old = hooks.data.find((h) => h.url === url);
  const params: Record<string, string> = { description: "Quest v2: credit packs" };
  EVENTS.forEach((e, i) => (params[`enabled_events[${i}]`] = e));
  if (old && env.get("STRIPE_WEBHOOK_SECRET")) {
    // Its secret stays: only what it sends changes.
    const same = old.enabled_events.length === EVENTS.length && EVENTS.every((e) => old.enabled_events.includes(e));
    if (!same) await stripe.call("POST", `webhook_endpoints/${old.id}`, params);
    console.log(`webhook ${old.id} → ${url} (${same ? "kept" : "now sends " + EVENTS.join(", ")}; its secret is in the env file)`);
  } else {
    // Stripe shows an endpoint's secret only when it is made: one without its secret here is made again.
    if (old) await stripe.call("DELETE", `webhook_endpoints/${old.id}`);
    const made = await stripe.call<{ id: string; secret: string }>("POST", "webhook_endpoints", { url, ...params });
    setEnvValue("STRIPE_WEBHOOK_SECRET", made.secret, ENV_PATH);
    console.log(`webhook ${made.id} → ${url} (made; STRIPE_WEBHOOK_SECRET written to the env file)`);
  }
}
