import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { LANGUAGES, LOCALES } from "@mq/i18n";
import { describe, expect, it } from "vitest";
import { TelegramBotApi } from "../src/telegram/bot-api.ts";
import { TelegramChannel } from "../src/telegram/telegram-channel.ts";
import { parseUpdate } from "../src/telegram/updates.ts";
import { makeWorld, telegramSender } from "./world.ts";

/**
 * The opening (the founder, 2026-10-24: "The language should be the first question, with option to keep auto/default",
 * "let the user explain what he is working on in a voice or a message", "the very next message is a link to install
 * chrome extension, which is strange"): their language, one question, their words, then the Chrome.
 */

function telegram() {
  const calls: { method: string; body: Record<string, any> }[] = [];
  const stub = (async (url: string, init: { body: string }) => {
    calls.push({ method: url.split("/").at(-1)!, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length, chat: { id: 42, type: "private" }, date: 0 } }));
  }) as unknown as typeof fetch;
  return { calls, channel: new TelegramChannel(new TelegramBotApi("TOKEN", stub)) };
}

describe("the language choice", () => {
  it("leads with their Telegram's language to keep, then English, then the rest, each in its own name", async () => {
    const { calls, channel } = telegram();
    await channel.sendLanguageChoice({ kind: "telegram", address: "42" }, "pt");
    const body = calls[0]!.body as { text: string; reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
    const rows = body.reply_markup.inline_keyboard;
    expect(rows[0]).toEqual([{ text: "Português", callback_data: "lang:auto" }]);
    expect(rows[1]![0]).toEqual({ text: "English", callback_data: "lang:en" });
    const all = rows.flat();
    expect(all.map((b) => b.text).sort()).toEqual(Object.values(LANGUAGES).sort());
    expect(all.every((b) => Buffer.byteLength(b.callback_data) <= 64)).toBe(true);
    expect(body.text).toBe("Qual idioma?");
  });

  it("is English first for English, and never offers a language twice", async () => {
    const { calls, channel } = telegram();
    await channel.sendLanguageChoice({ kind: "telegram", address: "42" }, "en");
    const rows = (calls[0]!.body as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } }).reply_markup.inline_keyboard;
    expect(rows[0]).toEqual([{ text: "English", callback_data: "lang:auto" }]);
    expect(rows.flat()).toHaveLength(LOCALES.length);
  });

  it("is a tap that reaches the inbound service", () => {
    const tap = (data: string) => parseUpdate({ update_id: 1, callback_query: { id: "cb", from: { id: 42, is_bot: false, first_name: "Dana", language_code: "pt" }, message: { message_id: 7, chat: { id: 42, type: "private" } }, data } } as never);
    expect(tap("lang:auto")).toMatchObject({ type: "language", locale: "auto", ackRef: "cb", messageRef: "7" });
    expect(tap("lang:uk")).toMatchObject({ type: "language", locale: "uk" });
    expect(tap("lang:../../x")).toBeNull();
  });
});

describe("the Chrome setup", () => {
  it("goes out after the manager's reply, never before the words that say why", async () => {
    const manager = fakeModel()
      .respondWithTools([
        { name: "save_site", args: { url: "acme.test" } },
        { name: "connect_chrome", args: {} },
      ])
      .respond(new AIMessage("Reading acme.test now. To look where your people ask I need your Chrome."));
    const world = makeWorld({ manager });
    world.chrome.state = { linked: false, online: false, device: null, lastSeenAt: null };
    const order: string[] = [];
    const offer = world.chrome.offer.bind(world.chrome);
    world.chrome.offer = async (id, opts) => {
      order.push(`chrome setup after ${world.channel.sent.length} messages`);
      return offer(id, opts);
    };
    await world.inbound.handle({ type: "command", from: telegramSender(), command: "start", args: "", messageRef: "1" });
    await world.inbound.handle({ type: "text", from: telegramSender(), text: "acme.test", messageRef: "2", replyToRef: null });
    await world.manager.serveNext();

    expect(world.channel.sent.map((m) => m.text)).toEqual(["[language choice]", "Reading acme.test now. To look where your people ask I need your Chrome."]);
    // The setup was asked for during the turn, and sent only once its reply had gone.
    expect(order).toEqual(["chrome setup after 2 messages"]);
  });
});

describe("the first Chrome setup is the turn's, not the model's", () => {
  it("goes out once under the reply when the model forgot it, and never again", async () => {
    const manager = fakeModel()
      .respond(new AIMessage("Got it, reading acme.test now. Connect your Chrome and I'll start finding people."))
      .respond(new AIMessage("Still on it."));
    const world = makeWorld({ manager });
    world.chrome.state = { linked: false, online: false, device: null, lastSeenAt: null };
    await world.inbound.handle({ type: "text", from: telegramSender(), text: "I make acme.test, an analytics tool", messageRef: "1", replyToRef: null });
    await world.manager.serveNext();
    expect(world.chrome.offers).toHaveLength(1);

    await world.inbound.handle({ type: "text", from: telegramSender(), text: "any news?", messageRef: "2", replyToRef: null });
    await world.manager.serveNext();
    expect(world.chrome.offers).toHaveLength(1);
  });

  it("is not sent to someone whose Chrome is connected, or who has not said what they work on", async () => {
    const connected = makeWorld({ manager: fakeModel().respond(new AIMessage("Reading it now.")) });
    await connected.inbound.handle({ type: "text", from: telegramSender(), text: "I make acme.test", messageRef: "1", replyToRef: null });
    await connected.manager.serveNext();
    expect(connected.chrome.offers).toHaveLength(0);

    const unsure = makeWorld({ manager: fakeModel().respond(new AIMessage("What do you want me to do for you?")) });
    unsure.chrome.state = { linked: false, online: false, device: null, lastSeenAt: null };
    await unsure.inbound.handle({ type: "text", from: telegramSender(), text: "hi", messageRef: "1", replyToRef: null });
    await unsure.manager.serveNext();
    expect(unsure.chrome.offers).toHaveLength(0);
  });
});
