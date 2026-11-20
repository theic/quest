import { SKIPPED } from "@mq/core";
import { describe, expect, it } from "vitest";
import { splitMessage, toPlainText, toTelegramHtml } from "../src/telegram/format.ts";
import { choiceData, parseUpdate } from "../src/telegram/updates.ts";
import { normaliseSite } from "../src/manager/tools.ts";
import { TelegramBotApi } from "../src/telegram/bot-api.ts";
import { TelegramChannel } from "../src/telegram/telegram-channel.ts";

describe("reactions on Telegram", () => {
  it("puts one emoji on the message with setMessageReaction", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchStub = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: true }));
    }) as unknown as typeof fetch;
    const channel = new TelegramChannel(new TelegramBotApi("TOKEN", fetchStub));

    await channel.react({ kind: "telegram", address: "42" }, "11", "👍");

    expect(calls).toEqual([
      { url: "https://api.telegram.org/botTOKEN/setMessageReaction", body: { chat_id: "42", message_id: 11, reaction: [{ type: "emoji", emoji: "👍" }] } },
    ]);
  });
});

const user = { id: 42, is_bot: false, first_name: "Dana", language_code: "en" };
const chat = { id: 42, type: "private" as const };

describe("parseUpdate", () => {
  it("reads a text message and what it replies to", () => {
    const inbound = parseUpdate({
      update_id: 1,
      message: { message_id: 5, from: user, chat, date: 0, text: "hello", reply_to_message: { message_id: 3, chat, date: 0 } },
    });
    expect(inbound).toMatchObject({ type: "text", text: "hello", messageRef: "5", replyToRef: "3", from: { userRef: "42", displayName: "Dana" } });
  });

  it("reads a command, with or without the bot's name", () => {
    expect(parseUpdate({ update_id: 1, message: { message_id: 1, from: user, chat, date: 0, text: "/start ph_launch" } })).toMatchObject({
      type: "command",
      command: "start",
      args: "ph_launch",
    });
    expect(parseUpdate({ update_id: 2, message: { message_id: 2, from: user, chat, date: 0, text: "/Help@QuestBot" } })).toMatchObject({
      command: "help",
      args: "",
    });
  });

  it("reads an answer button", () => {
    const id = "0b9c3c5e-9f7e-4a53-9d51-2f0d1f6a7b11";
    const inbound = parseUpdate({ update_id: 1, callback_query: { id: "cb", from: user, message: { message_id: 8, chat, date: 0 }, data: choiceData(id, 2) } });
    expect(inbound).toMatchObject({ type: "choice", questionId: id, option: 2, ackRef: "cb", messageRef: "8" });
    expect(choiceData(id, 2).length).toBeLessThanOrEqual(64);
  });

  it("reads no quest button: there are no quests to choose (2026-10-29)", () => {
    const tap = (data: string) => parseUpdate({ update_id: 1, callback_query: { id: "cb", from: user, message: { message_id: 8, chat, date: 0 }, data } });
    expect(tap("quest:career")).toBeNull();
  });

  it("reads a file, with the words sent along", () => {
    const document = { file_id: "F1", file_name: "cv.pdf", mime_type: "application/pdf", file_size: 48_000 };
    expect(parseUpdate({ update_id: 1, message: { message_id: 5, from: user, chat, date: 0, document, caption: "my CV" } })).toEqual({
      type: "file",
      from: expect.anything(),
      fileRef: "F1",
      fileName: "cv.pdf",
      mimeType: "application/pdf",
      size: 48_000,
      caption: "my CV",
      messageRef: "5",
      replyToRef: null,
    });
    // A screenshot sent as a photo is a picture file, the largest size, read like one (live, 2026-10-14: it was dropped).
    const photo = [{ file_id: "S", width: 90, height: 160 }, { file_id: "L", width: 720, height: 1280, file_size: 99_000 }];
    expect(parseUpdate({ update_id: 2, message: { message_id: 7, from: user, chat, date: 0, photo, caption: "This is him" } })).toMatchObject({
      type: "file", fileRef: "L", mimeType: "image/jpeg", size: 99_000, caption: "This is him", messageRef: "7",
    });
  });

  it("reads a voice message, an audio file and an audio file sent as a file as something said", () => {
    const voice = { file_id: "V1", duration: 7, mime_type: "audio/ogg", file_size: 21_000 };
    expect(parseUpdate({ update_id: 1, message: { message_id: 6, from: user, chat, date: 0, voice, reply_to_message: { message_id: 3, chat, date: 0 } } })).toEqual({
      type: "voice",
      from: expect.anything(),
      fileRef: "V1",
      mimeType: "audio/ogg",
      fileName: null,
      seconds: 7,
      size: 21_000,
      caption: "",
      messageRef: "6",
      replyToRef: "3",
    });
    const audio = { file_id: "A1", duration: 95, file_name: "pitch.mp3", mime_type: "audio/mpeg", file_size: 1_500_000 };
    expect(parseUpdate({ update_id: 1, message: { message_id: 7, from: user, chat, date: 0, audio, caption: "my pitch" } })).toMatchObject({
      type: "voice",
      fileRef: "A1",
      fileName: "pitch.mp3",
      mimeType: "audio/mpeg",
      seconds: 95,
      caption: "my pitch",
    });
    const document = { file_id: "D1", file_name: "memo.m4a", mime_type: "audio/x-m4a", file_size: 300_000 };
    expect(parseUpdate({ update_id: 1, message: { message_id: 8, from: user, chat, date: 0, document } })).toMatchObject({ type: "voice", fileRef: "D1", fileName: "memo.m4a", seconds: null });
  });

  it("ignores groups, bots and messages without text", () => {
    expect(parseUpdate({ update_id: 1, message: { message_id: 1, from: user, chat: { id: -1, type: "group" }, date: 0, text: "hi" } })).toBeNull();
    expect(parseUpdate({ update_id: 1, message: { message_id: 1, from: { ...user, is_bot: true }, chat, date: 0, text: "hi" } })).toBeNull();
    expect(parseUpdate({ update_id: 1, message: { message_id: 1, from: user, chat, date: 0 } })).toBeNull();
  });
});

describe("formatting", () => {
  it("escapes HTML and keeps bold, code and links", () => {
    expect(toTelegramHtml("**Hi** <b> & `a<b>` [site](https://x.test/?a=1&b=2)")).toBe(
      '<b>Hi</b> &lt;b&gt; &amp; <code>a&lt;b&gt;</code> <a href="https://x.test/?a=1&amp;b=2">site</a>',
    );
  });

  it("turns list markers into bullets and headings into bold", () => {
    expect(toTelegramHtml("# Plan\n- one\n* two")).toBe("<b>Plan</b>\n• one\n• two");
  });

  it("falls back to plain words", () => {
    expect(toPlainText("**Hi** [site](https://x.test)")).toBe("Hi site (https://x.test)");
  });

  it("splits long messages at paragraph boundaries", () => {
    const parts = splitMessage(`${"a".repeat(3000)}\n\n${"b".repeat(3000)}`, 4000);
    expect(parts).toEqual(["a".repeat(3000), "b".repeat(3000)]);
  });
});

describe("normaliseSite", () => {
  it("accepts what people type", () => {
    expect(normaliseSite("acme.com")).toBe("https://acme.com/");
    expect(normaliseSite("https://www.acme.com/pricing).")).toBe("https://www.acme.com/pricing");
  });

  it("rejects what is not an address", () => {
    expect(normaliseSite("my startup")).toBeNull();
    expect(normaliseSite("localhost")).toBeNull();
  });
});
