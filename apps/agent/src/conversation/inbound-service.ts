import { LANGUAGES, LOCALES, customerLocale, supportedLocale, nextLanguage, forLanguage, systemMessage } from "@mq/i18n";
import { askKeys, type Ask, type Customer, type CustomerId, type CustomerRepository, type DraftAction, type DraftId, type EventSink, type FindAction, type FindId, type Inbound, type Logger, type Sender, type Transcriber, type Transcript } from "@mq/core";
import { aboutDeck } from "../asks/deck.ts";
import { clip } from "../lib/sleeper.ts";
import type { QuestionService } from "../questions/question-service.ts";
import type { ChannelRegistry } from "./channel-registry.ts";
import { FILE_CHARS, fileText, MAX_FILE_BYTES } from "./file-text.ts";
import type { Messenger } from "./messenger.ts";
import type { PictureReader } from "./pictures.ts";
import { SUPPORT, SUPPORT_BUTTON, SUPPORT_LINK, SUPPORT_URL } from "./support.ts";
import { audioFormat, MAX_VOICE_SECONDS } from "./voice-text.ts";
import type { WayIn } from "./way-in.ts";

type VoiceMessage = Extract<Inbound, { type: "voice" }>;
type TextMessage = Extract<Inbound, { type: "text" }>;

/** Said to the manager and the writer with anything heard from a voice message. Live, 2026-10-14: "Marc Lou" heard as "Mark Lou. ..." read as a message cut off. */
export const HEARD = "(said in a voice message: names and words may be misheard)";

/** What a button on a find's card does. */
export interface FindActions {
  /** Returns the few words the press is acknowledged with. */
  act(customerId: CustomerId, id: FindId, action: FindAction): Promise<string>;
}

/** What a button on a draft's card does: post it from their account, or skip it. */
export interface DraftActions {
  /** Returns the few words the press is acknowledged with. */
  act(customerId: CustomerId, id: DraftId, action: DraftAction): Promise<string>;
}

/** Quest's cards, for a reply to one: "shorter", or their own words for it. */
export interface CardLookup {
  /** Which card the message is and what is on it, for the manager; null when it is no card. */
  aboutCard(customerId: CustomerId, ref: string): Promise<string | null>;
  /** Their note put into an open card's words by the writer, the card shown again: what the manager should know; null when it is no such card. */
  applyNote?(customerId: CustomerId, ref: string, note: string): Promise<string | null>;
  /** The same two for the ask the deck shows (Your move), when they replied to the deck. */
  aboutAsk?(customerId: CustomerId, ask: Ask): Promise<string | null>;
  noteOnAsk?(customerId: CustomerId, ask: Ask, note: string): Promise<string | null>;
}

/** The deck (asks/deck.ts): its own buttons, and the ask a reply to it is about. */
export interface DeckDesk {
  move(customerId: CustomerId, key: string): Promise<string>;
  all(customerId: CustomerId, key: string): Promise<string>;
  one(customerId: CustomerId, key: string): Promise<string>;
  none(customerId: CustomerId, key: string): Promise<string>;
  yes(customerId: CustomerId, key: string): Promise<string>;
  no(customerId: CustomerId, key: string): Promise<string>;
  shows(customerId: CustomerId, ref: string): Promise<Ask | null>;
  past(customerId: CustomerId, key: string, why: string): Promise<void>;
}

/** A tap's answer that says it went, or it is settled anyway: anything else held it, and the deck moves past it. */
const SETTLED = /^(Posting|Queued|Sending|Scheduled|Skipped|Already|That one|Still|It may|Liked|Followed|Updat|Done)/;

/** Quest's day (billing/energy.ts): /plan, and what they hear when they write while it rests. */
export interface DayBudget {
  /** How they use Quest, what today used, and their credits, with the way to buy more. */
  show(customerId: CustomerId): Promise<void>;
  /** They wrote: while Quest rests, they hear how long it has left (once a rest), and a 😴 after. */
  heard(customerId: CustomerId, ref: string | null): Promise<void>;
}

/** The off switch (lifecycle/power.ts): /off, /on, the button under each, and the note that a message waits. */
export interface PowerSwitch {
  set(customerId: CustomerId, on: boolean, from: "chat" | "tap"): Promise<boolean>;
}

/** Their ideas and assets (ideas/idea-service.ts): a tap on an idea's card, and a picture or video kept for their posts. */
export interface IdeaDesk {
  act(customerId: CustomerId, id: string, action: "yes" | "no"): Promise<string>;
  keepFile(customerId: CustomerId, f: { channel: string; fileRef: string; mime: string | null; name: string | null; size: number | null; about: string }): Promise<{ readonly id: string }>;
}

/** Quest's first question to someone new, right after their language: all it asks, in their words or their voice. */
export const FIRST_ASK = "What are you building? Send a link if you have one, and tell me where you'd like to be seen. Voice is fine.";

/** Sending the Chrome setup, for the /connect command. */
export interface ChromeSetup {
  offer(customerId: CustomerId, opts: { force: boolean }): Promise<unknown>;
}

/**
 * Everything a person sends, from any channel, lands here: it finds (or creates)
 * the customer, keeps the transcript, routes answers to the question they answer,
 * and queues the rest for the manager. It never waits on the manager.
 */
export class InboundService {
  readonly #customers: CustomerRepository;
  readonly #transcript: Transcript;
  readonly #events: EventSink;
  readonly #questions: QuestionService;
  readonly #finds: FindActions;
  readonly #drafts: DraftActions | null;
  readonly #cards: readonly CardLookup[];
  readonly #deck: DeckDesk | null;
  readonly #chrome: ChromeSetup;
  readonly #energy: DayBudget | null;
  readonly #power: PowerSwitch | null;
  readonly #ideas: IdeaDesk | null;
  readonly #transcriber: Transcriber | null;
  readonly #pictures: PictureReader | null;
  readonly #channels: ChannelRegistry;
  readonly #faces: Pick<Messenger, "say" | "sendLinks"> | null;
  readonly #wayIn: Pick<WayIn, "letIn"> | null;
  readonly #met: ((customerId: CustomerId, code: string) => Promise<void>) | null;
  readonly #portal: ((from: Sender, code: string) => Promise<boolean>) | null;
  readonly #log: Logger;
  readonly #wakeManager: (customerId: CustomerId) => void;

  constructor(deps: {
    customers: CustomerRepository;
    transcript: Transcript;
    events: EventSink;
    questions: QuestionService;
    finds: FindActions;
    drafts?: DraftActions;
    /** Where a reply to a card finds out which card it was. */
    cards?: readonly CardLookup[];
    /** Your move: the deck's buttons, and which ask a reply to it is about. */
    deck?: DeckDesk;
    chrome: ChromeSetup;
    /** /plan, and the word that Quest rests when they write while it does. */
    energy?: DayBudget;
    /** /off and /on, and the word that what they write waits while Quest is off. */
    power?: PowerSwitch;
    /** Taps on Quest's idea cards, and the pictures and videos they send kept for their posts. */
    ideas?: IdeaDesk;
    /** Hears voice messages, which then count as typed. Without it, Quest asks for them typed. */
    transcriber?: Transcriber;
    /** Says what a picture they sent shows. Without it, Quest asks what it shows. */
    pictures?: PictureReader;
    channels: ChannelRegistry;
    /** Quest's sticker, and its first words to someone new (what are you working on?), sent right after their language. */
    faces?: Pick<Messenger, "say" | "sendLinks">;
    /** Lets someone new in (an invite, else a free start on credits) before their first message is handled. Without it, everyone is in. */
    wayIn?: Pick<WayIn, "letIn">;
    /** A start link from the extension's panel ("Also talk to Quest in Telegram"): joins this Telegram to that customer. True when it did, or said why not. */
    portal?: (from: Sender, code: string) => Promise<boolean>;
    /** Someone new came with a code that says where Quest met them (conversation/met-notes.ts): their manager hears it. */
    met?: (customerId: CustomerId, code: string) => Promise<void>;
    log: Logger;
    /** Something of theirs waits for the manager: a turn that only looked around makes way for it (ManagerLoop.heard). */
    wakeManager: (customerId: CustomerId) => void;
  }) {
    this.#customers = deps.customers;
    this.#transcript = deps.transcript;
    this.#events = deps.events;
    this.#questions = deps.questions;
    this.#finds = deps.finds;
    this.#drafts = deps.drafts ?? null;
    this.#cards = deps.cards ?? [];
    this.#deck = deps.deck ?? null;
    this.#chrome = deps.chrome;
    this.#energy = deps.energy ?? null;
    this.#power = deps.power ?? null;
    this.#ideas = deps.ideas ?? null;
    this.#transcriber = deps.transcriber ?? null;
    this.#pictures = deps.pictures ?? null;
    this.#channels = deps.channels;
    this.#faces = deps.faces ?? null;
    this.#wayIn = deps.wayIn ?? null;
    this.#met = deps.met ?? null;
    this.#portal = deps.portal ?? null;
    this.#log = deps.log;
    this.#wakeManager = deps.wakeManager;
  }

  async handle(received: Inbound): Promise<void> {
    // The panel's link to Telegram: this chat joins the customer who pressed it, before anyone new is made for it.
    if (this.#portal && received.type === "command" && received.command === "start" && /^tg_[\w-]{8,}$/.test(received.args.trim()) && (await this.#portal(received.from, received.args.trim()))) return;
    const found = await this.#customerFor(received.from);
    const isNew = found.isNew;
    let customer = found.customer;
    // A start link tagged with where they saw Quest (the landing passes a link's utm_source on as from_<platform>).
    const from = isNew && received.type === "command" && received.command === "start" ? /^from_([a-z0-9]{1,24})$/i.exec(received.args.trim())?.[1]?.toLowerCase() : undefined;
    if (from) {
      await this.#customers.update(customer.id, { cameFrom: from }).catch(() => undefined);
      this.#log.info("customers.came_from", { customerId: customer.id, from });
    }
    // /support reaches a person from anywhere: let in or not, on or off, resting or not. No model call.
    if (received.type === "command" && received.command === "support") {
      const t = forLanguage(customer.language);
      await this.#channels.get(received.from.channel.kind).sendLinks(received.from.channel, t(SUPPORT), [{ label: t(SUPPORT_BUTTON), url: SUPPORT_URL }]);
      return;
    }
    // Someone new: in at once (an invite, else a free start), and this message is their first.
    if (this.#wayIn && !customer.activatedAt && (await this.#wayIn.letIn(customer, received))) {
      customer = { ...customer, activatedAt: new Date() };
      // The code they came with may say where Quest met them (a page made for them, a thread on dev): told before the first turn.
      if (received.type === "command" && received.command === "start" && received.args.trim()) await this.#met?.(customer.id, received.args.trim()).catch(() => undefined);
    }
    // A voice message is heard first; from here on it is what they would have typed.
    const inbound = received.type === "voice" ? await this.#heard(customer.id, received) : received;
    if (!inbound) return;
    const kind = inbound.from.channel.kind;
    const tr = (s: string) => systemMessage(customer.language, s);

    if (inbound.type === "choice") {
      const q = await this.#questions.choose(customer.id, inbound.questionId, inbound.option);
      await this.#channels.get(kind).acknowledge(inbound.ackRef, tr(q ? "Got it" : "That one is already settled"));
      return;
    }

    if (inbound.type === "find") {
      const ack = await this.#finds.act(customer.id, inbound.findId, inbound.action);
      await this.#channels.get(kind).acknowledge(inbound.ackRef, tr(ack));
      if (inbound.action.kind === "post" && ack && !SETTLED.test(ack)) await this.#deck?.past(customer.id, askKeys.find(inbound.findId), ack);
      return;
    }

    if (inbound.type === "deck") {
      const ack = this.#deck ? await this.#deck[inbound.action](customer.id, inbound.key) : "That one is no longer here";
      await this.#channels.get(kind).acknowledge(inbound.ackRef, ack ? tr(ack) : undefined);
      return;
    }

    if (inbound.type === "draft") {
      const ack = this.#drafts ? await this.#drafts.act(customer.id, inbound.draftId, inbound.action) : "That one is no longer here";
      await this.#channels.get(kind).acknowledge(inbound.ackRef, tr(ack));
      if ((inbound.action === "post" || inbound.action === "retry") && ack && !SETTLED.test(ack)) await this.#deck?.past(customer.id, askKeys.draft(inbound.draftId), ack);
      return;
    }

    if (inbound.type === "language") {
      await this.#chooseLanguage(customer, inbound);
      return;
    }

    if (inbound.type === "idea") {
      const ack = this.#ideas ? await this.#ideas.act(customer.id, inbound.ideaId, inbound.action) : "That one is no longer here";
      await this.#channels.get(kind).acknowledge(inbound.ackRef, tr(ack));
      return;
    }

    if (inbound.type === "power") {
      const changed = this.#power ? await this.#power.set(customer.id, inbound.on, "tap") : false;
      await this.#channels.get(kind).acknowledge(inbound.ackRef, tr(changed ? (inbound.on ? "Quest is on" : "Browsing is off") : inbound.on ? "Already on" : "Already off"));
      return;
    }

    if (inbound.type === "file") {
      const picture = Boolean(inbound.mimeType?.startsWith("image/"));
      const said = picture ? ["🖼", inbound.caption].filter(Boolean).join(" ") : inbound.mimeType?.startsWith("video/") ? ["🎬", inbound.fileName, inbound.size ? `(${Math.round(inbound.size / 1024 / 1024)} MB)` : null, inbound.caption].filter(Boolean).join(" ") : [`📎 ${inbound.fileName}`, inbound.caption].filter(Boolean).join("\n");
      if (!(await this.#transcript.recordIncoming(customer.id, kind, inbound.messageRef, said))) return; // redelivered
      const video = Boolean(inbound.mimeType?.startsWith("video/"));
      const note = picture
        ? await this.#readPicture(customer.id, inbound)
        : video
          ? "(They sent a video. Quest can't watch it: ask what it shows only if that matters.)"
          : await this.#readFile(customer.id, inbound);
      // A picture or a video is kept for their posts: the manager can put it up with one.
      const kept = picture || video ? await this.#keepAsset(customer.id, inbound, [inbound.caption, note].filter(Boolean).join(" ")) : null;
      const shown = inbound.replyToRef ? await this.#deck?.shows(customer.id, inbound.replyToRef) : null;
      const card = shown ? await this.#aboutAsk(customer.id, shown) : inbound.replyToRef ? await this.#aboutCard(customer.id, inbound.replyToRef) : null;
      await this.#events.push(customer.id, { kind: "user_message", text: [inbound.caption, note, kept, card].filter(Boolean).join("\n\n"), ref: inbound.messageRef });
      this.#wakeManager(customer.id);
      await this.#whileResting(customer.id, inbound.messageRef);
      return;
    }

    const text = inbound.type === "command" ? `/${inbound.command}${inbound.args ? ` ${inbound.args}` : ""}` : inbound.text;
    if (!(await this.#transcript.recordIncoming(customer.id, kind, inbound.messageRef, text))) return; // redelivered

    if (inbound.type === "command" && inbound.command === "language") {
      const choice = inbound.args.trim().toLowerCase();
      const locale = supportedLocale(choice);
      const channel = this.#channels.get(kind);
      if (choice === "auto" || locale) {
        const language = choice === "auto" ? nextLanguage(null, inbound.from.language) : `manual:${locale}`;
        await this.#customers.update(customer.id, { language });
        const t = forLanguage(language);
        await channel.sendText(inbound.from.channel, choice === "auto" ? t("Language follows Telegram again.") : t("I'll use {language} from now on.", { language: LANGUAGES[customerLocale(language)] }));
      } else {
        await channel.sendText(inbound.from.channel, [tr("Choose a language, or use /language auto to follow Telegram."), ...LOCALES.map((code) => `/language ${code} · ${LANGUAGES[code]}`)].join("\n"));
      }
      return;
    }

    // /connect sends the Chrome setup at once; the manager has nothing to add to it.
    if (inbound.type === "command" && inbound.command === "connect") {
      await this.#chrome.offer(customer.id, { force: true });
      return;
    }


    // /off and /on switch Quest off and on; the manager's next turn is told which it is.
    if (inbound.type === "command" && (inbound.command === "off" || inbound.command === "on") && this.#power) {
      if (!(await this.#power.set(customer.id, inbound.command === "on", "chat"))) {
        await this.#channels.get(kind).sendText(inbound.from.channel, tr(inbound.command === "on" ? "I'm already on." : "I'm already off. /on switches me back on."));
      }
      return;
    }

    // /plan says how they use Quest, what today used and their credits; the manager has nothing to add.
    if (inbound.type === "command" && inbound.command === "plan" && this.#energy) {
      await this.#energy.show(customer.id);
      return;
    }

    // The first thing anyone new sees is the choice of language, then what they build (the founder, 2026-10-24: "The
    // language should be the first question, with option to keep auto/default"). Quest serves founders and builders
    // only, so nobody chooses a quest; a link's tag (t.me/<bot>?start=x) only tells the manager where they came from.
    if (inbound.type === "command" && inbound.command === "start" && !(await this.#transcript.recent(customer.id, 20)).some((e) => e.direction === "out")) {
      await this.#channels.get(kind).sendLanguageChoice(inbound.from.channel, customer.language ?? inbound.from.language ?? "en");
      return;
    }

    // A reply to the deck is about the ask it shows: a question there is answered by it.
    const shown = inbound.type === "text" && inbound.replyToRef ? ((await this.#deck?.shows(customer.id, inbound.replyToRef)) ?? null) : null;
    if (inbound.type === "text" && shown?.kind === "question") {
      await this.#questions.answer(shown.question.id, inbound.text, "user");
      this.#wakeManager(customer.id);
      return;
    }

    if (inbound.type === "text" && inbound.replyToRef) {
      const q = await this.#questions.findAskedByRef(customer.id, inbound.replyToRef);
      if (q) {
        await this.#questions.answer(q.id, inbound.text, "user");
        this.#wakeManager(customer.id);
        return;
      }
    }

    // A reply to an open card is a note on its words: the writer puts it in, and the card comes back under it.
    // Otherwise the manager learns which card it was, and what is on it now.
    const heard = received.type === "voice" ? `\n${HEARD}` : "";
    let card: string | null = null;
    if (inbound.type === "text" && shown) {
      card = await this.#noteOnAsk(customer.id, shown, `${text}${heard}`);
      card ??= await this.#aboutAsk(customer.id, shown);
    } else if (inbound.type === "text" && inbound.replyToRef) {
      card = await this.#applyNote(customer.id, inbound.replyToRef, `${text}${heard}`);
      card ??= await this.#aboutCard(customer.id, inbound.replyToRef);
    }
    const said =
      inbound.type === "command" && inbound.command === "start"
        ? `(opened the chat with /start${inbound.args ? `, from a link tagged "${inbound.args}"` : ""}${isNew ? "; this is their first time here" : ""})`
        : card
          ? `${text}${heard}\n${card}`
          : `${text}${heard}`;
    await this.#events.push(customer.id, { kind: "user_message", text: said, ...(inbound.type === "text" ? { ref: inbound.messageRef } : {}) });
    this.#wakeManager(customer.id);
    await this.#whileResting(customer.id, inbound.type === "text" ? inbound.messageRef : null);
  }

  /** What they said waits while Quest rests (its day's credits spent): they hear it once a rest. Best effort. */
  async #whileResting(customerId: CustomerId, ref: string | null): Promise<void> {
    try {
      await this.#energy?.heard(customerId, ref);
    } catch (e) {
      this.#log.warn("inbound.rest_note_failed", { customerId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * A tap on the language choice: auto keeps their Telegram's, anything else is theirs from then on (the Mini App's
   * picker did not change it, live 2026-10-24). The first time, Quest asks what they work on in that language, in a
   * message of its own, with no model call.
   */
  async #chooseLanguage(customer: Customer, inbound: Extract<Inbound, { type: "language" }>): Promise<void> {
    const kind = inbound.from.channel.kind;
    const channel = this.#channels.get(kind);
    const auto = nextLanguage(customer.language, inbound.from.language);
    const locale = inbound.locale === "auto" ? customerLocale(auto) : supportedLocale(inbound.locale);
    if (!locale) {
      await channel.acknowledge(inbound.ackRef);
      return;
    }
    const language = inbound.locale === "auto" ? auto : `manual:${locale}`;
    if (language !== customer.language) await this.#customers.update(customer.id, { language });
    await channel.acknowledge(inbound.ackRef, LANGUAGES[locale]);
    if (inbound.messageRef) await channel.showLanguageChosen(inbound.from.channel, inbound.messageRef, locale);
    const spoken = (await this.#transcript.recent(customer.id, 20)).some((e) => e.direction === "out");
    if (spoken || !this.#faces) return;
    const name = customer.displayName?.split(/\s+/)[0];
    // Each paragraph on its own: a pattern like "Hi {name}." would take the whole message for a name.
    const t = forLanguage(language);
    await this.#faces.sendLinks(customer.id, [name ? t("Hi {name}.", { name }) : null, t(FIRST_ASK)].filter(Boolean).join("\n\n"), [{ label: SUPPORT_LINK, url: SUPPORT_URL }]);
  }


  async #aboutCard(customerId: CustomerId, ref: string): Promise<string | null> {
    for (const c of this.#cards) {
      const about = await c.aboutCard(customerId, ref);
      if (about) return about;
    }
    return null;
  }

  /** Which ask the deck showed and what is on it now, for the manager. */
  async #aboutAsk(customerId: CustomerId, ask: Ask): Promise<string> {
    for (const c of this.#cards) {
      const about = await c.aboutAsk?.(customerId, ask);
      if (about) return about;
    }
    return aboutDeck(ask);
  }

  /** Their note put into the ask the deck shows, when its words can take one; what the manager should know of it, or null. */
  async #noteOnAsk(customerId: CustomerId, ask: Ask, note: string): Promise<string | null> {
    for (const c of this.#cards) {
      try {
        const done = await c.noteOnAsk?.(customerId, ask, note);
        if (done) return done;
      } catch (e) {
        this.#log.warn("inbound.note_failed", { customerId, ask: ask.key, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return null;
  }

  /** Their note put into the card it answers, when it is an open one; what the manager should know of it, or null. */
  async #applyNote(customerId: CustomerId, ref: string, note: string): Promise<string | null> {
    for (const c of this.#cards) {
      try {
        const done = await c.applyNote?.(customerId, ref, note);
        if (done) return done;
      } catch (e) {
        this.#log.warn("inbound.note_failed", { customerId, ref, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return null;
  }

  /** A picture or a video kept for their posts; what the manager is told of it, or null when it could not be kept. */
  async #keepAsset(customerId: CustomerId, file: Extract<Inbound, { type: "file" }>, about: string): Promise<string | null> {
    if (!this.#ideas) return null;
    try {
      const asset = await this.#ideas.keepFile(customerId, { channel: file.from.channel.kind, fileRef: file.fileRef, mime: file.mimeType, name: file.fileName, size: file.size, about });
      return `(Kept for their posts as asset ${asset.id}: a post can go up with it, draft with assets. If it is not for posts, drop_asset it.)`;
    } catch (e) {
      this.#log.warn("inbound.asset_failed", { customerId, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  /** What the manager reads of a picture: what it shows, or why it can't say. */
  async #readPicture(customerId: CustomerId, file: Extract<Inbound, { type: "file" }>): Promise<string> {
    if (!this.#pictures) return "(They sent a picture, and Quest cannot see pictures here. Ask what it shows.)";
    if (file.size !== null && file.size > MAX_FILE_BYTES) return "(They sent a picture too big to open here. Ask for a smaller one.)";
    try {
      const bytes = await this.#channels.get(file.from.channel.kind).download(file.fileRef);
      const shows = await this.#pictures.describe(customerId, bytes, file.mimeType ?? "image/jpeg");
      return shows ? `(They sent a picture. It shows: ${clip(shows, FILE_CHARS)})` : "(They sent a picture, but nothing could be made out in it. Ask what it shows.)";
    } catch (e) {
      this.#log.warn("inbound.picture_failed", { customerId, error: e instanceof Error ? e.message : String(e) });
      return "(They sent a picture, but it could not be opened. Ask them to send it again, or say what it shows.)";
    }
  }

  /** What the manager reads of a file: its words, or why there are none. */
  async #readFile(customerId: CustomerId, file: Extract<Inbound, { type: "file" }>): Promise<string> {
    const name = file.fileName;
    if (file.size !== null && file.size > MAX_FILE_BYTES) return `(They sent ${name}, too big to open here. Ask for a smaller PDF, or the text pasted in.)`;
    try {
      const bytes = await this.#channels.get(file.from.channel.kind).download(file.fileRef);
      const text = await fileText(bytes, name, file.mimeType);
      if (text === null) return `(They sent ${name}, a kind of file Quest cannot read. Ask for a PDF, or the text pasted in.)`;
      if (!text) return `(They sent ${name}, but it has no text to read: likely a scan. Ask for the text pasted in.)`;
      return `(They sent ${name}. Its text:)\n${clip(text, FILE_CHARS)}`;
    } catch (e) {
      this.#log.warn("inbound.file_failed", { customerId, name, error: e instanceof Error ? e.message : String(e) });
      return `(They sent ${name}, but it could not be opened. Ask them to send it again, or paste the text in.)`;
    }
  }

  /**
   * A voice message as the text message it would have been. When it cannot be heard, the manager
   * is told why, so it asks for the words typed, and there is nothing more to handle: null.
   */
  async #heard(customerId: CustomerId, voice: VoiceMessage): Promise<TextMessage | null> {
    const heard = await this.#listen(customerId, voice);
    if ("words" in heard) {
      return { type: "text", from: voice.from, text: [voice.caption, heard.words].filter(Boolean).join("\n\n"), messageRef: voice.messageRef, replyToRef: voice.replyToRef };
    }
    const said = ["🎤", voice.fileName, voice.caption].filter(Boolean).join(" ");
    if (!(await this.#transcript.recordIncoming(customerId, voice.from.channel.kind, voice.messageRef, said))) return null; // redelivered
    await this.#events.push(customerId, { kind: "user_message", text: [voice.caption, heard.note].filter(Boolean).join("\n\n"), ref: voice.messageRef });
    this.#wakeManager(customerId);
    return null;
  }

  /** What they said in it, or why it could not be heard, for the manager. */
  async #listen(customerId: CustomerId, voice: VoiceMessage): Promise<{ words: string } | { note: string }> {
    const what = voice.fileName ?? "a voice message";
    const format = audioFormat(voice.mimeType, voice.fileName);
    if (!this.#transcriber) return { note: `(They sent ${what}, and Quest cannot listen to recordings here. Ask for the words typed.)` };
    if (!format) return { note: `(They sent ${what}, a kind of recording Quest cannot listen to. Ask for a voice message, or the words typed.)` };
    if ((voice.seconds ?? 0) > MAX_VOICE_SECONDS || (voice.size ?? 0) > MAX_FILE_BYTES) {
      const length = voice.seconds ? ` of ${Math.round(voice.seconds / 60)} minutes` : "";
      return { note: `(They sent ${what}${length}, too long to listen to here. Ask for the main points typed, or in a shorter one.)` };
    }
    try {
      const audio = await this.#channels.get(voice.from.channel.kind).download(voice.fileRef);
      const words = await this.#transcriber.transcribe(audio, format, customerId);
      if (!words) return { note: `(They sent ${what}, but nobody speaks in it. Ask what they meant to say.)` };
      return { words: clip(words, FILE_CHARS) };
    } catch (e) {
      this.#log.warn("inbound.voice_failed", { customerId, format, seconds: voice.seconds, error: e instanceof Error ? e.message : String(e) });
      return { note: `(They sent ${what}, but it could not be heard. Ask them to send it again, or type it.)` };
    }
  }

  async #customerFor(from: Sender): Promise<{ customer: Customer; isNew: boolean }> {
    const existing = await this.#customers.findByChannel(from.channel);
    if (existing) {
      await this.#customers.markSeen(from.channel);
      const language = nextLanguage(existing.language, from.language);
      if (language !== existing.language) await this.#customers.update(existing.id, { language });
      return { customer: { ...existing, language }, isNew: false };
    }
    const customer = await this.#customers.create({
      channel: from.channel,
      userRef: from.userRef,
      displayName: from.displayName,
      language: nextLanguage(null, from.language),
    });
    this.#log.info("customers.created", { customerId: customer.id, channel: from.channel.kind });
    return { customer, isNew: true };
  }
}
