/** Update translated bot menus/profile without changing webhook settings or sending messages. */
import { readEnvFile } from "./env-file.ts";
import { TelegramBotApi } from "../apps/agent/src/telegram/bot-api.ts";
import { configureBotLanguages } from "../apps/agent/src/telegram/languages.ts";

const token = readEnvFile().get("TELEGRAM_BOT_TOKEN");
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
await configureBotLanguages(new TelegramBotApi(token));
console.log("Translated bot commands and profile updated for all supported languages.");
