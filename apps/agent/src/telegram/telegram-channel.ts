import { forLanguage, customerLocale, systemMessage, textPrefix, LANGUAGES, LOCALES } from "@mq/i18n";
import { SKIPPED, type ChannelAddress, type ChatChannel, type DeckView, type Draft, type Find, type Idea, type OutgoingLink, type OutgoingQuestion } from "@mq/core";
import { TelegramError, type TelegramBotApi, type TgCallbackButton, type TgInlineButton, type TgReplyMarkup, type TgUpdate } from "./bot-api.ts";
import { deckButtons, deckHtml } from "./deck-card.ts";
import { draftButtons, draftCardHtml, draftData } from "./draft-card.ts";
import { findButtons, findCardHtml } from "./find-card.ts";
import { splitMessage, toPlainText, toTelegramHtml } from "./format.ts";
import { choiceData, ideaData, languageData, ownPinNotice, powerData } from "./updates.ts";



type T = ReturnType<typeof forLanguage>;

/** The longest part of what someone wrote that a take shows. */
const SAYS_CHARS = 160;

const questionText = (q: OutgoingQuestion, t: (s: string) => string): string =>
  q.options.length
    ? `${q.text}\n\n${t("Tap an answer, or reply to this message in your own words.")}`
    : `${q.text}\n\n${t("Reply to this message with your answer.")}`;

/** A card's words without its marks, for when Telegram will not take the HTML. */
const htmlToPlain = (html: string): string =>
  html
    .replace(/<a href="([^"]+)">([^<]*)<\/a>/g, "$2: $1")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const isParseError = (e: unknown): boolean =>
  e instanceof TelegramError && e.code === 400 && /parse entities|can't find end/i.test(e.message);

/** Quest's chat surface on Telegram. */
/** One of Quest's ideas for a post, as its card says it. */
const ideaText = (idea: Idea, t: (s: string, v?: Record<string, string | number>) => string): string =>
  `**${idea.platform ? t("Idea for a post on {place}", { place: idea.platform }) : t("Idea for a post")}**
${idea.text}${idea.assets.length ? `
${t("With your picture")}` : ""}`;

export class TelegramChannel implements ChatChannel {
  readonly kind = "telegram" as const;
  readonly #api: TelegramBotApi;

  readonly #language: (to: ChannelAddress) => Promise<string | null>;
  /** Chats with suggested answers up in place of the keyboard. */
  readonly #answering = new Set<string>();
  /** The customer's own page (a Mini App) the Quest button opens; null when there is no https address for it. */
  readonly #appUrl: string | null;
  /**
   * On a laptop the agent's pages are http://localhost, which Telegram takes on no button: a button to one of them
   * names the Mini App's https origin instead, whose gate sends the browser back to the same page here
   * (scripts/dev-tunnel.ts, LOCAL_PAGE). Null where the pages are https already, or there is no Mini App address.
   */
  readonly #localPages: { from: string; to: string } | null;
  constructor(api: TelegramBotApi, language: (to: ChannelAddress) => Promise<string | null> = async () => null, opts: { appUrl?: string | null; pagesUrl?: string | null } = {}) {
    this.#language = language;
    this.#api = api;
    this.#appUrl = opts.appUrl?.startsWith("https://") ? opts.appUrl : null;
    const pages = opts.pagesUrl?.replace(/\/+$/, "");
    this.#localPages = pages && !pages.startsWith("https://") && this.#appUrl ? { from: pages, to: new URL(this.#appUrl).origin } : null;
  }

  /** A link's address as a button can carry it. */
  #onButton(url: string): string {
    const p = this.#localPages;
    return p && (url === p.from || url.startsWith(`${p.from}/`)) ? p.to + url.slice(p.from.length) : url;
  }

  async sendText(to: ChannelAddress, text: string, answers: readonly string[] = []): Promise<string | null> {
    const parts = splitMessage(text);
    let last: string | null = null;
    for (const [i, part] of parts.entries()) last = await this.#send(to, part, undefined, i === parts.length - 1 ? answers : []);
    return last;
  }

  async editText(to: ChannelAddress, ref: string, text: string): Promise<boolean> {
    try {
      await this.#api.editMessageText({ chat_id: to.address, message_id: Number(ref), text: toTelegramHtml(text), parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      return true;
    } catch (e) {
      if (!(e instanceof TelegramError && e.code === 400)) throw e;
      // The same words again is no change; any other refusal is a message that cannot be edited any more.
      return /not modified/i.test(e.message);
    }
  }

  async sendQuestion(to: ChannelAddress, question: OutgoingQuestion): Promise<string | null> {
    const keyboard: TgInlineButton[][] = question.options.map((option, i) => [
      { text: textPrefix(option, 60), callback_data: choiceData(question.id, i) },
    ]);
    return this.#send(to, questionText(question, forLanguage(await this.#language(to))), keyboard);
  }

  async showAnswer(to: ChannelAddress, ref: string, question: OutgoingQuestion, answer: string): Promise<void> {
    const text = `${question.text}\n\n${answer}`;
    try {
      await this.#api.editMessageText({ chat_id: to.address, message_id: Number(ref), text: toTelegramHtml(text), parse_mode: "HTML" });
    } catch (e) {
      // "message is not modified" and edits of old messages are harmless to skip.
      if (!(e instanceof TelegramError && e.code === 400)) throw e;
    }
  }

  async acknowledge(ackRef: string, text?: string): Promise<void> {
    await this.#api.answerCallbackQuery({ callback_query_id: ackRef, ...(text ? { text: textPrefix(text, 200) } : {}) });
  }

  async showTyping(to: ChannelAddress): Promise<void> {
    await this.#api.sendChatAction({ chat_id: to.address, action: "typing" });
  }

  async react(to: ChannelAddress, ref: string, emoji: string): Promise<void> {
    await this.#api.setMessageReaction({ chat_id: to.address, message_id: Number(ref), reaction: [{ type: "emoji", emoji }] });
  }

  async sendFind(to: ChannelAddress, find: Find): Promise<string | null> {
    const locale = customerLocale(await this.#language(to));
    return this.#sendCard(to, findCardHtml(find, new Date(), locale), findButtons(find, locale));
  }

  async updateFind(to: ChannelAddress, ref: string, find: Find): Promise<void> {
    const locale = customerLocale(await this.#language(to));
    return this.#editCard(to, ref, findCardHtml(find, new Date(), locale), findButtons(find, locale));
  }

  async sendDraft(to: ChannelAddress, draft: Draft): Promise<string | null> {
    const locale = customerLocale(await this.#language(to));
    return this.#sendCard(to, draftCardHtml(draft, locale), draftButtons(draft, locale));
  }

  async updateDraft(to: ChannelAddress, ref: string, draft: Draft): Promise<void> {
    const locale = customerLocale(await this.#language(to));
    return this.#editCard(to, ref, draftCardHtml(draft, locale), draftButtons(draft, locale));
  }

  async askEdit(to: ChannelAddress, cardRef: string, text: string): Promise<string | null> {
    const t = forLanguage(await this.#language(to));
    const sent = await this.#api.sendMessage({
      chat_id: to.address,
      text: t(text),
      reply_parameters: { message_id: Number(cardRef), allow_sending_without_reply: true },
      reply_markup: { force_reply: true, input_field_placeholder: textPrefix(t("Your changes"), 64) },
    });
    return String(sent.message_id);
  }

  async closeCard(to: ChannelAddress, ref: string): Promise<void> {
    try {
      await this.#api.editMessageReplyMarkup({ chat_id: to.address, message_id: Number(ref), reply_markup: { inline_keyboard: [] } });
    } catch (e) {
      // Already without buttons, or too old to edit: nothing to take off.
      if (!(e instanceof TelegramError && e.code === 400)) throw e;
    }
  }

  /**
   * "Here's what I'm sending" (drafts/out-list.ts): one message, a button a line that strikes it (the draft's own Skip),
   * edited in place; a new one is sent silently, and never for an empty list.
   */
  async showOutList(to: ChannelAddress, ref: string | null, text: string, lines: readonly { readonly id: string }[]): Promise<string | null> {
    const html = toTelegramHtml(text);
    const row: TgInlineButton[] = lines.map((l, i) => ({ text: `✕ ${i + 1}`, callback_data: draftData(l.id, "skip") }));
    const keyboard = [row.slice(0, 4), row.slice(4, 8)].filter((r) => r.length);
    if (ref) {
      try {
        await this.#api.editMessageText({ chat_id: to.address, message_id: Number(ref), text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: keyboard } });
        return ref;
      } catch (e) {
        if (!(e instanceof TelegramError && e.code === 400)) throw e;
        if (/not modified/i.test(e.message)) return ref;
      }
    }
    if (!lines.length) return ref;
    return this.#sendCard(to, html, keyboard, true);
  }

  async showDeck(to: ChannelAddress, ref: string | null, view: DeckView, opts: { readonly silent?: boolean } = {}): Promise<string | null> {
    const language = await this.#language(to);
    const html = deckHtml(view, new Date(), language);
    const keyboard = deckButtons(view, language);
    if (!ref) return this.#sendCard(to, html, keyboard, opts.silent);
    try {
      await this.#api.editMessageText({ chat_id: to.address, message_id: Number(ref), text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: keyboard } });
      return ref;
    } catch (e) {
      if (!(e instanceof TelegramError && e.code === 400)) throw e;
      if (/not modified/i.test(e.message)) return ref;
      if (isParseError(e)) {
        await this.#api.editMessageText({ chat_id: to.address, message_id: Number(ref), text: htmlToPlain(html), reply_markup: { inline_keyboard: keyboard } });
        return ref;
      }
      // Gone (they deleted it), or too old to edit: a new deck is sent instead.
      return null;
    }
  }

  async removeMessage(to: ChannelAddress, ref: string): Promise<void> {
    const message = { chat_id: to.address, message_id: Number(ref) };
    try {
      await this.#api.deleteMessage(message);
    } catch (e) {
      if (!(e instanceof TelegramError && e.code === 400)) throw e;
      // Older than Telegram lets a bot delete (48 hours): its buttons come off instead, so nothing old can be tapped.
      await this.closeCard(to, ref);
    }
  }

  /** A card in Telegram's HTML, sent as plain text if Telegram can't parse it. */
  async #sendCard(to: ChannelAddress, html: string, keyboard: TgInlineButton[][], silent = false): Promise<string | null> {
    const markup = keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {};
    const quiet = silent ? { disable_notification: true } : {};
    try {
      const sent = await this.#api.sendMessage({ chat_id: to.address, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...markup, ...quiet });
      return String(sent.message_id);
    } catch (e) {
      if (!isParseError(e)) throw e;
      const sent = await this.#api.sendMessage({ chat_id: to.address, text: htmlToPlain(html), ...markup, ...quiet });
      return String(sent.message_id);
    }
  }

  async #editCard(to: ChannelAddress, ref: string, html: string, keyboard: TgCallbackButton[][]): Promise<void> {
    try {
      await this.#api.editMessageText({
        chat_id: to.address,
        message_id: Number(ref),
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (e) {
      // "message is not modified" and edits of old messages are harmless to skip.
      if (!(e instanceof TelegramError && e.code === 400)) throw e;
    }
  }

  async sendLinks(to: ChannelAddress, text: string, links: readonly OutgoingLink[]): Promise<string | null> {
    const keyboard: TgInlineButton[][] = links.map((l) => [l.app && l.url.startsWith("https://") ? { text: textPrefix(l.label, 60), web_app: { url: l.url } } : { text: textPrefix(l.label, 60), url: this.#onButton(l.url) }]);
    try {
      return await this.#send(to, text, keyboard);
    } catch (e) {
      // Telegram takes only public addresses on buttons: a laptop's localhost goes in the text instead.
      if (!(e instanceof TelegramError && e.code === 400 && /BUTTON_URL_INVALID|url/i.test(e.message))) throw e;
      return this.#send(to, [text, "", ...links.map((l) => `${l.label}: ${l.url}`)].join("\n"));
    }
  }

  async sendIdea(to: ChannelAddress, idea: Idea): Promise<string | null> {
    const t = forLanguage(await this.#language(to));
    return this.#send(to, ideaText(idea, t), [[{ text: t("Write it"), callback_data: ideaData(idea.id, "yes") }, { text: t("Not this one"), callback_data: ideaData(idea.id, "no") }]]);
  }

  async showIdeaDecided(to: ChannelAddress, ref: string, idea: Idea): Promise<void> {
    const t = forLanguage(await this.#language(to));
    try {
      await this.#api.editMessageText({ chat_id: to.address, message_id: Number(ref), text: toTelegramHtml(`${ideaText(idea, t)}

${idea.status === "no" ? `${t("Not this one")}` : `${t("Writing it")}`}`), parse_mode: "HTML" });
    } catch (e) {
      if (!(e instanceof TelegramError && e.code === 400)) throw e;
    }
  }

  async sendSwitch(to: ChannelAddress, text: string, on: boolean): Promise<string | null> {
    const t = forLanguage(await this.#language(to));
    const ref = await this.#send(to, text, [[{ text: t(on ? "Switch Quest on" : "Switch Quest off"), callback_data: powerData(on) }]]);
    if (ref) this.#switches.set(to.address, ref);
    return ref;
  }

  /** The chat's last switch message, kept in memory: after a restart an old one is redrawn when it is pressed. */
  readonly #switches = new Map<string, string>();

  async redrawSwitch(to: ChannelAddress, given: readonly string[], text: string, on: boolean): Promise<void> {
    const refs = new Set([...given, this.#switches.get(to.address)].filter((r): r is string => Boolean(r)));
    // A switch they pinned to keep at hand (live, 2026-11-20: the pinned one still said "Browsing is off" while on).
    const pinned = await this.#api.pinnedMessage(to.address).catch(() => null);
    if (pinned?.reply_markup?.inline_keyboard?.some((row) => row.some((b) => "callback_data" in b && /^power:/.test(b.callback_data)))) refs.add(String(pinned.message_id));
    const t = forLanguage(await this.#language(to));
    const markup = { inline_keyboard: [[{ text: t(on ? "Switch Quest on" : "Switch Quest off"), callback_data: powerData(on) }]] };
    const params = { chat_id: to.address, message_id: 0, parse_mode: "HTML", reply_markup: markup };
    for (const at of refs) {
      const id = Number(at);
      // Its words, or its caption (the switch pinned on 2026-11-12 is a message with no text), else its button alone.
      // The same words and button again, or a message gone: nothing to redraw.
      const tries: (() => Promise<unknown>)[] = [
        () => this.#api.call("editMessageText", { ...params, message_id: id, text: toTelegramHtml(text) }),
        () => this.#api.call("editMessageCaption", { ...params, message_id: id, caption: toTelegramHtml(text) }),
        () => this.#api.call("editMessageReplyMarkup", { chat_id: to.address, message_id: id, reply_markup: markup }),
      ];
      for (const attempt of tries) {
        try {
          await attempt();
          break;
        } catch (e) {
          if (!(e instanceof TelegramError && e.code === 400)) throw e;
          if (/not modified|not found/i.test(e.message)) break;
        }
      }
    }
  }

  /**
   * The first thing someone new sees (the founder, 2026-10-24: "The language should be the first question, with option to
   * keep auto/default"): their Telegram's language first, as the one to keep, then the others, each in its own name.
   */
  async sendLanguageChoice(to: ChannelAddress, detected: string): Promise<string | null> {
    const t = forLanguage(detected);
    const first = customerLocale(detected);
    const rest = LOCALES.filter((l) => l !== first);
    // English right after the one they have, since it is the one most people look for when theirs is not.
    const others = first === "en" ? rest : ["en", ...rest.filter((l) => l !== "en")];
    const row = (locales: readonly string[]): TgInlineButton[] => locales.map((l) => ({ text: LANGUAGES[l]!, callback_data: languageData(l === first ? "auto" : l) }));
    const keyboard: TgInlineButton[][] = [row([first]), ...Array.from({ length: Math.ceil(others.length / 3) }, (_, i) => row(others.slice(i * 3, i * 3 + 3)))];
    return this.#send(to, t("Which language?"), keyboard);
  }

  async showLanguageChosen(to: ChannelAddress, ref: string, locale: string): Promise<void> {
    try {
      await this.#api.editMessageText({ chat_id: to.address, message_id: Number(ref), text: LANGUAGES[locale] ?? locale });
    } catch (e) {
      // "message is not modified" and edits of old messages are harmless to skip.
      if (!(e instanceof TelegramError && e.code === 400)) throw e;
    }
  }

  download(fileRef: string): Promise<Uint8Array> {
    return this.#api.download(fileRef);
  }

  async sendPhoto(to: ChannelAddress, jpeg: Uint8Array, caption: string | null): Promise<string> {
    const sent = await this.#api.sendPhoto({ chat_id: to.address, photo: jpeg, ...(caption ? { caption } : {}), disable_notification: true });
    return String(sent.message_id);
  }

  /**
   * The chat's own Quest button: its words while work runs, back to the one every chat has after. No message, no
   * pin, nothing to scroll past: the page it opens shows the work. Telegram takes only an https page there, so an
   * agent on a laptop has none (`appUrl` unset) and says so.
   */
  async showWork(to: ChannelAddress, label: string | null): Promise<boolean> {
    if (!this.#appUrl) return false;
    const menu_button = label ? { type: "web_app" as const, text: textPrefix(label, 64), web_app: { url: this.#appUrl } } : { type: "default" as const };
    try {
      await this.#api.setChatMenuButton({ chat_id: to.address, menu_button });
      return true;
    } catch (e) {
      // A chat that is gone (they blocked Quest) has no button to show.
      if (e instanceof TelegramError && (e.code === 400 || e.code === 403)) return false;
      throw e;
    }
  }

  /**
   * Their chat's Quest button opens `appUrl` from now on. A new address on the bot's own button reaches no chat that has
   * it already: Telegram keeps the one it had (live, 2026-11-03: Telegram Web opened a dev tunnel three starts old). A
   * change of the chat's own button reaches it at once, and the chat keeps that address once its button is the bot's again.
   */
  async pushButton(to: ChannelAddress): Promise<void> {
    if (!this.#appUrl) return;
    await this.#api.setChatMenuButton({ chat_id: to.address, menu_button: { type: "web_app", text: "Quest", web_app: { url: this.#appUrl } } });
    await this.#api.setChatMenuButton({ chat_id: to.address, menu_button: { type: "default" } });
  }

  /** A progress board from before the Quest button showed the work (they pinned at the top of the chat). */
  async removeBoard(to: ChannelAddress, ref: string): Promise<void> {
    const message = { chat_id: to.address, message_id: Number(ref) };
    // Either may find the message gone already (they deleted or unpinned it): nothing left to do then.
    await this.#api.unpinChatMessage(message).catch((e: unknown) => {
      if (!(e instanceof TelegramError && e.code === 400)) throw e;
    });
    await this.#api.deleteMessage(message).catch((e: unknown) => {
      if (!(e instanceof TelegramError && e.code === 400)) throw e;
    });
  }

  /** Deletes Telegram's "Quest pinned …" note when the update is one: it would sit in the chat, and count as unread. */
  async dropPinNotice(update: TgUpdate): Promise<boolean> {
    const notice = ownPinNotice(update);
    if (!notice) return false;
    await this.#api.deleteMessage({ chat_id: notice.chat, message_id: notice.ref }).catch((e: unknown) => {
      if (!(e instanceof TelegramError && e.code === 400)) throw e;
    });
    return true;
  }

  /**
   * `answers`: the likely answers to what the message asks, in place of their keyboard; a tap sends one as their
   * own message, and they can still type. A plain message after those takes them away, so an old question's
   * answers never sit under a new one (a message with buttons of its own cannot, so they wait for the next).
   */
  async #send(to: ChannelAddress, text: string, keyboard?: TgInlineButton[][], answers: readonly string[] = []): Promise<string> {
    const shown = answers.map((a) => textPrefix(a.trim(), 60)).filter(Boolean);
    const markup: { reply_markup?: TgReplyMarkup } = keyboard?.length
      ? { reply_markup: { inline_keyboard: keyboard } }
      : shown.length
        ? { reply_markup: { keyboard: shown.map((a) => [{ text: a }]), one_time_keyboard: true, resize_keyboard: true } }
        : this.#answering.has(to.address)
          ? { reply_markup: { remove_keyboard: true } }
          : {};
    if (shown.length && !keyboard?.length) this.#answering.add(to.address);
    else if (!keyboard?.length) this.#answering.delete(to.address);
    try {
      const sent = await this.#api.sendMessage({
        chat_id: to.address,
        text: toTelegramHtml(text),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...markup,
      });
      return String(sent.message_id);
    } catch (e) {
      if (!isParseError(e)) throw e;
      const sent = await this.#api.sendMessage({ chat_id: to.address, text: toPlainText(text), ...markup });
      return String(sent.message_id);
    }
  }
}
