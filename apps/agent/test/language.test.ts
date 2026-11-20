import { describe, expect, it } from "vitest";
import { LOCALES, customerLocale, detectLocale, nextLanguage, direction, forLanguage, languageBriefing, systemMessage, textPrefix } from "@mq/i18n";
import { makeWorld, telegramSender } from "./world.ts";
import { TelegramBotApi } from "../src/telegram/bot-api.ts";
import { TelegramChannel } from "../src/telegram/telegram-channel.ts";
import { isQuestion, reactionRefusal } from "../src/conversation/reactions.ts";
import { asks } from "../src/manager/follow-up.ts";
import { splitMessage } from "../src/telegram/format.ts";
import { configureBotLanguages } from "../src/telegram/languages.ts";
import { createServer } from "../src/http/server.ts";
import { Traffic } from "../src/lifecycle/traffic.ts";
import { silentLogger } from "../src/infra/system.ts";
import { unstyled, voiceNotes } from "../src/lib/voice.ts";

describe("language preferences", () => {
  it("matches regional codes in preference order and falls back safely", () => {
    expect(detectLocale(["it-IT", "uk-UA", "en-US"])).toBe("uk");
    expect(detectLocale(["pt_BR"])).toBe("pt");
    expect(detectLocale(["zh-Hant-TW"])).toBe("zh");
    expect(detectLocale(["constructor", "__proto__", "<script>"])).toBe("en");
    expect(detectLocale([])).toBe("en");
    expect(direction("ar")).toBe("rtl");
    expect(direction("uk")).toBe("ltr");
  });

  it("takes the language from the first message, and keeps it whatever device writes next", () => {
    expect(nextLanguage(null, "ru-RU")).toBe("ru");
    expect(nextLanguage(null, "it")).toBe("en");
    expect(nextLanguage(null, null)).toBe("en");
    // Live, 2026-10-14: the founder wrote in English from a phone set to Portuguese, and Quest answered in Portuguese.
    expect(nextLanguage("en", "pt-BR")).toBe("en");
    expect(nextLanguage("uk", null)).toBe("uk");
    expect(nextLanguage("manual:es", "ru")).toBe("manual:es");
    expect(customerLocale("manual:es")).toBe("es");
  });

  it("persists /language separately from platform detection, and auto resets it", async () => {
    const world = makeWorld();
    const from = { ...telegramSender(), language: "uk-UA" };
    await world.inbound.handle({ type: "command", from, command: "start", args: "", messageRef: "1" });
    let c = (await world.customers.findByChannel(from.channel))!;
    expect(c.language).toBe("uk");
    await world.inbound.handle({ type: "command", from, command: "language", args: "es", messageRef: "2" });
    await world.inbound.handle({ type: "text", from: { ...from, language: "ru" }, text: "Hello", replyToRef: null, messageRef: "3" });
    c = (await world.customers.get(c.id));
    expect(c.language).toBe("manual:es");
    expect(languageBriefing(c.language)).toContain("Español (es)");
    await world.inbound.handle({ type: "command", from, command: "language", args: "auto", messageRef: "4" });
    expect((await world.customers.get(c.id)).language).toBe("uk");
    const previous = world.events.events.length;
    await world.inbound.handle({ type: "command", from, command: "language", args: "invalid", messageRef: "5" });
    expect(world.channel.sent.at(-1)?.text).toContain("/language uk · Українська");
    expect(world.events.events).toHaveLength(previous);
  });

  it("localizes buttons per customer and keeps callback IDs and user content intact", async () => {
    const sent: Record<string, any>[] = [];
    const api = new TelegramBotApi("fake", (async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }) as typeof fetch);
    const channel = new TelegramChannel(api, async (to) => to.address === "42" ? "ru" : "uk");
    const question = { id: "00000000-0000-4000-8000-000000000001", text: "Free plan in the replies?", options: ["Yes", "No"] } as never;
    await Promise.all([channel.sendQuestion({ kind: "telegram", address: "42" }, question), channel.sendQuestion({ kind: "telegram", address: "99" }, question)]);
    for (const message of sent) {
      const language = message.chat_id === "42" ? "ru" : "uk";
      expect(message.text).toContain(forLanguage(language)("Tap an answer, or reply to this message in your own words."));
      expect(message.reply_markup.inline_keyboard[0][0].callback_data).toBe("q:00000000-0000-4000-8000-000000000001:0");
    }
    const source = 'Customer said: <script>alert("no")</script> — Україна 🇺🇦';
    await channel.sendText({ kind: "telegram", address: "42" }, source);
    expect(sent.at(-1)?.text).toContain("&lt;script&gt;");
    expect(sent.at(-1)?.text).toContain("Україна 🇺🇦");
  });

  it("interpolates system values without translating accounts, codes or unknown customer text", () => {
    expect(systemMessage("ru", "your reply to sam on Reddit")).toContain("sam");
    expect(systemMessage("ru", "your reply to sam on Reddit")).toContain("Reddit");
    expect(systemMessage("ru", "Uncatalogued customer words <b>hi</b>")).toBe("Uncatalogued customer words <b>hi</b>");
    expect(forLanguage("ru")("I'll use {language} from now on.", { language: "Українська" })).toContain("Українська");
  });

  it("translates a catalogued message of several lines, not a loose pattern that happens to fit it", () => {
    const setup = "I read where your people ask in your own Chrome, so open this there, on a computer. Nothing goes up without your OK.";
    expect(systemMessage("uk", `${setup}\n\nIf that page doesn't open in Chrome, enter the code X9AA-SCQM in the extension. It works for 15 minutes.`)).toMatch(/^Я читаю там[\s\S]*X9AA-SCQM/);
    expect(systemMessage("uk", "$1.23 of $5.00")).toBe("$1.23 з $5.00");
  });

  it("recognizes Arabic and Chinese questions and preserves surrogate pairs in long messages", () => {
    for (const question of ["كيف تسير الأمور؟", "有什么进展？", "Як справи?"]) {
      expect(isQuestion(question)).toBe(true);
      expect(asks(question)).toBe(true);
      expect(reactionRefusal("👍", { text: question }, [])).not.toBeNull();
    }
    const text = "中".repeat(3999) + "😀" + "文".repeat(3999);
    const parts = splitMessage(text);
    expect(parts.join("")).toBe(text);
    expect(parts.every((p) => p.length <= 4000 && !/\p{Surrogate}/u.test(p))).toBe(true);
    expect(textPrefix("ab👩🏽‍💻cd", 7)).toBe("ab");
    expect(textPrefix("abकिcd", 3)).toBe("ab");
    expect(textPrefix("abe\u0301cd", 4)).toBe("abe\u0301");
    expect(unstyled("Quest — ваш помічник.")).toBe("Quest — ваш помічник.");
    expect(voiceNotes("Пока никто не ответил.", { language: "ru", progress: true })).toEqual([]);
  });

  it("publishes translated Telegram menus/profile without touching updates or webhooks", async () => {
    const requests: { method: string; body: Record<string, any> }[] = [];
    const api = new TelegramBotApi("fake", (async (url, init) => {
      requests.push({ method: String(url).split("/").at(-1)!, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, result: true }));
    }) as typeof fetch);
    await configureBotLanguages(api);
    expect(requests).toHaveLength((LOCALES.length + 1) * 3);
    expect([...new Set(requests.map(r => r.method))].sort()).toEqual(["setMyCommands", "setMyDescription", "setMyShortDescription"]);
    for (const { method, body } of requests) {
      const t = forLanguage(body.language_code);
      if (method === "setMyCommands") expect(body.commands.at(-1)).toEqual({ command: "language", description: t("Change language (automatic by default)") });
      if (method === "setMyDescription") expect([...body.description].length).toBeLessThanOrEqual(512);
      if (method === "setMyShortDescription") expect([...body.short_description].length).toBeLessThanOrEqual(120);
    }
  });

  it("serves only the bundled public translation assets as Unicode", async () => {
    const world = makeWorld();
    const app = createServer({ webhookSecret: "test-only", inbound: world.inbound, traffic: new Traffic(Date.now), wake: { key: () => null, nudge() {} }, log: silentLogger, health: () => ({}) });
    for (const locale of LOCALES) {
      const response = await app.request(`/i18n/locales/${locale}.json`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json; charset=utf-8");
      expect((await response.json())["Language"]).toBe(forLanguage(locale)("Language"));
    }
    for (const file of ["server.js", "locales/it.json", ".env.local"]) expect((await app.request(`/i18n/${file}`)).status).toBe(404);
  });
});
