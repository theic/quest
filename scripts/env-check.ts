/**
 * Which database, bot and Stripe mode each env file points at, and whether that is its environment's
 * (apps/agent/src/environments.ts): .env.local dev's, .env.production.local production's. Also where each bot's
 * updates go, and any secret of one environment kept in the other's file. Prints names, never a value. Exits 1
 * when something is in the wrong place.
 *
 *   npm run env:check
 */
import { existsSync } from "node:fs";
import { DEV, liveStripeKey, PRODUCTION, STAGES, stageOfDatabase, supabaseRef, type Stage } from "../apps/agent/src/environments.ts";
import { botOf, envPath, readEnvFile } from "./env-file.ts";

const BOT_TOKEN = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;
let wrong = 0;
const ok = (line: string) => console.log(`  ✓ ${line}`);
const bad = (line: string) => {
  wrong++;
  console.log(`  ✗ ${line}`);
};

async function webhookOf(token: string): Promise<string | null> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`).catch(() => null);
  const body = (await res?.json().catch(() => null)) as { result?: { url?: string } } | null;
  return body?.result?.url || null;
}

for (const stage of STAGES) {
  const path = envPath(stage);
  console.log(`${stage}: ${path}`);
  if (!existsSync(path)) {
    console.log(`  - no file${stage === "dev" ? ": copy .env.example to .env.local" : " (only the machine that deploys needs it)"}`);
    continue;
  }
  const env = readEnvFile(path);
  const other: Stage = stage === "production" ? "dev" : "production";
  const want = stage === "production" ? PRODUCTION : DEV;

  const db = env.get("DATABASE_URL") ?? "";
  const dbStage = stageOfDatabase(db);
  if (dbStage === stage) ok(`database: Supabase ${want.supabase}`);
  else bad(`database: ${supabaseRef(db) ? `Supabase ${supabaseRef(db)}` : "not a known Supabase project"}${dbStage ? `, which is ${dbStage}'s` : ""}; ${stage} is ${want.supabase}`);

  const token = env.get("TELEGRAM_BOT_TOKEN");
  const bot = await botOf(token);
  if (!bot) bad("bot: TELEGRAM_BOT_TOKEN is missing or Telegram does not know it");
  else if (bot === want.bot) ok(`bot: @${bot}`);
  else if (bot === PRODUCTION.bot || stage === "production") bad(`bot: @${bot}; ${stage}'s is @${want.bot}`);
  else console.log(`  - bot: @${bot} (the usual dev bot is @${DEV.bot})`);

  if (token && bot) {
    const hook = await webhookOf(token);
    const expected = `${PRODUCTION.url}/telegram/webhook`;
    if (stage === "production") hook === expected ? ok(`updates: webhook to ${expected}`) : bad(`updates: webhook is ${hook ?? "unset"}; run scripts/telegram-webhook.ts`);
    else if (!hook) ok("updates: no webhook (npm run dev polls)");
    else bad(`updates: webhook to ${new URL(hook).origin}; dev's bot is only polled, and npm run dev takes it off`);
  }

  const stripe = env.get("STRIPE_SECRET_KEY");
  if (!stripe) console.log("  - stripe: not set (nothing sells)");
  else if (liveStripeKey(stripe)) stage === "production" ? ok("stripe: live") : bad("stripe: a live key; dev takes test keys only");
  else console.log(`  - stripe: test${stage === "production" ? " (production sells nothing real)" : ""}`);

  // A secret of the other environment, under any name (a production bot token kept "for later" in dev's file).
  for (const [key, value] of env) {
    if (key === "TELEGRAM_BOT_TOKEN" || !BOT_TOKEN.test(value)) continue;
    const name = await botOf(value);
    if (name && (name === PRODUCTION.bot) !== (stage === "production")) bad(`${key} is @${name}'s token, ${other}'s bot: keep it only in ${other === "production" ? PRODUCTION.envFile : DEV.envFile}`);
    else if (name) console.log(`  - ${key}: @${name}'s token, unused by the agent`);
  }
  for (const [key, value] of env) {
    if (key !== "DATABASE_URL" && /^postgres(ql)?:\/\//.test(value) && stageOfDatabase(value) === other) bad(`${key} is ${other}'s database`);
  }
}
process.exit(wrong ? 1 : 0);
