import { draftId, findId, questionId, type Inbound, type Sender } from "@mq/core";
import type { TgCallbackQuery, TgChat, TgUpdate, TgUser } from "./bot-api.ts";
import { parseDraftData } from "./draft-card.ts";
import { parseFindData } from "./find-card.ts";

/** Buttons carry `q:<question id>:<option index>` — well under Telegram's 64-byte limit. */
export const choiceData = (id: string, option: number): string => `q:${id}:${option}`;

const CHOICE = /^q:([0-9a-f-]{36}):(\d{1,2})$/;

/** The language choice's buttons carry `lang:auto` or `lang:<locale>`. */
export const languageData = (locale: string): string => `lang:${locale}`;

const LANGUAGE = /^lang:(auto|[a-z]{2})$/;

/** The off switch's button carries `power:on` or `power:off`. */
export const powerData = (on: boolean): string => `power:${on ? "on" : "off"}`;

const POWER = /^power:(on|off)$/;

/** An idea card's buttons carry `idea:<idea id>:yes|no`. */
export const ideaData = (id: string, action: "yes" | "no"): string => `idea:${id}:${action}`;

const IDEA = /^idea:([0-9a-f-]{36}):(yes|no)$/;

/**
 * The deck's own buttons (Your move) carry `mv:`, `all:`, `one:`, `none:`, `yes:` or `no:` and an ask's key: move to it, do
 * all of a group, go through a group one by one, skip all of it, or answer Quest's offer to go alone on a platform.
 */
export const deckData = (action: "move" | "all" | "one" | "none" | "yes" | "no", key: string): string => `${action === "move" ? "mv" : action}:${key}`;

const DECK = /^(mv|all|one|none|yes|no):((?:find|draft|question|idea):[0-9a-f-]{36}|group:(?:like|follow|profile):[a-z0-9.-]{1,40}|trust:[a-z0-9.-]{1,40}(?: (?:posts|likes|follows))?)$/;
const DECK_ACTIONS = { mv: "move", all: "all", one: "one", none: "none", yes: "yes", no: "no" } as const;


const senderOf = (user: TgUser, chat: TgChat): Sender => ({
  channel: { kind: "telegram", address: String(chat.id) },
  userRef: String(user.id),
  displayName: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || null,
  language: user.language_code ?? null,
});

/**
 * Telegram's note that Quest pinned a message (its progress board), which Telegram posts in a private chat on every
 * pin. In a private chat with the bot, a message from a bot is the bot's own.
 */
export function ownPinNotice(update: TgUpdate): { readonly chat: string; readonly ref: number } | null {
  const msg = update.message;
  if (!msg?.pinned_message || !msg.from?.is_bot || msg.chat.type !== "private") return null;
  return { chat: String(msg.chat.id), ref: msg.message_id };
}

/**
 * Translates a Telegram update into what the rest of Quest understands, or null
 * for anything Quest does not handle (groups, edits, stickers, other bots).
 */
export function parseUpdate(update: TgUpdate): Inbound | null {
  const cq = update.callback_query;
  if (cq) {
    const chat = cq.message?.chat ?? { id: cq.from.id, type: "private" as const };
    if (chat.type !== "private") return null;
    const pressed = parseFindData(cq.data ?? "");
    if (pressed) return { type: "find", from: senderOf(cq.from, chat), findId: findId(pressed.findId), action: pressed.action, ackRef: cq.id };
    const drafted = parseDraftData(cq.data ?? "");
    if (drafted) return { type: "draft", from: senderOf(cq.from, chat), draftId: draftId(drafted.draftId), action: drafted.action, ackRef: cq.id };
    const language = LANGUAGE.exec(cq.data ?? "")?.[1];
    if (language) return { type: "language", from: senderOf(cq.from, chat), locale: language, ackRef: cq.id, messageRef: cq.message ? String(cq.message.message_id) : null };
    const idea = IDEA.exec(cq.data ?? "");
    if (idea?.[1] && idea[2]) return { type: "idea", from: senderOf(cq.from, chat), ideaId: idea[1], action: idea[2] as "yes" | "no", ackRef: cq.id };
    const deck = DECK.exec(cq.data ?? "");
    if (deck?.[1] && deck[2]) return { type: "deck", from: senderOf(cq.from, chat), action: DECK_ACTIONS[deck[1] as keyof typeof DECK_ACTIONS], key: deck[2], ackRef: cq.id };
    const power = POWER.exec(cq.data ?? "")?.[1];
    if (power) return { type: "power", from: senderOf(cq.from, chat), on: power === "on", ackRef: cq.id, messageRef: cq.message ? String(cq.message.message_id) : null };
    const m = CHOICE.exec(cq.data ?? "");
    if (!m || m[1] === undefined || m[2] === undefined) return null;
    return {
      type: "choice",
      from: senderOf(cq.from, chat),
      questionId: questionId(m[1]),
      option: Number(m[2]),
      ackRef: cq.id,
      messageRef: cq.message ? String(cq.message.message_id) : null,
    };
  }

  const msg = update.message;
  if (!msg?.from || msg.from.is_bot || msg.chat.type !== "private") return null;
  const text = (msg.text ?? msg.caption ?? "").trim();
  const from = senderOf(msg.from, msg.chat);
  const messageRef = String(msg.message_id);
  const replyToRef = msg.reply_to_message ? String(msg.reply_to_message.message_id) : null;
  // A recording, however it was sent: a voice message, a song-style audio file, or an audio file sent as a file.
  const recording = msg.voice ?? msg.audio ?? (msg.document?.mime_type?.startsWith("audio/") ? msg.document : undefined);
  if (recording) {
    return {
      type: "voice",
      from,
      fileRef: recording.file_id,
      mimeType: recording.mime_type ?? (msg.voice ? "audio/ogg" : null),
      fileName: msg.voice ? null : ((msg.audio ?? msg.document)?.file_name ?? null),
      seconds: (msg.voice ?? msg.audio)?.duration ?? null,
      size: recording.file_size ?? null,
      caption: text,
      messageRef,
      replyToRef,
    };
  }
  // A screenshot sent as a photo was dropped, its caption read alone ("This is him", live 2026-10-14).
  const photo = msg.photo?.at(-1);
  if (photo) {
    return { type: "file", from, fileRef: photo.file_id, fileName: "picture.jpg", mimeType: "image/jpeg", size: photo.file_size ?? null, caption: text, messageRef, replyToRef };
  }
  // A video they sent for their posts, kept with the pictures.
  if (msg.video) {
    return { type: "file", from, fileRef: msg.video.file_id, fileName: msg.video.file_name ?? "video.mp4", mimeType: msg.video.mime_type ?? "video/mp4", size: msg.video.file_size ?? null, caption: text, messageRef, replyToRef };
  }
  const doc = msg.document;
  if (doc) {
    return {
      type: "file",
      from,
      fileRef: doc.file_id,
      fileName: doc.file_name ?? "file",
      mimeType: doc.mime_type ?? null,
      size: doc.file_size ?? null,
      caption: text,
      messageRef,
      replyToRef,
    };
  }
  if (!text) return null;

  const command = /^\/([a-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
  if (command && command[1] !== undefined) {
    return { type: "command", from, command: command[1].toLowerCase(), args: (command[2] ?? "").trim(), messageRef };
  }
  return {
    type: "text",
    from,
    text,
    messageRef,
    replyToRef,
  };
}
