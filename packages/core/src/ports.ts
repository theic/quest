/**
 * Ports: what the application needs from the outside world, one small interface
 * per responsibility. Services depend on these; adapters (Postgres, Telegram, the
 * customer's Chrome) implement them; tests use in-memory fakes of the same contracts.
 */
import type { DeckState, DeckView } from "./asks.ts";
import type { ChannelAddress, ChannelKind } from "./channel.ts";
import type { ChromeLink, ChromePost, ChromePosted } from "./chrome.ts";
import type { Commitment, NewCommitment } from "./commitments.ts";
import type { Contact, ContactCheck } from "./contacts.ts";
import type { NewResult, ResultEntry } from "./results.ts";
import type { Route, RouteResult } from "./routes.ts";
import type { Customer, CustomerPatch, NewCustomer } from "./customer.ts";
import type { Draft, NewDraft, ToldAnswers, WatchedDraft } from "./drafts.ts";
import type { Asset, ClipReading, ClipWord, Idea, IdeaStatus, NewAsset, NewIdea } from "./ideas.ts";
import type { ManagerEvent, QueuedEvent } from "./events.ts";
import type { Find, FindCounts, FindDecision, FindStatus, NewFind, SkipReason, WatchedFind } from "./finds.ts";
import type { CustomerId, DraftId, FindId, QuestionId, TaskId } from "./ids.ts";
import type { DayFacts, Memory, NewMemory } from "./memory.ts";
import type { NewPlace, Place } from "./places.ts";
import type { DaySpend, ToppedUp, TopUp } from "./plans.ts";
import type { AskedWith, IntakeOption, ProfileAnswer, Reflection, Scene } from "./profile.ts";
import type { AnsweredBy, NewQuestion, Question, QuestionStatus } from "./questions.ts";
import type { FoundPost, PostQuery, SourceInfo } from "./posts.ts";
import type { PageText, SiteRead } from "./reading.ts";
import type { AgentPace, ClaimedTask, NewTask, Task, TaskInput, TaskOutcome, TaskSignals, TaskStatus } from "./tasks.ts";
import type { ModelCall } from "./usage.ts";

export interface Clock {
  now(): Date;
}

export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

/* ------------------------------------------------------------- customers */

export interface CustomerRepository {
  findByChannel(address: ChannelAddress): Promise<Customer | null>;
  /** Creates the customer and binds the channel it wrote from, in one step. */
  create(input: NewCustomer): Promise<Customer>;
  get(id: CustomerId): Promise<Customer>;
  update(id: CustomerId, patch: CustomerPatch): Promise<void>;
  /** Notes that the customer just wrote from this chat, which makes it their primary channel. */
  markSeen(address: ChannelAddress): Promise<void>;
  /** Where to reach the customer by default: the channel they last wrote from. */
  primaryChannel(id: CustomerId): Promise<ChannelAddress | null>;
  /** Their chat on one kind of channel (the web chat in their extension's popup), or null when they have none there. */
  channelOf(id: CustomerId, kind: ChannelKind): Promise<ChannelAddress | null>;
  /** Binds another chat to the customer (their popup's, beside Telegram); nothing when it is bound already. */
  bindChannel(id: CustomerId, address: ChannelAddress, userRef: string): Promise<void>;
  /**
   * Notes that a take went out, on the message `ref`, with the words it was written with and what it answers; or that
   * Quest read where they show up, with what it read.
   */
  profileAsked(id: CustomerId, key: string, ref: string | null, at: Date, asked?: AskedWith): Promise<void>;
  /** Keeps the answer to a take that waits on one; false when it was never asked, or is answered already. */
  profileAnswered(id: CustomerId, key: string, answer: ProfileAnswer): Promise<boolean>;
  /** The customers (in the repository's lane) who switched Quest off. */
  switchedOff(): Promise<CustomerId[]>;
  /** Every chat of that kind (in the repository's lane). */
  chats(kind: ChannelKind): Promise<ChannelAddress[]>;
}

/** The invites the founder hands out (`mq.invites`): codes, each good for so many people. */
export interface InviteRepository {
  /** Lets them in with the first of `codes` (any case) that has a use left, and uses it; false when none has, or they are in already. */
  redeem(customerId: CustomerId, codes: readonly string[]): Promise<boolean>;
  /** A new code for one person, with what Quest knows of them from where they met (the thread, the message). */
  mint(note: string): Promise<string | null>;
  /** The note on the code they came in with; null when none. */
  noteOf(customerId: CustomerId): Promise<string | null>;
}

/* ------------------------------------------------------------ transcript */

export interface TranscriptEntry {
  readonly direction: "in" | "out";
  readonly text: string;
  readonly at: Date;
  /** The channel's id for the message, when it has one. */
  readonly ref?: string | null;
  /** On one of their messages: the reaction Quest put on it. */
  readonly reaction?: string | null;
}

/** The conversation as it happened, both ways. The record reports are built from. */
export interface Transcript {
  /** Returns false when this message was already recorded (a channel redelivery). */
  recordIncoming(customerId: CustomerId, channel: ChannelKind, ref: string, text: string): Promise<boolean>;
  recordOutgoing(customerId: CustomerId, channel: ChannelKind, ref: string | null, text: string): Promise<void>;
  /** Notes the reaction Quest put on one of their messages. */
  recordReaction(customerId: CustomerId, channel: ChannelKind, ref: string, emoji: string): Promise<void>;
  recent(customerId: CustomerId, limit: number): Promise<TranscriptEntry[]>;
}

/* ----------------------------------------------------------- the manager */

/** Where anything that should wake a customer's manager is put. */
export interface EventSink {
  push(customerId: CustomerId, event: ManagerEvent): Promise<void>;
}

/** The manager's side of the event queue: one customer at a time, under a lease. */
export interface EventInbox {
  /** Leases one customer that has events due and no manager turn running. */
  claimCustomer(worker: string, leaseMs: number): Promise<CustomerId | null>;
  renew(customerId: CustomerId, worker: string, leaseMs: number): Promise<boolean>;
  release(customerId: CustomerId, worker: string): Promise<void>;
  /** The customer's due events, oldest first, marked as being processed. */
  take(customerId: CustomerId, limit: number): Promise<QueuedEvent[]>;
  done(ids: readonly string[]): Promise<void>;
  /** Puts events back for a later try; after `maxAttempts` they are marked failed. */
  retryLater(ids: readonly string[], error: string, delayMs: number, maxAttempts: number): Promise<void>;
  /** A turn stopped for no fault of its own (they switched Quest off): its events wait again, the try not counted. */
  giveBack(ids: readonly string[]): Promise<void>;
}

/** When the manager is woken next to follow up a question the customer has not answered. */
export interface FollowUpSchedule {
  /** Wakes the customer's manager at `at`, replacing the wake set before; null clears it. */
  followUpAt(customerId: CustomerId, at: Date | null): Promise<void>;
}

/** When the manager is woken for something it owes (commitments.ts). */
export interface CommitmentSchedule {
  /** Wakes the customer's manager for this commitment at `at`, replacing the wake set for it before; null clears it. */
  commitmentAt(customerId: CustomerId, commitmentId: string, at: Date | null): Promise<void>;
}

export interface HeartbeatSource {
  /** Queues a heartbeat for every customer whose last one is older than `everyMs`; returns how many. */
  queueDue(everyMs: number): Promise<number>;
  /** Queues the evening report for every customer whose report hour has come today; returns how many. */
  queueDayReports(): Promise<number>;
}

/* ---------------------------------------------------------------- memory */

/** What Quest keeps for good about a customer. */
export interface MemoryRepository {
  /** Adds a memory; `added` is false when the same words are already kept. */
  add(customerId: CustomerId, memory: NewMemory): Promise<{ memory: Memory; added: boolean }>;
  /** Retires a memory that stopped being true; null when there is no such live memory. */
  retire(customerId: CustomerId, id: string): Promise<Memory | null>;
  /** Live memories, newest first. */
  list(customerId: CustomerId, limit: number): Promise<Memory[]>;
}

/** The day as the record has it, for the evening report. */
export interface DayLedger {
  day(customerId: CustomerId, since: Date): Promise<DayFacts>;
}

/** What Quest owes the customer, and the next steps in its conversations, each with a time (commitments.ts). */
export interface CommitmentRepository {
  add(customerId: CustomerId, commitment: NewCommitment, checkAt: Date): Promise<Commitment>;
  get(customerId: CustomerId, id: string): Promise<Commitment | null>;
  /** Open ones, soonest due first. */
  open(customerId: CustomerId): Promise<Commitment[]>;
  /** Settles an open one; null when it is not open. */
  close(customerId: CustomerId, id: string, status: "kept" | "dropped", note: string | null): Promise<Commitment | null>;
  /** A new time for an open one; null when it is not open. */
  move(customerId: CustomerId, id: string, change: { dueAt: Date; checkAt: Date; words: string | null; note: string | null }): Promise<Commitment | null>;
  /** The latest settled ones, newest first. */
  settled(customerId: CustomerId, limit: number): Promise<Commitment[]>;
}

/** What the work came to: people talking, trying, using, paying (results.ts). */
export interface ResultRepository {
  /** `added` is false when that person is already on record at that stage. */
  record(customerId: CustomerId, result: NewResult): Promise<{ entry: ResultEntry; added: boolean }>;
  /** Newest first. */
  list(customerId: CustomerId, limit: number): Promise<ResultEntry[]>;
}

/** The ways Quest goes after results, and how each has gone (routes.ts). */
export interface RouteRepository {
  /** One more try on the route, created on its first. */
  log(customerId: CustomerId, name: string, result: RouteResult, note: string | null): Promise<Route>;
  /** A spent route tried again on new evidence: one more miss spends it again. */
  reopen(customerId: CustomerId, name: string, why: string): Promise<Route | null>;
  get(customerId: CustomerId, name: string): Promise<Route | null>;
  /** Most recently tried first. */
  list(customerId: CustomerId): Promise<Route[]>;
}

/* ----------------------------------------------------------------- tasks */

/** The manager's side of tasks: create, look, steer. */
export interface TaskRepository {
  create(input: NewTask): Promise<Task>;
  get(id: TaskId): Promise<Task | null>;
  listFor(customerId: CustomerId, opts?: { statuses?: readonly TaskStatus[]; limit?: number; light?: boolean }): Promise<Task[]>;
  /** Queues a waiting or finished-waiting task again with what its next run should read. */
  requeue(id: TaskId, input: TaskInput): Promise<Task | null>;
  /** Cancels a queued or waiting task at once; asks a running one to stop. */
  requestCancel(id: TaskId): Promise<Task | null>;
  /** Asks a running task to stop and start over with new instructions. */
  requestInterrupt(id: TaskId, input: TaskInput): Promise<Task | null>;
  /** How long each teammate's runs took since then, over every customer: what Quest's estimates are made from. */
  paces(since: Date): Promise<AgentPace[]>;
}

/** The runner's side of tasks: claim, hold, finish. */
export interface TaskQueue {
  /** The next task by priority, then by time. `solo`: teammates of whom a customer has one at work at a time (those that work in their Chrome). */
  claim(worker: string, leaseMs: number, perCustomer: number, solo?: readonly string[]): Promise<ClaimedTask | null>;
  heartbeat(id: TaskId, worker: string, leaseMs: number): Promise<TaskSignals>;
  finish(id: TaskId, worker: string, outcome: TaskOutcome): Promise<void>;
  /** The task asked a question: it stops holding a worker until the answer comes. Not a failed try. */
  park(id: TaskId, worker: string): Promise<void>;
  /**
   * Gives the task back to the queue, e.g. after an interrupt or a failed try. `clean` is a stop that
   * was not the run's fault (new instructions, a shutdown): the claim it took does not count as a try.
   */
  release(id: TaskId, worker: string, input: TaskInput, delayMs: number, clean?: boolean): Promise<void>;
}

/* ------------------------------------------------------------- questions */

export interface QuestionRepository {
  create(input: NewQuestion): Promise<Question>;
  get(id: QuestionId): Promise<Question | null>;
  listFor(customerId: CustomerId, statuses: readonly QuestionStatus[]): Promise<Question[]>;
  /** Every question the task asked since its run last stopped, answered or not. */
  listForTask(taskId: TaskId, statuses: readonly QuestionStatus[]): Promise<Question[]>;
  findByAskedRef(customerId: CustomerId, ref: string): Promise<Question | null>;
  markAsked(id: QuestionId, ref: string | null): Promise<void>;
  /** Records the answer if the question is still open; returns null if it was not. */
  answer(id: QuestionId, answer: string, by: AnsweredBy): Promise<Question | null>;
  /** Closes the question unasked; the note is what the waiting subagent is told instead of an answer. */
  dismiss(id: QuestionId, note: string): Promise<Question | null>;
  /** Closes every open question of a task (it was cancelled or restarted). */
  closeForTask(id: TaskId): Promise<void>;
}

/* ----------------------------------------------------------------- finds */

export interface FindRepository {
  beginPost(id: FindId, alone?: boolean): Promise<boolean>;
  endPost(id: FindId, uncertain: boolean): Promise<void>;
  /** Replies still claimed as posting (in the repository's lane): at start, ones a stopped machine never finished. */
  leftPosting(): Promise<Find[]>;
  /** Saves a find; null when the customer already has one for the same address. */
  add(input: NewFind): Promise<Find | null>;
  get(id: FindId): Promise<Find | null>;
  /** The customer's finds in these states, newest first. */
  listFor(customerId: CustomerId, statuses: readonly FindStatus[], limit: number): Promise<Find[]>;
  /** The best finds not shown yet: strong before maybe, then the most recent posts. */
  nextToShow(customerId: CustomerId, limit: number): Promise<Find[]>;
  /** Of these addresses, the ones the customer already has a find for. */
  known(customerId: CustomerId, urls: readonly string[]): Promise<Set<string>>;
  markShown(id: FindId, cardRef: string | null): Promise<void>;
  /** Records the customer's decision on a shown find; null if it was not waiting for one. */
  decide(id: FindId, decision: FindDecision): Promise<Find | null>;
  /** Records why a skipped find was skipped; null if it was not skipped. */
  giveReason(id: FindId, reason: SkipReason): Promise<Find | null>;
  /** Records that Quest posted the find's reply (it counts as replied), on a tap or by itself; null if it was already posted. */
  markSent(id: FindId, url: string, account: string, alone?: boolean): Promise<Find | null>;
  /** New words for the reply of a find still on its card and not posted; null otherwise. */
  revise(id: FindId, reply: string): Promise<Find | null>;
  /** The find whose card is this chat message: its card now, an older copy of it, or the question asked under it. */
  byCard(customerId: CustomerId, cardRef: string): Promise<Find | null>;
  /** The card is now this newer message; a reply to the older one still finds it. */
  moveCard(id: FindId, cardRef: string): Promise<void>;
  /** Another message that stands for the card: the "what should change?" asked under it. */
  addRef(id: FindId, ref: string): Promise<void>;
  /** Drops finds the customer has not been shown yet; returns how many went. Shown ones stay theirs to decide. */
  dropWaiting(customerId: CustomerId, ids: readonly FindId[]): Promise<number>;
  /** How many replies Quest has posted for the customer since then. */
  sentSince(customerId: CustomerId, since: Date): Promise<number>;
  /** Posted replies due another look (in the repository's lane), the longest waiting first. */
  /** Due looks, first looks first. `only`: of these customers (the ones whose Chrome is open), so nobody else's fill the limit. */
  dueWatches(now: Date, limit: number, only?: readonly CustomerId[]): Promise<WatchedFind[]>;
  /** When to look at a posted reply next (null: never again), after how many looks, and which answers were told. */
  watch(id: FindId, next: Date | null, checks: number, seen: readonly string[]): Promise<void>;
  /** The answers told for each of the customer's posted replies, with where each reply went. */
  toldAnswers(customerId: CustomerId): Promise<ToldAnswers[]>;
  counts(customerId: CustomerId): Promise<FindCounts>;
}

/* ------------------------------------------------------- ideas and assets */

/** What they share for their posts (ideas.ts). */
export interface AssetRepository {
  add(input: NewAsset): Promise<Asset>;
  get(id: string): Promise<Asset | null>;
  /** Theirs, not dropped, newest first. */
  list(customerId: CustomerId, limit: number): Promise<Asset[]>;
  /** False when it is not theirs, or already dropped. */
  drop(customerId: CustomerId, id: string): Promise<boolean>;
  /** What a video says and shows, once it has been read. */
  setReading(id: string, reading: ClipReading): Promise<void>;
}

/** Ideas for posts, theirs and Quest's (ideas.ts). */
export interface IdeaRepository {
  add(input: NewIdea, status: IdeaStatus): Promise<Idea>;
  get(id: string): Promise<Idea | null>;
  /** Newest first. */
  list(customerId: CustomerId, limit: number): Promise<Idea[]>;
  /** Moves it on (and names the draft made from it); null when it is not theirs. */
  decide(customerId: CustomerId, id: string, status: IdeaStatus, draftId?: string | null): Promise<Idea | null>;
  markShown(id: string, cardRef: string | null): Promise<void>;
}

/* ---------------------------------------------------------------- drafts */

/** What Quest wrote for the customer to post as themselves. */
export interface DraftRepository {
  add(input: NewDraft): Promise<Draft>;
  get(id: DraftId): Promise<Draft | null>;
  markShown(id: DraftId, cardRef: string | null): Promise<void>;
  /** Durable claim before sending. A crashed send stays held rather than being resent. */
  beginPost(id: DraftId, alone?: boolean): Promise<boolean>;
  /** A known failure before submission reopens; an ambiguous result stays held. */
  endPost(id: DraftId, uncertain: boolean): Promise<void>;
  /** Drafts still claimed as posting (in the repository's lane): at start, ones a stopped machine never finished. */
  leftPosting(): Promise<Draft[]>;
  /** Closes an open draft unposted; null if it was not open. */
  skip(id: DraftId, answered?: boolean): Promise<Draft | null>;
  /** Records that it went up, on their tap or by itself, where and as whom; null if it was not open. */
  markSent(id: DraftId, url: string, account: string, alone?: boolean): Promise<Draft | null>;
  /** New words (and title) for a draft still open; null otherwise. */
  revise(id: DraftId, text: string, title: string | null): Promise<Draft | null>;
  /** The draft whose card is this chat message: its card now, an older copy of it, or the question asked under it. */
  byCard(customerId: CustomerId, cardRef: string): Promise<Draft | null>;
  /** The card is now this newer message; a reply to the older one still finds it. */
  moveCard(id: DraftId, cardRef: string): Promise<void>;
  /** Another message that stands for the card: the "what should change?" asked under it. */
  addRef(id: DraftId, ref: string): Promise<void>;
  /** How many drafts went up for the customer since then. */
  sentSince(customerId: CustomerId, since: Date): Promise<number>;
  /** The customer's latest drafts, open or not, newest first. */
  recent(customerId: CustomerId, limit: number): Promise<Draft[]>;
  /** Posted drafts due another look for answers (in the repository's lane), the longest waiting first. */
  dueWatches(now: Date, limit: number, only?: readonly CustomerId[]): Promise<WatchedDraft[]>;
  /** When to look at a posted draft next (null: never again), after how many looks, and which answers were told. */
  watch(id: DraftId, next: Date | null, checks: number, seen: readonly string[]): Promise<void>;
  /** The answers told for each of the customer's posted drafts, with where each went. */
  toldAnswers(customerId: CustomerId): Promise<ToldAnswers[]>;
  /** The last two weeks' drafts to one person (target or author, bare handle) or at one of `urls`: what passed with them, beyond `recent`'s window. */
  withPerson?(customerId: CustomerId, person: string, urls: readonly string[]): Promise<Draft[]>;
  /** Their replies on a platform that went up, may have, are going up or were stopped as answered, at an address or to a person, whatever their age. */
  repliesTo?(customerId: CustomerId, platform: string, url: string, target: string | null): Promise<Draft[]>;
}

/* ----------------------------------------------------------------- trust */

/** Posts the customer approved on each platform (trust.ts). */
export interface TrustRepository {
  /** Go ahead on every platform (*), unless they already chose; onboarding no longer does this (trust.ts). */
  initialize(customerId: CustomerId): Promise<void>;
  approved(customerId: CustomerId, platform: string): Promise<number>;
  /** One more post they approved there; the new count. */
  approve(customerId: CustomerId, platform: string): Promise<number>;
  /** 0 when a reply was taken down there or they want to be asked again; TRUST_AFTER when they say to go ahead. */
  set(customerId: CustomerId, platform: string, approved: number, explicit?: boolean): Promise<void>;
  /** Whether Quest does that kind there by itself: they said yes to it, or "go ahead", and not "ask me first" since. */
  alone(customerId: CustomerId, platform: string): Promise<boolean>;
  /** The kinds Quest has earned and offers to do alone, waiting on their yes (a trust key each: "x.com", "x.com likes"). */
  offered(customerId: CustomerId): Promise<string[]>;
  /** Their answer to the offer: yes, Quest does it alone; no, it asks again after TRUST_AFTER more. */
  answer(customerId: CustomerId, platform: string, yes: boolean): Promise<void>;
}

/** The people Quest got to know for a customer (contacts.ts). */
export interface ContactRepository {
  get(customerId: CustomerId, key: string): Promise<Contact | null>;
  /** The newest first. */
  list(customerId: CustomerId, limit: number): Promise<Contact[]>;
  /** A check kept: a new contact, or the one there with what this check found. */
  keep(customerId: CustomerId, check: ContactCheck): Promise<Contact>;
}

/** Every model call's tokens and cost, to see where the money goes. Never shown to the customer. */
export interface SpendLog {
  /** Best effort: a lost row never fails the call it describes. */
  record(call: ModelCall): void;
}

/** Each day's budget and the credits they buy: what a customer spent since their midnight, their rest, their wallet. */
export interface BillingRepository {
  /** What they spent since `since` (their midnight), their credits, and the rest they are on, in one read. */
  day(customerId: CustomerId, since: Date): Promise<DaySpend>;
  /** Starts a rest until `until`, unless one runs already; true when this call started it. */
  rest(customerId: CustomerId, until: Date): Promise<boolean>;
  /** Ends their rest at once (they bought more). */
  endRest(customerId: CustomerId): Promise<void>;
  /** Draws what their model calls cost up to `upTo` from their credits, each call once and never below zero. Nothing without a wallet. */
  draw(customerId: CustomerId, upTo: Date): Promise<void>;
  /** Lets someone new in on `usd` of free credits, once ever (an invite or a start before lets them in with none); true when this let them in. */
  startFree(customerId: CustomerId, usd: number): Promise<boolean>;
  /**
   * Credits a pack paid for, once per Checkout session: `bonus` comes with their very first top-up, and someone who
   * waits is let in. Null when this session was counted already.
   */
  topUp(t: TopUp): Promise<ToppedUp | null>;
}

/* ---------------------------------------------------------------- places */

/** Where a customer's people ask, and what each place's rules allow. */
export interface PlaceRepository {
  /** Adds the place, or updates the one filed under the same key; `added` is false for an update. */
  save(place: NewPlace): Promise<{ readonly place: Place; readonly added: boolean }>;
  /** The customer's places, most recently found first. */
  listFor(customerId: CustomerId): Promise<Place[]>;
}

/* -------------------------------------------------------------- channels */

export interface OutgoingQuestion {
  readonly id: QuestionId;
  readonly text: string;
  readonly options: readonly string[];
}

/** One chat surface (Telegram, the web chat). Returns the channel's message ref when it has one. */
export interface ChatChannel {
  readonly kind: ChannelKind;
  /** `answers`: a few likely answers to what it asks, offered in place of their keyboard; a tap sends one as their message. */
  sendText(to: ChannelAddress, text: string, answers?: readonly string[]): Promise<string | null>;
  /** New words on a message Quest sent (a line kept up to date as work goes); false when that message is gone. */
  editText(to: ChannelAddress, ref: string, text: string): Promise<boolean>;
  sendQuestion(to: ChannelAddress, question: OutgoingQuestion): Promise<string | null>;
  /** Shows the chosen answer on the message that asked, and removes its buttons. */
  showAnswer(to: ChannelAddress, ref: string, question: OutgoingQuestion, answer: string): Promise<void>;
  acknowledge(ackRef: string, text?: string): Promise<void>;
  showTyping(to: ChannelAddress): Promise<void>;
  /** Puts one emoji reaction on one of their messages, replacing any Quest put there before. */
  react(to: ChannelAddress, ref: string, emoji: string): Promise<void>;
  /** A find as a card: the post, why it fits, the reply, and the buttons its state calls for. */
  sendFind(to: ChannelAddress, find: Find): Promise<string | null>;
  /** Redraws a find's card after a decision. */
  updateFind(to: ChannelAddress, ref: string, find: Find): Promise<void>;
  /** A draft as a card: whose words it answers, the draft, and Post it / Skip while it is open. */
  sendDraft(to: ChannelAddress, draft: Draft): Promise<string | null>;
  /** Redraws a draft's card once it is posted or skipped. */
  updateDraft(to: ChannelAddress, ref: string, draft: Draft): Promise<void>;
  /** Asks under a card what should change in it, with their reply box open on the question; the question's ref. */
  askEdit(to: ChannelAddress, cardRef: string, text: string): Promise<string | null>;
  /** Takes the buttons off an older copy of a card, once a newer one is in the chat. */
  closeCard(to: ChannelAddress, ref: string): Promise<void>;
  /** One of Quest's ideas for a post, as a card: Write it, Not this one. Returns its ref. */
  sendIdea(to: ChannelAddress, idea: Idea): Promise<string | null>;
  /** The idea's card once they answered it: what they chose, no buttons. */
  showIdeaDecided(to: ChannelAddress, ref: string, idea: Idea): Promise<void>;
  /** A message with one button that switches Quest on (`on`) or off. */
  sendSwitch(to: ChannelAddress, text: string, on: boolean): Promise<string | null>;
  /**
   * The switch's messages here (`refs`, its last and a pinned one), redrawn to say how things stand now, so a switch
   * made elsewhere (the panel, the Mini App) never leaves an old button here.
   */
  redrawSwitch?(to: ChannelAddress, refs: readonly string[], text: string, on: boolean): Promise<void>;
  /** A message with buttons that open web pages (the Chrome setup). */
  sendLinks(to: ChannelAddress, text: string, links: readonly OutgoingLink[]): Promise<string | null>;
  /** The language choice, the first thing someone new sees: `detected` (their Telegram's) first, a button each. */
  sendLanguageChoice(to: ChannelAddress, detected: string): Promise<string | null>;
  /** Shows the language chosen on the choice, and removes its buttons. */
  showLanguageChosen(to: ChannelAddress, ref: string, locale: string): Promise<void>;
  /** A file the person sent, by the ref its message carried. */
  download(fileRef: string): Promise<Uint8Array>;
  /** A JPEG as a silent message, with a short caption (or none); the ref it can be replaced by. */
  sendPhoto(to: ChannelAddress, jpeg: Uint8Array, caption: string | null): Promise<string | null>;
  /**
   * The Quest button by the message box, which opens their own page (task-board.ts): `label` while work runs
   * ("2 working"), its usual name for null. False when the channel has no such button.
   */
  showWork(to: ChannelAddress, label: string | null): Promise<boolean>;
  /** Unpins a progress board an older version pinned and takes it out of the chat. */
  removeBoard(to: ChannelAddress, ref: string): Promise<void>;
  /**
   * The deck (Your move): sent anew when `ref` is null, else redrawn in place. Returns its ref, or null when the
   * message to redraw is gone. `silent`: sent without a notification.
   */
  showDeck(to: ChannelAddress, ref: string | null, view: DeckView, opts?: { readonly silent?: boolean }): Promise<string | null>;
  /** Takes one of Quest's messages out of the chat (a deck sent again further down); only its buttons, where it is too old to go. */
  removeMessage(to: ChannelAddress, ref: string): Promise<void>;
}

/** Where each customer's deck is (asks/deck.ts). */
export interface DeckStore {
  get(customerId: CustomerId): Promise<DeckState | null>;
  save(customerId: CustomerId, state: DeckState): Promise<void>;
}

export interface OutgoingLink {
  readonly label: string;
  readonly url: string;
  /** Opens inside the chat as a Mini App (their page), where the channel has one; a plain link where it has not. */
  readonly app?: boolean;
}

/**
 * Where a customer's work shows in their chat, kept so a restart puts it right: `WORK_BUTTON` while their Quest
 * button says work runs; any other ref is a progress board an older version pinned, taken down at start.
 */
export interface PinnedBoard {
  readonly to: ChannelAddress;
  readonly ref: string;
}

/** The ref kept while a customer's Quest button shows work running. */
export const WORK_BUTTON = "menu";

/** The chats showing work now, one per customer at most. */
export interface BoardRepository {
  get(customerId: CustomerId): Promise<PinnedBoard | null>;
  save(customerId: CustomerId, board: PinnedBoard): Promise<void>;
  /** Forgets the board, if it is still this one. */
  clear(customerId: CustomerId, ref: string): Promise<void>;
  /** Every board up (in the repository's lane), for the agent to tidy after a restart. */
  list(): Promise<{ readonly customerId: CustomerId; readonly board: PinnedBoard }[]>;
}

/* ------------------------------------------------------------ searches */

/** One search a run made, and how many of the people it saved or wrote to came from it. */
export interface SearchRun {
  /** Where it ran: a host ("x.com", "reddit.com"), or "web" for a web search. */
  readonly site: string;
  /** Its words; the search page's address when it ran in the browser. */
  readonly query: string;
  /** Finds saved and messages drafted from what it turned up. */
  readonly hits: number;
}

export interface SearchRecord extends SearchRun {
  readonly agent: string;
  readonly at: Date;
}

/** What each customer's searches came to, so a run starts with the ones that found people. */
export interface SearchLog {
  record(customerId: CustomerId, taskId: TaskId, agent: string, runs: readonly SearchRun[]): Promise<void>;
  /** The searches of the last `days`, newest first; only those on `site` when it is given. */
  recent(customerId: CustomerId, opts: { readonly site?: string | null; readonly days: number; readonly limit: number }): Promise<SearchRecord[]>;
}

/* ---------------------------------------------------------------- speech */

/** How a recording is encoded, in the words speech-to-text services use. A Telegram voice message is `ogg` (Opus). */
export type AudioFormat = "ogg" | "mp3" | "m4a" | "wav" | "flac" | "aac" | "webm";

/** What was said in a recording, and when: each word with where it starts and ends. */
export interface TimedSpeech {
  readonly text: string;
  readonly language: string | null;
  readonly seconds: number;
  readonly words: readonly ClipWord[];
}

/** Speech to text, for what people say rather than type. */
export interface Transcriber {
  /** The words in a recording; "" when nobody speaks in it. Throws when it could not be heard. */
  transcribe(audio: Uint8Array, format: AudioFormat, customerId: CustomerId | null): Promise<string>;
  /** The same with each word's time, for captions and cuts; the words are empty when nobody speaks. Throws when it could not be heard. */
  timed(audio: Uint8Array, format: AudioFormat, customerId: CustomerId | null): Promise<TimedSpeech>;
}

/* --------------------------------------------------------------- reading */

/** A web browser, as the agents see it: the customer's Chrome. */
export interface PageReader {
  /**
   * `asVisitor`: read as someone who is not logged in, to see what others see of the customer's own posts; `check`: such a
   * look, on its own allowance; `drawn`: a page whose words show only while Chrome draws it (their notifications on X).
   */
  readPage(url: string, opts?: { asVisitor?: boolean; check?: boolean; drawn?: boolean }): Promise<PageText>;
  readSite(url: string, opts?: { pages?: number }): Promise<SiteRead>;
}

/* -------------------------------------------------------------- sleeping */

/** When queued work next falls due, so an idle agent knows whether it may sleep. */
export interface WorkSchedule {
  /** The earliest time any queued work is due (a turn, a task, a heartbeat); null when there is none. */
  nextWorkAt(): Promise<Date | null>;
}

/** The machine the agent runs on, as far as sleeping goes. */
export interface MachinePower {
  /** False where the agent cannot sleep (a laptop, a test run). */
  readonly canSleep: boolean;
  /** Suspends this machine. It resumes when the next request reaches it. */
  suspend(): Promise<void>;
}

/* ----------------------------------------------------------- searching */

/**
 * Public communities searched through their own APIs: no browser, no bot check,
 * and each source answers as itself allows.
 */
export interface PostSearch {
  sources(): readonly SourceInfo[];
  search(query: PostQuery): Promise<FoundPost[]>;
}

/* ------------------------------------------------------ the customer's Chrome */

/**
 * Connected Chromes. A customer connects one by opening a one-time code from
 * the chat; the extension then holds a token, stored here only as its hash.
 * One Chrome per customer: connecting another disconnects the old one.
 */
export interface ChromeLinkRepository {
  /** Records a one-time code (its hash), replacing the customer's earlier unused ones. */
  offer(customerId: CustomerId, codeHash: string, expiresAt: Date): Promise<void>;
  /** When the customer's latest unused code was made, expired or not; null once it is used. */
  lastOffer(customerId: CustomerId): Promise<Date | null>;
  /** Trades a valid code for a connection holding the token (its hash); null when the code is unknown, used or expired. */
  redeem(codeHash: string, tokenHash: string, device: string | null, now: Date): Promise<ChromeLink | null>;
  byToken(tokenHash: string): Promise<ChromeLink | null>;
  active(customerId: CustomerId): Promise<ChromeLink | null>;
  seen(linkId: string, at: Date): Promise<void>;
  /** Disconnects; returns the connection that was closed. */
  revoke(linkId: string, at: Date): Promise<ChromeLink | null>;
}

/** Posts a reply from the customer's own account, in their own Chrome: only ever for their tap on "Post it". */
export interface ReplyPoster {
  /**
   * `signal`: the agent is stopping. A post stopped before it was sent fails as `unavailable` (nothing went out), one
   * stopped once it may have been sent as `uncertain`.
   */
  post(customerId: CustomerId, post: ChromePost, signal?: AbortSignal): Promise<ChromePosted>;
}

/** What a customer's team reads and searches the web with. */
export interface WebReach {
  forCustomer(customerId: CustomerId): { readonly reader: PageReader; readonly posts: PostSearch };
}
