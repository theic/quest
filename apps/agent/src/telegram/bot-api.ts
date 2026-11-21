/** The slice of the Telegram Bot API Quest uses. Nothing here knows about customers or agents. */

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  document?: TgDocument;
  /** A picture sent as a photo: the same picture in several sizes, the largest last. */
  photo?: TgPhotoSize[];
  voice?: TgVoice;
  audio?: TgAudio;
  /** A video sent as a video (not as a file). */
  video?: TgDocument & { duration?: number };
  /** A short video without sound, as Telegram may file one. */
  animation?: TgDocument;
  reply_to_message?: TgMessage;
  /** On the chat's note that a message was pinned: that message. */
  pinned_message?: TgMessage;
}

export interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** A voice message: OGG with Opus inside, as recorded in the app. */
export interface TgVoice {
  file_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

/** An audio file sent as music (an .mp3, an .m4a), which Telegram plays in its own player. */
export interface TgAudio {
  file_id: string;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

/** The updates Quest takes, for the webhook (scripts/telegram-webhook.ts) and polling alike. */
export const UPDATES = ["message", "callback_query"];

export interface TgCallbackButton {
  text: string;
  callback_data: string;
}

/** A button that opens a page in the browser (`url`), or one of Quest's own pages inside Telegram (`web_app`). */
export type TgInlineButton = TgCallbackButton | { text: string; url: string } | { text: string; web_app: { url: string } };

/**
 * What goes under a message: buttons on the message itself, answers in place of the keyboard (a tap sends the
 * answer's words as their message), or the order to put the keyboard back.
 */
export type TgReplyMarkup =
  | { inline_keyboard: TgInlineButton[][] }
  | { keyboard: { text: string }[][]; one_time_keyboard: true; resize_keyboard: true; input_field_placeholder?: string }
  | { remove_keyboard: true }
  /** Opens their reply box on this message, as if they had tapped Reply on it. */
  | { force_reply: true; input_field_placeholder?: string };

export class TelegramError extends Error {
  readonly method: string;
  readonly code: number;
  readonly retryAfter: number | null;
  constructor(method: string, code: number, description: string, retryAfter: number | null) {
    super(`Telegram ${method} failed (${code}): ${description}`);
    this.name = "TelegramError";
    this.method = method;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export class TelegramBotApi {
  readonly #base: string;
  readonly #files: string;
  readonly #fetch: typeof fetch;

  constructor(token: string, fetchImpl: typeof fetch = fetch) {
    this.#base = `https://api.telegram.org/bot${token}`;
    this.#files = `https://api.telegram.org/file/bot${token}`;
    this.#fetch = fetchImpl;
  }

  /** Calls a Bot API method; waits out one "too many requests" before giving up. */
  call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000, signal?: AbortSignal): Promise<T> {
    return this.#post<T>(method, { headers: { "content-type": "application/json" }, body: JSON.stringify(params) }, timeoutMs, signal);
  }

  async #post<T>(method: string, request: { headers?: Record<string, string>; body: BodyInit }, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.#fetch(`${this.#base}/${method}`, {
        method: "POST",
        ...request,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      const body = (await res.json()) as TgResponse<T>;
      if (body.ok) return body.result as T;
      const retryAfter = body.parameters?.retry_after ?? null;
      if (body.error_code === 429 && retryAfter !== null && attempt === 0 && retryAfter <= 10) {
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      throw new TelegramError(method, body.error_code ?? res.status, body.description ?? "unknown error", retryAfter);
    }
  }

  sendMessage(params: {
    chat_id: string;
    text: string;
    parse_mode?: "HTML";
    reply_markup?: TgReplyMarkup;
    link_preview_options?: { is_disabled: boolean };
    disable_notification?: boolean;
    reply_parameters?: { message_id: number; allow_sending_without_reply?: boolean };
  }): Promise<TgMessage> {
    return this.call<TgMessage>("sendMessage", params);
  }

  /** Changes or removes the buttons under a message the bot sent. */
  editMessageReplyMarkup(params: { chat_id: string; message_id: number; reply_markup?: { inline_keyboard: TgInlineButton[][] } }): Promise<TgMessage | true> {
    return this.call<TgMessage | true>("editMessageReplyMarkup", params);
  }

  /** Pins a message at the top of the chat. In a private chat Telegram also posts a note that it was pinned. */
  /** The chat's pinned message, with its buttons. */
  async pinnedMessage(chatId: string): Promise<(TgMessage & { reply_markup?: { inline_keyboard?: TgInlineButton[][] } }) | null> {
    const chat = await this.call<{ pinned_message?: TgMessage & { reply_markup?: { inline_keyboard?: TgInlineButton[][] } } }>("getChat", { chat_id: chatId });
    return chat.pinned_message ?? null;
  }

  pinChatMessage(params: { chat_id: string; message_id: number; disable_notification?: boolean }): Promise<true> {
    return this.call<true>("pinChatMessage", params);
  }

  unpinChatMessage(params: { chat_id: string; message_id: number }): Promise<true> {
    return this.call<true>("unpinChatMessage", params);
  }

  /** In a private chat a bot may delete its own messages, and Telegram's notes about them. */
  deleteMessage(params: { chat_id: string; message_id: number }): Promise<true> {
    return this.call<true>("deleteMessage", params);
  }

  editMessageText(params: {
    chat_id: string;
    message_id: number;
    text: string;
    parse_mode?: "HTML";
    reply_markup?: { inline_keyboard: TgInlineButton[][] };
    link_preview_options?: { is_disabled: boolean };
  }): Promise<TgMessage | true> {
    return this.call<TgMessage | true>("editMessageText", params);
  }

  /** The words on a media message (a widget's too). Buttons left out are taken off, as with any edit. */
  editMessageCaption(params: { chat_id: string; message_id: number; caption: string; show_caption_above_media?: boolean; reply_markup?: { inline_keyboard: TgInlineButton[][] } }): Promise<TgMessage | true> {
    return this.call<TgMessage | true>("editMessageCaption", params);
  }

  /** A JPEG as a message. Files go as a multipart form; there is no JSON way to send bytes. */
  sendPhoto(params: { chat_id: string; photo: Uint8Array; caption?: string; disable_notification?: boolean }): Promise<TgMessage> {
    const form = new FormData();
    form.set("chat_id", params.chat_id);
    if (params.caption) form.set("caption", params.caption);
    if (params.disable_notification) form.set("disable_notification", "true");
    form.set("photo", new Blob([params.photo as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }), "screen.jpg");
    return this.#post<TgMessage>("sendPhoto", { body: form }, 30_000);
  }

  answerCallbackQuery(params: { callback_query_id: string; text?: string }): Promise<true> {
    return this.call<true>("answerCallbackQuery", params);
  }

  /** One emoji on a message, replacing the bot's earlier one (a bot sets one at most); an empty list takes it off. */
  setMessageReaction(params: { chat_id: string; message_id: number; reaction: { type: "emoji"; emoji: string }[] }): Promise<true> {
    return this.call<true>("setMessageReaction", params);
  }

  sendChatAction(params: { chat_id: string; action: "typing" }): Promise<true> {
    return this.call<true>("sendChatAction", params);
  }

  setWebhook(params: { url: string; secret_token: string; allowed_updates: string[]; drop_pending_updates?: boolean }): Promise<true> {
    return this.call<true>("setWebhook", params);
  }

  /** Long polling, for running the agent on a laptop: Telegram holds the request until an update comes or `timeout` seconds pass. */
  getUpdates(params: { offset?: number; timeout: number; allowed_updates: string[] }, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>("getUpdates", params, (params.timeout + 10) * 1000, signal);
  }

  deleteWebhook(params: { drop_pending_updates?: boolean } = {}): Promise<true> {
    return this.call<true>("deleteWebhook", params);
  }

  /** The bot this token belongs to: at start, so production and dev never run each other's (environments.ts). */
  getMe(): Promise<{ id: number; username: string }> {
    return this.call<{ id: number; username: string }>("getMe", {});
  }

  /** A file a person sent: Telegram hands bots files up to 20 MB. */
  async download(fileId: string): Promise<Uint8Array> {
    const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new TelegramError("getFile", 400, "no file path", null);
    const res = await this.#fetch(`${this.#files}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new TelegramError("getFile", res.status, "download failed", null);
    return new Uint8Array(await res.arrayBuffer());
  }

  setMyCommands(params: { commands: { command: string; description: string }[] }): Promise<true> {
    return this.call<true>("setMyCommands", params);
  }

  /** The button by every private chat's message box: here, the customer's own page as a Mini App. */
  /** Without `chat_id`, every chat's button; with it, one private chat's (the default type hands it back to every chat's). */
  setChatMenuButton(params: { chat_id?: string; menu_button: { type: "web_app"; text: string; web_app: { url: string } } | { type: "default" } }): Promise<true> {
    return this.call<true>("setChatMenuButton", params);
  }
}
