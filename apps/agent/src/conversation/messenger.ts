import { systemMessage, forLanguage } from "@mq/i18n";
import { draftLabel, sourceLabel, type ChannelAddress, type CustomerId, type CustomerRepository, type Draft, type Find, type Idea, type Logger, type OutgoingLink, type OutgoingQuestion, type Transcript } from "@mq/core";
import { capitalized, unstyled } from "../lib/voice.ts";
import type { ChannelRegistry } from "./channel-registry.ts";

/** How a card and a question are marked in the transcript: everything else sent is something Quest said. */
export const CARD_MARK = "🔎 ";
export const QUESTION_MARK = "❓ ";
/** Under a card, after Edit. */
export const EDIT_ASK = "What should change? Type it or say it in a voice message.";
/**
 * A notice of something they just did (✅ Chrome connected): them acting, not Quest talking, so the chat counts it
 * as their turn. Live, 2026-10-13: counted as Quest's third unanswered message, it held back the line that said
 * what Quest was starting, and they sat five minutes in silence until they asked "So?".
 */
export const DONE_MARK = "✅ ";

/** What Quest says as it goes out: commas for dashes, a capital at the start of each sentence. */
const plain = (s: string): string => capitalized(unstyled(s));
const plainQuestion = (q: OutgoingQuestion): OutgoingQuestion => ({ ...q, text: plain(q.text), options: q.options.map(plain) });

/**
 * Speaks to a customer wherever they are: finds their chat, sends, and keeps
 * the transcript. Nothing above this knows which channel a customer uses.
 */
export class Messenger {
  readonly #customers: CustomerRepository;
  readonly #channels: ChannelRegistry;
  readonly #transcript: Transcript;
  readonly #log: Logger;

  constructor(deps: { customers: CustomerRepository; channels: ChannelRegistry; transcript: Transcript; log: Logger }) {
    this.#customers = deps.customers;
    this.#channels = deps.channels;
    this.#transcript = deps.transcript;
    this.#log = deps.log;
  }

  /**
   * `answers`: the likely answers to what it asks, one tap each, already in their language.
   */
  async say(customerId: CustomerId, said: string, answers: readonly string[] = []): Promise<void> {
    // The mark is for the transcript, where it says this is something they did; what they read has no emoji in front.
    const done = said.startsWith(DONE_MARK);
    const text = plain(systemMessage((await this.#customers.get(customerId)).language, done ? said.slice(DONE_MARK.length) : said));
    const to = await this.#customers.primaryChannel(customerId);
    if (!to) {
      this.#log.warn("messenger.no_channel", { customerId });
      return;
    }
    const ref = await this.#channels.get(to.kind).sendText(to, text, answers.map(plain));
    await this.#transcript.recordOutgoing(customerId, to.kind, ref, done ? `${DONE_MARK}${text}` : text);
  }

  /**
   * A line kept up to date in place while work goes (the first sweep's): its ref. Not in the transcript until its last
   * words (`line` with `settled`), so the chat counts it once, as what it came to.
   */
  async startLine(customerId: CustomerId, said: string): Promise<string | null> {
    const text = plain(systemMessage((await this.#customers.get(customerId)).language, said));
    const to = await this.#customers.primaryChannel(customerId);
    if (!to) {
      this.#log.warn("messenger.no_channel", { customerId });
      return null;
    }
    return this.#channels.get(to.kind).sendText(to, text);
  }

  /** New words on that line; a line that is gone comes back as a new message. Returns the line's ref now. */
  async line(customerId: CustomerId, ref: string | null, said: string, settled = false): Promise<string | null> {
    const text = plain(systemMessage((await this.#customers.get(customerId)).language, said));
    const to = await this.#customers.primaryChannel(customerId);
    if (!to) return ref;
    const channel = this.#channels.get(to.kind);
    let now = ref;
    try {
      if (!ref || !(await channel.editText(to, ref, text))) now = await channel.sendText(to, text);
    } catch (e) {
      // A line that could not be redrawn this time is redrawn the next; only its last words must arrive.
      this.#log.warn("messenger.line_failed", { customerId, error: e instanceof Error ? e.message : String(e) });
      if (!settled) return ref;
      now = await channel.sendText(to, text);
    }
    if (settled) await this.#transcript.recordOutgoing(customerId, to.kind, now, text);
    return now;
  }

  /** One of Quest's ideas for a post, as a card with Write it and Not this one; the card's ref. */
  async showIdea(customerId: CustomerId, idea: Idea): Promise<string | null> {
    const to = await this.#customers.primaryChannel(customerId);
    if (!to) return null;
    const ref = await this.#channels.get(to.kind).sendIdea(to, idea);
    await this.#transcript.recordOutgoing(customerId, to.kind, ref, `${CARD_MARK}Idea for a post: ${idea.text}`);
    return ref;
  }

  /** The idea's card once they answered: what they chose, no buttons. */
  async closeIdea(customerId: CustomerId, ref: string, idea: Idea): Promise<void> {
    const to = await this.#customers.primaryChannel(customerId);
    if (to) await this.#channels.get(to.kind).showIdeaDecided(to, ref, idea);
  }

  /** A message with the button that switches Quest on (`on`) or off. */
  async sendSwitch(customerId: CustomerId, said: string, on: boolean): Promise<void> {
    const to = await this.#customers.primaryChannel(customerId);
    if (!to) {
      this.#log.warn("messenger.no_channel", { customerId });
      return;
    }
    const text = plain(systemMessage((await this.#customers.get(customerId)).language, said));
    const ref = await this.#channels.get(to.kind).sendSwitch(to, text, on);
    await this.#transcript.recordOutgoing(customerId, to.kind, ref, text);
  }

  /** A message with buttons that open web pages. */
  async sendLinks(customerId: CustomerId, text: string, links: readonly OutgoingLink[]): Promise<void> {
    const to = await this.#customers.primaryChannel(customerId);
    if (!to) {
      this.#log.warn("messenger.no_channel", { customerId });
      return;
    }
    const language = (await this.#customers.get(customerId)).language;
    text = systemMessage(language, text);
    links = links.map((link) => ({ ...link, label: forLanguage(language)(link.label) }));
    const ref = await this.#channels.get(to.kind).sendLinks(to, text, links);
    await this.#transcript.recordOutgoing(customerId, to.kind, ref, [text, ...links.map((l) => `[${l.label}](${l.url})`)].join("\n"));
  }

  /** Sends a question with its answer buttons; returns the message ref a reply will point at. */
  async ask(customerId: CustomerId, asked: OutgoingQuestion): Promise<string | null> {
    const to = await this.#customers.primaryChannel(customerId);
    if (!to) return null;
    const question = plainQuestion(asked);
    const ref = await this.#channels.get(to.kind).sendQuestion(to, question);
    await this.#transcript.recordOutgoing(customerId, to.kind, ref, `${QUESTION_MARK}${question.text}`);
    return ref;
  }

  async showAnswer(customerId: CustomerId, ref: string, question: OutgoingQuestion, answer: string): Promise<void> {
    const to = await this.#customers.primaryChannel(customerId);
    if (to) await this.#channels.get(to.kind).showAnswer(to, ref, plainQuestion(question), answer);
  }

  /** Sends a find's card; returns the ref its buttons will come back with. A card brings no sticker: they come only on good occasions. */
  async showFind(customerId: CustomerId, find: Find, _again = false): Promise<string | null> {
    const to = await this.#customers.primaryChannel(customerId);
    if (!to) return null;
    const ref = await this.#channels.get(to.kind).sendFind(to, find);
    await this.#transcript.recordOutgoing(customerId, to.kind, ref, `${CARD_MARK}${sourceLabel(find.source, find.url)}: ${find.url}`);
    return ref;
  }

  async updateFind(customerId: CustomerId, ref: string, find: Find): Promise<void> {
    const to = await this.#customers.primaryChannel(customerId);
    if (to) await this.#channels.get(to.kind).updateFind(to, ref, find);
  }

  /**
   * Asks under a card what should change in it, their reply box open on the question (the Edit button).
   * Returns the question's ref: a reply to it is a reply to the card.
   */
  async askEdit(customerId: CustomerId, cardRef: string): Promise<string | null> {
    const to = await this.#customers.primaryChannel(customerId);
    if (!to) return null;
    const ref = await this.#channels.get(to.kind).askEdit(to, cardRef, EDIT_ASK);
    await this.#transcript.recordOutgoing(customerId, to.kind, ref, EDIT_ASK);
    return ref;
  }

  /** Takes the buttons off an older copy of a card. */
  async closeCard(customerId: CustomerId, ref: string): Promise<void> {
    const to = await this.#customers.primaryChannel(customerId);
    if (to) await this.#channels.get(to.kind).closeCard(to, ref);
  }

  /** Sends a draft's card; returns the ref its buttons will come back with. Marked as a card in the transcript. `again`: a rewritten card, sent without a sticker. */
  async showDraft(customerId: CustomerId, draft: Draft, _again = false): Promise<string | null> {
    const to = await this.#customers.primaryChannel(customerId);
    if (!to) return null;
    const ref = await this.#channels.get(to.kind).sendDraft(to, draft);
    const label = draftLabel(draft);
    await this.#transcript.recordOutgoing(customerId, to.kind, ref, `${CARD_MARK}Draft, ${label}: ${draft.url}\n${draft.text}`);
    return ref;
  }

  async updateDraft(customerId: CustomerId, ref: string, draft: Draft): Promise<void> {
    const to = await this.#customers.primaryChannel(customerId);
    if (to) await this.#channels.get(to.kind).updateDraft(to, ref, draft);
  }

  /** A picture as a silent message. Not Quest's words, so it stays out of the transcript. */
  async sendPhoto(customerId: CustomerId, jpeg: Uint8Array, caption: string | null): Promise<string | null> {
    const to = await this.#customers.primaryChannel(customerId);
    return to ? this.#channels.get(to.kind).sendPhoto(to, jpeg, caption) : null;
  }

  /**
   * A picture they asked to see (a screenshot of a page Quest has open), noted on the transcript as
   * "📷 …", so the next turn knows it was sent. Null when their chat can't be reached.
   */
  async showPicture(customerId: CustomerId, jpeg: Uint8Array, caption: string | null, note: string): Promise<string | null> {
    const to = await this.#customers.primaryChannel(customerId);
    if (!to) return null;
    const ref = await this.#channels.get(to.kind).sendPhoto(to, jpeg, caption);
    await this.#transcript.recordOutgoing(customerId, to.kind, ref, `📷 ${note}${caption ? `: ${caption}` : ""}`);
    return ref;
  }


  /** Puts an emoji on one of their messages, in the chat they last wrote from, and notes it on the transcript. */
  async react(customerId: CustomerId, ref: string, emoji: string): Promise<boolean> {
    const to = await this.#customers.primaryChannel(customerId);
    if (!to) return false;
    await this.#channels.get(to.kind).react(to, ref, emoji);
    await this.#transcript.recordReaction(customerId, to.kind, ref, emoji);
    return true;
  }

  /** Best effort: a missing "typing…" is never worth failing a turn over. */
  async showTyping(customerId: CustomerId): Promise<void> {
    try {
      const to = await this.#customers.primaryChannel(customerId);
      if (to) await this.#channels.get(to.kind).showTyping(to);
    } catch (e) {
      this.#log.warn("messenger.typing_failed", { customerId, error: String(e) });
    }
  }
}
