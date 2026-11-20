import { LOCALES, forLanguage } from "@mq/i18n";
import type { TelegramBotApi } from "./bot-api.ts";

const COMMANDS = [
  { command: "start", description: "Start over with Quest" },
  { command: "connect", description: "Connect your Chrome, where Quest reads the web" },
  { command: "plan", description: "Your credits and today's use" },
  { command: "support", description: "Get help from a person" },
  { command: "off", description: "Switch Quest off: nothing runs in your Chrome until /on" },
  { command: "on", description: "Switch Quest back on" },
  { command: "language", description: "Change language (automatic by default)" },
];

/** Deployment setup only. Does not change the webhook or drop queued messages. */
export async function configureBotLanguages(api: TelegramBotApi): Promise<void> {
  for (const locale of ["", ...LOCALES]) {
    const t = forLanguage(locale);
    await api.call("setMyCommands", { language_code: locale, commands: COMMANDS.map((c) => ({ ...c, description: t(c.description) })) });
    const description = t("Quest builds your brand while you build the product. It finds the people who want what you made and writes to them as you, with your OK. Your first run is free.");
    await api.call("setMyDescription", { language_code: locale, description });
    await api.call("setMyShortDescription", { language_code: locale, short_description: t("Builds your brand while you build the product. Your first run is free. Help: @theicreator") });
  }
}
