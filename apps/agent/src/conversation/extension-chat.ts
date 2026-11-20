import { randomUUID } from "node:crypto";
import type { Ask, ChannelAddress, Clock, CustomerId, CustomerRepository, Inbound, Logger, Sender, Transcript } from "@mq/core";
import type { TgInlineButton } from "../telegram/bot-api.ts";
import { type AskParts, askParts } from "../telegram/deck-card.ts";
import { draftData } from "../telegram/draft-card.ts";
import { parseUpdate } from "../telegram/updates.ts";
import { systemMessage } from "@mq/i18n";
import { CARD_MARK, DONE_MARK, QUESTION_MARK } from "./messenger.ts";
import type { ChatNews, WebButton, WebChannel } from "./web-channel.ts";

/** Messages the popup shows: the last stretch of the conversation. */
const SHOWN = 30;

/** One message in the popup. */
export interface ChatLine {
  readonly ref: string | null;
  readonly from: "you" | "quest";
  readonly text: string;
  readonly at: string;
  /** A note rather than words (a card that went to Your move, a done notice): drawn small. */
  readonly note: boolean;
  readonly reaction: string | null;
  readonly buttons: readonly WebButton[];
}

/** What the popup draws: the switch, Your move, the chat, and what it waits on. */
export interface ChatView {
  readonly mark: number;
  readonly on: boolean;
  readonly language: string | null;
  /** What waits on them, a plain list in rank (the founder's plan, 2026-11-19: the stack of cards was a game for one card). */
  readonly asks: readonly (AskParts & { readonly key: string })[];
  readonly messages: readonly ChatLine[];
  readonly line: string | null;
  /** "Here's what I'm sending": what goes up by itself next, each with the data that strikes it (drafts/out-list.ts). */
  readonly out: { readonly lines: readonly { readonly label: string; readonly words: string; readonly strike: string }[]; readonly more: number };
  readonly replyTo: { readonly ref: string; readonly text: string } | null;
  readonly typing: boolean;
}

const button = (b: TgInlineButton): WebButton =>
  "callback_data" in b ? { label: b.text, data: b.callback_data } : "url" in b ? { label: b.text, url: b.url } : { label: b.text, url: b.web_app.url };

/** A links message's button as the transcript keeps it: "[Label](address)", or "[Label]" from before the address was kept. */
const LINK_LINE = /^\[([^\]\n]{1,60})\](?:\((https?:\/\/\S+)\))?$/;

export interface ExtensionChatDeps {
  readonly customers: CustomerRepository;
  readonly transcript: Transcript;
  readonly channel: WebChannel;
  readonly news: ChatNews;
  readonly inbound: { handle(inbound: Inbound): Promise<void> };
  readonly deck: { list(customerId: CustomerId): Promise<readonly Ask[]> } | null;
  readonly off: (customerId: CustomerId) => boolean;
  readonly pairNew: (customerId: CustomerId, device: string | null) => Promise<{ readonly token: string } | null>;
  /** What their code says of where Quest met them: then Quest picks up from there instead of asking the first question. */
  readonly metBefore?: (customerId: CustomerId) => Promise<string | null>;
  /** What Quest sends by itself next (drafts/out-list.ts). */
  readonly out?: (customerId: CustomerId) => Promise<{ readonly lines: readonly { readonly id: string; readonly label: string; readonly words: string }[]; readonly more: number }>;
  readonly clock: Clock;
  readonly log: Logger;
}

/**
 * Their conversation with Quest in the extension's popup, Telegram or not (web-channel.ts): read it, write in it, press
 * what it shows, and someone new starts here with no Telegram at all. Writing here makes the popup where Quest answers
 * (the channel they last wrote from), as Telegram is after a message there.
 */
export class ExtensionChat {
  readonly #d: ExtensionChatDeps;

  constructor(deps: ExtensionChatDeps) {
    this.#d = deps;
  }

  mark(customerId: CustomerId): number {
    return this.#d.news.mark(customerId);
  }

  /** Their chat in the popup, bound to them the first time it is asked for. */
  async #address(customerId: CustomerId): Promise<ChannelAddress> {
    const had = await this.#d.customers.channelOf(customerId, "web");
    if (had) return had;
    const address: ChannelAddress = { kind: "web", address: customerId };
    await this.#d.customers.bindChannel(customerId, address, `web:${customerId}`);
    return address;
  }

  async #sender(customerId: CustomerId, language: string | null = null): Promise<Sender> {
    const customer = await this.#d.customers.get(customerId);
    return { channel: await this.#address(customerId), userRef: `web:${customerId}`, displayName: customer.displayName, language };
  }

  /** The chat as it stands; with `after`, it waits up to `waitMs` for something newer first (the popup's long poll). */
  async view(customerId: CustomerId, after: number | null, waitMs: number, signal?: AbortSignal): Promise<ChatView> {
    const mark = after === null ? this.mark(customerId) : await this.#d.news.after(customerId, after, waitMs, signal);
    const [customer, address, entries, asks] = await Promise.all([
      this.#d.customers.get(customerId),
      this.#address(customerId),
      this.#d.transcript.recent(customerId, SHOWN),
      this.#d.deck ? this.#d.deck.list(customerId).catch(() => []) : Promise.resolve([] as readonly Ask[]),
    ]);
    const out = (await this.#d.out?.(customerId).catch(() => null)) ?? { lines: [], more: 0 };
    const state = this.#d.channel.state(address.address);
    const now = this.#d.clock.now();
    // How the chat began ("/start") is no words of theirs.
    // A card's note ("🔎 Draft, your message to ...") says again what the card in front shows.
    const messages = entries.filter((e) => !(e.direction === "in" && /^\/start\b/.test(e.text)) && !(e.direction === "out" && e.text.startsWith(CARD_MARK))).map((e): ChatLine => {
      const lines = e.text.split("\n");
      // A links message is kept as its words and "[Label](address)" lines: here they are its buttons, also after a
      // restart, when the buttons kept in memory are gone (live, 2026-11-20: "Tonight's report [Open the report]" had no link).
      const kept = (e.ref && state.buttons.get(e.ref)) || [];
      const fromLines = lines.flatMap((l): WebButton[] => {
        const m = LINK_LINE.exec(l.trim());
        return m?.[2] ? [{ label: m[1]!, url: m[2] }] : [];
      });
      const buttons = kept.length ? kept : fromLines;
      const text = (buttons.some((b) => "url" in b) ? lines.filter((l) => !LINK_LINE.test(l.trim())) : lines).join("\n").trim();
      const note = e.direction === "out" && (text.startsWith(CARD_MARK) || text.startsWith(DONE_MARK));
      return {
        ref: e.ref ?? null,
        from: e.direction === "in" ? "you" : "quest",
        text: text.startsWith(QUESTION_MARK) ? text.slice(QUESTION_MARK.length) : text,
        at: e.at.toISOString(),
        note,
        reaction: e.reaction ?? null,
        buttons,
      };
    });
    return {
      mark,
      on: !this.#d.off(customerId),
      language: customer.language,
      asks: asks.slice(0, 30).map((a) => ({ ...askParts(a, now, customer.language), key: a.key })),
      messages,
      line: state.line,
      out: { lines: out.lines.map((l) => ({ label: l.label, words: l.words, strike: draftData(l.id, "skip") })), more: out.more },
      replyTo: state.replyTo,
      typing: state.typing,
    };
  }

  /** Their words, typed in the popup: the same as a message in Telegram. */
  async say(customerId: CustomerId, text: string, replyTo: string | null): Promise<void> {
    const from = await this.#sender(customerId);
    this.#d.channel.answered(from.channel.address);
    await this.#d.inbound.handle({ type: "text", from, text, messageRef: `w:${randomUUID()}`, replyToRef: replyTo });
  }

  /**
   * A voice message recorded in the popup (the founder, 2026-11-16: "run through the cards quickly, then add some comments
   * or a voice message"): heard as Telegram's are, and the words are a message, or a note on the card when `replyTo` is
   * the deck's.
   */
  async voice(customerId: CustomerId, audio: Uint8Array, mimeType: string, seconds: number | null, replyTo: string | null): Promise<void> {
    const from = await this.#sender(customerId);
    this.#d.channel.answered(from.channel.address);
    const fileRef = this.#d.channel.keep(audio);
    await this.#d.inbound.handle({ type: "voice", from, fileRef, mimeType, fileName: null, seconds, size: audio.byteLength, caption: "", messageRef: `w:${randomUUID()}`, replyToRef: replyTo });
  }

  /**
   * A button they pressed in the popup: the data a Telegram button carries (a card's, the deck's, a question's), read
   * the way Telegram's are. What it was answered with comes back ("Skipped").
   */
  async press(customerId: CustomerId, data: string): Promise<string | null> {
    const ackRef = `w:${randomUUID()}`;
    const read = parseUpdate({ update_id: 0, callback_query: { id: ackRef, from: { id: 0, is_bot: false, first_name: "web" }, message: { message_id: 0, chat: { id: 0, type: "private" }, date: 0 }, data } });
    if (!read) return null;
    const from = await this.#sender(customerId);
    // The press answers no message of the popup's own: a language choice or a question stays as the chat drew it.
    const inbound = { ...read, from, ...("messageRef" in read ? { messageRef: null } : {}) } as Inbound;
    await this.#d.inbound.handle(inbound);
    return this.#d.channel.takeAck(ackRef);
  }

  /**
   * Someone new, in the popup of the extension they just put in (the founder, 2026-11-15: "The onboarding starts even
   * before you get the link or installed the extension"): a customer whose chat is the popup, let in as anyone is (an
   * invite's code, else a free first run), asked the one question in their browser's language, and this Chrome
   * connected to them at once. The extension's token comes back.
   */
  async hello(input: { readonly device: string | null; readonly language: string | null; readonly invite: string | null; readonly timeZone?: string | null }): Promise<{ readonly token: string; readonly customerId: CustomerId } | null> {
    const address: ChannelAddress = { kind: "web", address: randomUUID() };
    const userRef = `web:${address.address}`;
    const from: Sender = { channel: address, userRef, displayName: null, language: input.language };
    await this.#d.inbound.handle({ type: "command", from, command: "start", args: input.invite ?? "", messageRef: `w:${randomUUID()}` });
    const customer = await this.#d.customers.findByChannel(address);
    if (!customer) return null;
    // Their browser knows their time zone, so the evening report comes at their evening with nothing asked.
    if (input.timeZone && validZone(input.timeZone) && !customer.timezone) await this.#d.customers.update(customer.id, { timezone: input.timeZone });
    // The language choice is answered by their browser: the one question follows in it, unless Quest met them already
    // (a thread, a message), and its first turn picks up from there.
    if (!(await this.#d.metBefore?.(customer.id).catch(() => null))) {
      await this.#d.inbound.handle({ type: "language", from, locale: "auto", ackRef: `w:${randomUUID()}`, messageRef: null });
    }
    const paired = await this.#d.pairNew(customer.id, input.device);
    if (!paired) return null;
    this.#d.log.info("chat.hello", { customerId: customer.id, invite: Boolean(input.invite) });
    return { token: paired.token, customerId: customer.id };
  }
}

/** A time zone Node knows ("Europe/Lisbon"). */
function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
