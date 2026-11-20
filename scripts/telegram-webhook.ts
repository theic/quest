/**
 * Points production's bot at production's agent: sets the webhook (with the shared secret Telegram sends back on
 * every update), the bot's commands, and says whether the Quest button is on. Only production has a webhook: dev's bot is polled by
 * the laptop agent (npm run dev). So it reads .env.production.local and stops unless its bot is
 * @messagingquestbot and the address production's. Prints the bot's name and the webhook address, never the
 * token or the secret.
 *
 *   node --experimental-strip-types scripts/telegram-webhook.ts [https://mq-v2-agent.fly.dev]
 */
import { PRODUCTION } from "../apps/agent/src/environments.ts";
import { configureBotLanguages } from "../apps/agent/src/telegram/languages.ts";
import { TelegramBotApi, UPDATES } from "../apps/agent/src/telegram/bot-api.ts";
import { checkStage, envPath, readEnvFile } from "./env-file.ts";

const base = (process.argv[2] ?? PRODUCTION.url).replace(/\/+$/, "");
if (base !== PRODUCTION.url) throw new Error(`the webhook goes only to production, ${PRODUCTION.url}: dev's bot is polled by npm run dev`);
const path = envPath("production");
const env = readEnvFile(path);
const token = env.get("TELEGRAM_BOT_TOKEN");
const secret = env.get("TELEGRAM_WEBHOOK_SECRET");
if (!token || !secret) throw new Error(`TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET must be in ${path}`);
await checkStage("production", env, path);

async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!body.ok) throw new Error(`${method}: ${body.description}`);
  return body.result as T;
}

const url = `${base}/telegram/webhook`;
const me = await call<{ username: string }>("getMe");
await call("setWebhook", { url, secret_token: secret, allowed_updates: UPDATES });
await configureBotLanguages(new TelegramBotApi(token));
// The menu button is the agent's: it sets the Quest button (the Mini App) at start, and nothing here touches it.
// Live, 2026-11-09: this script set it back to the command list, and the Quest button was gone until a restart.
const menu = await call<{ type: string }>("getChatMenuButton");
if (menu.type !== "web_app") console.log(`menu button is "${menu.type}", not the Quest button: restart the agent to set it`);
const info = await call<{ url: string; pending_update_count: number; last_error_message?: string }>("getWebhookInfo");
console.log(`@${me.username} → ${info.url} (pending ${info.pending_update_count}${info.last_error_message ? `, last error: ${info.last_error_message}` : ""})`);
