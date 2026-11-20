import { randomUUID } from "node:crypto";
import type {
  ChannelAddress,
  ChatChannel,
  CustomerId,
  CustomerRepository,
  DeckView,
  Draft,
  Find,
  Idea,
  OutgoingLink,
  OutgoingQuestion,
} from "@mq/core";
import { choiceData, languageData, powerData } from "../telegram/updates.ts";

/** A button in the popup: one that does what a Telegram button's data says, or one that opens a page. */
export type WebButton = { readonly label: string; readonly data: string } | { readonly label: string; readonly url: string };

/** How many messages' buttons are kept for each chat: the popup shows the last few dozen. */
const KEPT = 60;
/** "typing…" shows this long after Quest said it writes. */
const TYPING_MS = 6_000;

/**
 * News for their extension: every message Quest writes, and every change of Your move, moves a customer's mark on. The
 * mark is a time, so it only grows across restarts; the extension's poll reads it and opens the chat when it moved.
 */
export class ChatNews {
  readonly #marks = new Map<string, number>();
  readonly #waiting = new Map<string, Set<() => void>>();

  bump(customerId: CustomerId): void {
    this.#marks.set(customerId, Math.max(Date.now(), (this.#marks.get(customerId) ?? 0) + 1));
    for (const wake of this.#waiting.get(customerId) ?? []) wake();
    this.#waiting.delete(customerId);
  }

  mark(customerId: CustomerId): number {
    return this.#marks.get(customerId) ?? 0;
  }

  /** Waits until the mark passes `after`, at most `ms`; the mark then. */
  async after(customerId: CustomerId, after: number, ms: number, signal?: AbortSignal): Promise<number> {
    if (this.mark(customerId) > after || ms <= 0) return this.mark(customerId);
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.#waiting.get(customerId)?.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      const set = this.#waiting.get(customerId) ?? new Set();
      set.add(done);
      this.#waiting.set(customerId, set);
    });
    return this.mark(customerId);
  }
}

/** What one chat shows besides its transcript: buttons on messages, a line kept up to date, a question waiting on a reply. */
interface ChatState {
  readonly buttons: Map<string, readonly WebButton[]>;
  line: { readonly ref: string; readonly text: string } | null;
  replyTo: { readonly ref: string; readonly text: string } | null;
  typingUntil: number;
}

/**
 * Quest's chat in their extension's popup (the founder, 2026-11-15: "Telegram is no longer a requirement, but an
 * optional remote control! And Quest should mostly be reached through a conversation, not a page"). What Quest says is
 * the transcript, which the popup reads; this keeps only what the transcript does not: the buttons under a message, the
 * line the first sweep keeps up to date, the ask under Edit, and "typing". Cards are not drawn here: the popup shows
 * Your move itself, from the deck (`Deck.view`). In memory: after a restart the words are all there, their buttons not.
 */
export class WebChannel implements ChatChannel {
  readonly kind = "web" as const;
  readonly #customers: Pick<CustomerRepository, "findByChannel">;
  readonly #news: ChatNews;
  readonly #chats = new Map<string, ChatState>();
  readonly #owners = new Map<string, CustomerId>();
  readonly #acks = new Map<string, string>();

  constructor(deps: { customers: Pick<CustomerRepository, "findByChannel">; news: ChatNews }) {
    this.#customers = deps.customers;
    this.#news = deps.news;
  }

  /** What the popup draws beside the transcript. */
  state(address: string): { readonly buttons: ReadonlyMap<string, readonly WebButton[]>; readonly line: string | null; readonly replyTo: { readonly ref: string; readonly text: string } | null; readonly typing: boolean } {
    const s = this.#chat(address);
    return { buttons: s.buttons, line: s.line?.text ?? null, replyTo: s.replyTo, typing: s.typingUntil > Date.now() };
  }

  /** What a press was answered with ("Skipped", "Posting it…"), once. */
  takeAck(ackRef: string): string | null {
    const ack = this.#acks.get(ackRef) ?? null;
    this.#acks.delete(ackRef);
    return ack;
  }

  /** Their message answered the question under Edit: the box is theirs again. */
  answered(address: string): void {
    this.#chat(address).replyTo = null;
  }

  #chat(address: string): ChatState {
    let s = this.#chats.get(address);
    if (!s) {
      s = { buttons: new Map(), line: null, replyTo: null, typingUntil: 0 };
      this.#chats.set(address, s);
    }
    return s;
  }

  async #said(to: ChannelAddress, buttons: readonly WebButton[] = []): Promise<string> {
    const ref = `w:${randomUUID()}`;
    const chat = this.#chat(to.address);
    chat.typingUntil = 0;
    if (buttons.length) {
      chat.buttons.set(ref, buttons);
      while (chat.buttons.size > KEPT) chat.buttons.delete(chat.buttons.keys().next().value!);
    }
    await this.#bump(to);
    return ref;
  }

  async #bump(to: ChannelAddress): Promise<void> {
    let owner = this.#owners.get(to.address);
    if (!owner) {
      owner = (await this.#customers.findByChannel(to).catch(() => null))?.id;
      if (owner) this.#owners.set(to.address, owner);
    }
    if (owner) this.#news.bump(owner);
  }

  sendText(to: ChannelAddress, _text: string, answers: readonly string[] = []): Promise<string | null> {
    // A likely answer is a button that sends its words as their message.
    return this.#said(to, answers.map((a) => ({ label: a, data: `say:${a}` })));
  }

  async editText(to: ChannelAddress, ref: string, text: string): Promise<boolean> {
    this.#chat(to.address).line = { ref, text };
    await this.#bump(to);
    return true;
  }

  sendQuestion(to: ChannelAddress, question: OutgoingQuestion): Promise<string | null> {
    return this.#said(to, question.options.map((o, i) => ({ label: o, data: choiceData(question.id, i) })));
  }

  async showAnswer(to: ChannelAddress, ref: string): Promise<void> {
    this.#chat(to.address).buttons.delete(ref);
    await this.#bump(to);
  }

  async acknowledge(ackRef: string, text?: string): Promise<void> {
    if (text) this.#acks.set(ackRef, text);
  }

  async showTyping(to: ChannelAddress): Promise<void> {
    this.#chat(to.address).typingUntil = Date.now() + TYPING_MS;
    await this.#bump(to);
  }

  async react(to: ChannelAddress): Promise<void> {
    // The transcript keeps the reaction (recordReaction); the popup draws it from there.
    await this.#bump(to);
  }

  sendFind(to: ChannelAddress, _find: Find): Promise<string | null> {
    return this.#said(to);
  }

  async updateFind(to: ChannelAddress): Promise<void> {
    await this.#bump(to);
  }

  sendDraft(to: ChannelAddress, _draft: Draft): Promise<string | null> {
    return this.#said(to);
  }

  async updateDraft(to: ChannelAddress): Promise<void> {
    await this.#bump(to);
  }

  async askEdit(to: ChannelAddress, _cardRef: string, text: string): Promise<string | null> {
    const ref = await this.#said(to);
    this.#chat(to.address).replyTo = { ref, text };
    return ref;
  }

  async closeCard(): Promise<void> {}

  sendIdea(to: ChannelAddress, _idea: Idea): Promise<string | null> {
    return this.#said(to);
  }

  async showIdeaDecided(to: ChannelAddress): Promise<void> {
    await this.#bump(to);
  }

  sendSwitch(to: ChannelAddress, _text: string, on: boolean): Promise<string | null> {
    return this.#said(to, [{ label: on ? "Switch Quest on" : "Switch Quest off", data: powerData(on) }]);
  }

  sendLinks(to: ChannelAddress, _text: string, links: readonly OutgoingLink[]): Promise<string | null> {
    return this.#said(to, links.map((l) => ({ label: l.label, url: l.url })));
  }

  sendLanguageChoice(to: ChannelAddress, detected: string): Promise<string | null> {
    // The browser's language is theirs already; one button keeps it, the rest is Settings'.
    return this.#said(to, [{ label: "OK", data: languageData(detected || "auto") }]);
  }

  async showLanguageChosen(to: ChannelAddress, ref: string): Promise<void> {
    this.#chat(to.address).buttons.delete(ref);
  }

  /** Recordings from the popup, held until they are heard (once, at once): the web chat keeps no files. */
  readonly #files = new Map<string, Uint8Array>();

  keep(bytes: Uint8Array): string {
    const ref = `w:file:${randomUUID()}`;
    this.#files.set(ref, bytes);
    // Never heard (the handler failed before): let go after a few minutes.
    setTimeout(() => this.#files.delete(ref), 5 * 60_000).unref?.();
    return ref;
  }

  async download(ref: string): Promise<Uint8Array> {
    const bytes = this.#files.get(ref);
    if (!bytes) throw new Error("the web chat takes no files");
    this.#files.delete(ref);
    return bytes;
  }

  async sendPhoto(): Promise<string | null> {
    return null;
  }

  async showWork(): Promise<boolean> {
    return false;
  }

  async removeBoard(): Promise<void> {}

  async showDeck(to: ChannelAddress, ref: string | null, _view: DeckView): Promise<string | null> {
    await this.#bump(to);
    return ref ?? `w:deck:${randomUUID()}`;
  }

  async removeMessage(): Promise<void> {}
}
