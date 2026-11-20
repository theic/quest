/**
 * In-memory implementations of the ports, with the same semantics as the Postgres
 * adapters (leases, claims, idempotent inserts), so services are tested as they run.
 */
import { priorityOf } from "@mq/core";
import { randomUUID } from "node:crypto";
import {
  everywhere,
  askedFields,
  ChromeError,
  CONTACT_NOTES,
  contactKey,
  customerId as toCustomerId,
  draftId as toDraftId,
  findId as toFindId,
  questionId as toQuestionId,
  taskId as toTaskId,
  type AnsweredBy,
  type Asset,
  type AssetRepository,
  type ClipReading,
  type Idea,
  type IdeaRepository,
  type IdeaStatus,
  type NewAsset,
  type NewIdea,
  type BillingRepository,
  type DaySpend,
  type ToppedUp,
  type TopUp,
  type Wallet,
  type BoardRepository,
  type DeckState,
  type DeckStore,
  type DeckView,
  type PinnedBoard,
  type SearchLog,
  type SearchRecord,
  type SearchRun,
  type ChannelAddress,
  type ChannelKind,
  type ChatChannel,
  type ChromeFailure,
  type ChromePost,
  type ChromePosted,
  type ClaimedTask,
  type Customer,
  type CustomerId,
  type CustomerPatch,
  type CustomerRepository,
  type InviteRepository,
  type Draft,
  type DraftId,
  type DraftRepository,
  type NewDraft,
  type NewOutboxItem,
  type OutboxApproval,
  type OutboxItem,
  type OutboxRef,
  type OutboxRepository,
  type ToldAnswers,
  type WatchedDraft,
  type EventInbox,
  type EventSink,
  type Find,
  type FindCounts,
  type FindDecision,
  type FindId,
  type FindRepository,
  type TrustRepository,
  type Contact,
  type ContactCheck,
  type ContactRepository,
  type FindStatus,
  type NewFind,
  type NewPlace,
  type Place,
  type PlaceRepository,
  type ReplyPoster,
  type SkipReason,
  type WatchedFind,
  type FollowUpSchedule,
  type HeartbeatSource,
  type ManagerEvent,
  type NewCustomer,
  type NewQuestion,
  type NewTask,
  type OutgoingQuestion,
  type FoundPost,
  type PageReader,
  type PageText,
  type PostQuery,
  type PostSearch,
  type QueuedEvent,
  type Question,
  type QuestionId,
  type QuestionRepository,
  type QuestionStatus,
  type SiteRead,
  type SourceInfo,
  type Task,
  type TaskId,
  type TaskInput,
  type TaskOutcome,
  type TaskQueue,
  type TaskRepository,
  type TaskSignals,
  type TaskStatus,
  type Transcript,
  type TranscriptEntry,
  type ChromeLink,
  type ChromeLinkRepository,
  type ChromeStatus,
  type OutgoingLink,
  type WebReach,
  type DayFacts,
  type DayLedger,
  type Memory,
  type MemoryRepository,
  type NewMemory,
  type AskedWith,
  type IntakeOption,
  type Scene,
  type Reflection,
  type ProfileAnswer,
  type ModelCall,
  type SpendLog,
  type AudioFormat,
  type TimedSpeech,
  type Transcriber,
  afterTry,
  routeKey,
  SPENT_AFTER,
  type AgentPace,
  type Commitment,
  type CommitmentRepository,
  type CommitmentSchedule,
  type NewCommitment,
  type NewResult,
  type ResultEntry,
  type ResultRepository,
  type Route,
  type RouteRepository,
  type RouteResult,
} from "@mq/core";
import type { OfferOutcome } from "../src/chrome/link-service.ts";

export class FakeClock {
  t = Date.parse("2026-09-25T12:00:00Z");
  now = (): Date => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
}

/** mq.invites: a code is matched in any case, and one use lets one person in who waits. */
export class MemoryInvites implements InviteRepository {
  readonly invites = new Map<string, number>();
  readonly #customers: MemoryCustomers;

  constructor(customers: MemoryCustomers) {
    this.#customers = customers;
  }

  add(code: string, uses = 1): void {
    this.invites.set(code, uses);
  }

  async redeem(customerId: CustomerId, codes: readonly string[]): Promise<boolean> {
    const wanted = new Set(codes.map((c) => c.toLowerCase()));
    const code = [...this.invites.keys()].find((c) => wanted.has(c.toLowerCase()) && this.invites.get(c)! > 0);
    const c = await this.#customers.get(customerId);
    if (!code || c.activatedAt) return false;
    this.invites.set(code, this.invites.get(code)! - 1);
    await this.#customers.update(customerId, { activatedAt: new Date() });
    return true;
  }

  readonly notes = new Map<string, string>();

  async mint(note: string): Promise<string | null> {
    const code = `C${this.invites.size + 1}XYZW`;
    this.invites.set(code, 1);
    this.notes.set(code, note);
    return code;
  }

  async noteOf(): Promise<string | null> {
    return null;
  }
}

export class MemoryCustomers implements CustomerRepository {
  readonly customers = new Map<string, Customer>();
  readonly channels: { customerId: CustomerId; address: ChannelAddress; seen: number }[] = [];
  #seen = 0;

  async findByChannel(address: ChannelAddress): Promise<Customer | null> {
    const ch = this.channels.find((c) => c.address.kind === address.kind && c.address.address === address.address);
    return ch ? (this.customers.get(ch.customerId) ?? null) : null;
  }

  async create(input: NewCustomer): Promise<Customer> {
    const existing = await this.findByChannel(input.channel);
    if (existing) return existing;
    const c: Customer = {
      id: toCustomerId(randomUUID()),
      displayName: input.displayName,
      language: input.language,
      siteUrl: null,
      brief: null,
      status: "onboarding",
      plan: null,
      timezone: null,
      reportHour: 20,
      profile: {},
      chromeFront: true,
      offAt: null,
      sweptAt: null,
      activatedAt: null,
      createdAt: new Date(),
    };
    this.customers.set(c.id, c);
    this.channels.push({ customerId: c.id, address: input.channel, seen: ++this.#seen });
    return c;
  }

  async get(id: CustomerId): Promise<Customer> {
    const c = this.customers.get(id);
    if (!c) throw new Error(`no customer ${id}`);
    return c;
  }

  // Read and write with no await between them, like one UPDATE: the manager runs tools in parallel,
  // and save_brief beside write_plan used to lose the brief to the other's stale copy.
  #now(id: CustomerId): Customer {
    const c = this.customers.get(id);
    if (!c) throw new Error(`no customer ${id}`);
    return c;
  }

  async update(id: CustomerId, patch: CustomerPatch): Promise<void> {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    this.customers.set(id, { ...this.#now(id), ...defined });
  }

  async markSeen(address: ChannelAddress): Promise<void> {
    const ch = this.channels.find((c) => c.address.kind === address.kind && c.address.address === address.address);
    if (ch) ch.seen = ++this.#seen;
  }

  async switchedOff(): Promise<CustomerId[]> {
    return [...this.customers.values()].filter((c) => c.offAt).map((c) => c.id);
  }

  async chats(kind: ChannelKind): Promise<ChannelAddress[]> {
    return this.channels.filter((c) => c.address.kind === kind).map((c) => c.address);
  }

  async channelOf(id: CustomerId, kind: ChannelKind): Promise<ChannelAddress | null> {
    return this.channels.find((c) => c.customerId === id && c.address.kind === kind)?.address ?? null;
  }

  async bindChannel(id: CustomerId, address: ChannelAddress): Promise<void> {
    if (!this.channels.some((c) => c.address.kind === address.kind && c.address.address === address.address)) this.channels.push({ customerId: id, address, seen: 0 });
  }

  async primaryChannel(id: CustomerId): Promise<ChannelAddress | null> {
    const mine = this.channels.filter((c) => c.customerId === id).sort((a, b) => b.seen - a.seen);
    return mine[0]?.address ?? null;
  }

  async profileAsked(id: CustomerId, key: string, ref: string | null, at: Date, asked: AskedWith = {}): Promise<void> {
    const c = this.#now(id);
    this.customers.set(id, { ...c, profile: { ...c.profile, [key]: { askedAt: at, ref, answeredAt: null, choice: null, answer: null, ...askedFields(asked) } } });
  }

  async profileAnswered(id: CustomerId, key: string, a: ProfileAnswer): Promise<boolean> {
    const c = this.#now(id);
    const e = c.profile[key];
    if (!e || e.answeredAt) return false;
    this.customers.set(id, { ...c, profile: { ...c.profile, [key]: { ...e, answeredAt: a.at, choice: a.choice, answer: a.answer, ...(a.spoken ? { spoken: true } : {}) } } });
    return true;
  }
}

export class MemoryTranscript implements Transcript {
  readonly entries: { customerId: CustomerId; direction: "in" | "out"; channel: ChannelKind; ref: string | null; text: string; at: number; reaction?: string }[] = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async recordIncoming(customerId: CustomerId, channel: ChannelKind, ref: string, text: string): Promise<boolean> {
    if (this.entries.some((e) => e.direction === "in" && e.customerId === customerId && e.channel === channel && e.ref === ref)) return false;
    this.entries.push({ customerId, direction: "in", channel, ref, text, at: this.#now() });
    return true;
  }

  async recordOutgoing(customerId: CustomerId, channel: ChannelKind, ref: string | null, text: string): Promise<void> {
    this.entries.push({ customerId, direction: "out", channel, ref, text, at: this.#now() });
  }

  async recordReaction(customerId: CustomerId, channel: ChannelKind, ref: string, emoji: string): Promise<void> {
    const e = this.entries.find((x) => x.customerId === customerId && x.channel === channel && x.ref === ref && x.direction === "in");
    if (e) e.reaction = emoji;
  }

  async recent(customerId: CustomerId, limit: number): Promise<TranscriptEntry[]> {
    return this.entries
      .filter((e) => e.customerId === customerId)
      .slice(-limit)
      .map((e) => ({ direction: e.direction, text: e.text, at: new Date(e.at), ref: e.ref, reaction: e.reaction ?? null }));
  }
}

interface EventRec {
  id: string;
  customerId: CustomerId;
  event: ManagerEvent;
  status: "pending" | "processing" | "done" | "failed";
  attempts: number;
  availableAt: number;
  createdAt: Date;
}

export class MemoryEvents implements EventSink, EventInbox, HeartbeatSource, FollowUpSchedule, CommitmentSchedule {
  readonly events: EventRec[] = [];
  readonly leases = new Map<string, { worker: string; until: number }>();
  #id = 0;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async push(customerId: CustomerId, event: ManagerEvent): Promise<void> {
    this.events.push({ id: String(++this.#id), customerId, event, status: "pending", attempts: 0, availableAt: this.#now(), createdAt: new Date(this.#now()) });
  }

  kinds(customerId?: CustomerId): string[] {
    return this.events.filter((e) => !customerId || e.customerId === customerId).map((e) => e.event.kind);
  }

  /** When a customer rests until (ms), as mq.customers.rest_until: their events wait, but the evening report. */
  restOf: (customerId: CustomerId) => number | null = () => null;
  /** Whether a customer switched Quest off, as mq.customers.off_at: all their events wait. */
  offOf: (customerId: CustomerId) => boolean = () => false;

  #due(e: EventRec): boolean {
    const rest = this.restOf(e.customerId);
    const awake = rest === null || rest <= this.#now() || e.event.kind === "day_report";
    const theirs = e.event.kind === "user_message" || e.event.kind === "question_answered";
    return (!this.offOf(e.customerId) || theirs) && (e.status === "processing" || (e.status === "pending" && e.availableAt <= this.#now() && awake));
  }

  async claimCustomer(worker: string, leaseMs: number): Promise<CustomerId | null> {
    for (const e of this.events) {
      if (!this.#due(e)) continue;
      const lease = this.leases.get(e.customerId);
      if (lease && lease.until >= this.#now()) continue;
      this.leases.set(e.customerId, { worker, until: this.#now() + leaseMs });
      return e.customerId;
    }
    return null;
  }

  async renew(customerId: CustomerId, worker: string, leaseMs: number): Promise<boolean> {
    const lease = this.leases.get(customerId);
    if (!lease || lease.worker !== worker) return false;
    lease.until = this.#now() + leaseMs;
    return true;
  }

  async release(customerId: CustomerId, worker: string): Promise<void> {
    if (this.leases.get(customerId)?.worker === worker) this.leases.delete(customerId);
  }

  async take(customerId: CustomerId, limit: number): Promise<QueuedEvent[]> {
    const due = this.events.filter((e) => e.customerId === customerId && this.#due(e)).slice(0, limit);
    for (const e of due) {
      e.status = "processing";
      e.attempts++;
    }
    return due.map((e) => ({ id: e.id, customerId: e.customerId, event: e.event, attempts: e.attempts, createdAt: e.createdAt }));
  }

  async done(ids: readonly string[]): Promise<void> {
    for (const e of this.events) if (ids.includes(e.id)) e.status = "done";
  }

  async retryLater(ids: readonly string[], _error: string, delayMs: number, maxAttempts: number): Promise<void> {
    for (const e of this.events) {
      if (!ids.includes(e.id)) continue;
      e.status = e.attempts >= maxAttempts ? "failed" : "pending";
      e.availableAt = this.#now() + delayMs;
    }
  }

  async giveBack(ids: readonly string[]): Promise<void> {
    for (const e of this.events) {
      if (!ids.includes(e.id) || e.status !== "processing") continue;
      e.status = "pending";
      e.attempts = Math.max(0, e.attempts - 1);
    }
  }

  async followUpAt(customerId: CustomerId, at: Date | null): Promise<void> {
    for (const e of this.events) if (e.customerId === customerId && e.event.kind === "follow_up" && e.status === "pending") e.status = "done";
    if (at) this.events.push({ id: String(++this.#id), customerId, event: { kind: "follow_up" }, status: "pending", attempts: 0, availableAt: at.getTime(), createdAt: new Date(this.#now()) });
  }

  async commitmentAt(customerId: CustomerId, commitmentId: string, at: Date | null): Promise<void> {
    const mine = (e: EventRec): boolean =>
      e.customerId === customerId && e.event.kind === "commitment_due" && e.event.commitmentId === commitmentId && e.status === "pending";
    if (at && this.events.some((e) => mine(e) && e.availableAt === at.getTime())) return;
    for (const e of this.events) if (mine(e)) e.status = "done";
    if (at) this.events.push({ id: String(++this.#id), customerId, event: { kind: "commitment_due", commitmentId }, status: "pending", attempts: 0, availableAt: at.getTime(), createdAt: new Date(this.#now()) });
  }

  /** When a commitment's wake is set for, if one is. */
  commitmentWake(customerId: CustomerId, commitmentId: string): Date | null {
    const e = this.events.find((x) => x.customerId === customerId && x.event.kind === "commitment_due" && x.event.commitmentId === commitmentId && x.status === "pending");
    return e ? new Date(e.availableAt) : null;
  }

  /** When the next follow-up falls due, if one is set. */
  followUpDue(customerId: CustomerId): Date | null {
    const e = this.events.find((x) => x.customerId === customerId && x.event.kind === "follow_up" && x.status === "pending");
    return e ? new Date(e.availableAt) : null;
  }

  async queueDue(): Promise<number> {
    return 0;
  }

  async queueDayReports(): Promise<number> {
    return 0;
  }
}

interface TaskRec {
  task: Task;
  worker: string | null;
  leaseUntil: number;
  availableAt: number;
  priority: number;
}

export class MemoryTasks implements TaskRepository, TaskQueue {
  readonly recs = new Map<string, TaskRec>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** When a customer rests until (ms), as mq.customers.rest_until: nothing of theirs is claimed meanwhile. */
  restOf: (customerId: CustomerId) => number | null = () => null;
  /** Whether a customer switched Quest off, as mq.customers.off_at: nothing of theirs is claimed meanwhile. */
  offOf: (customerId: CustomerId) => boolean = () => false;

  #set(id: string, patch: Partial<Task>, rec: Partial<Omit<TaskRec, "task">> = {}): Task {
    const r = this.recs.get(id);
    if (!r) throw new Error(`no task ${id}`);
    r.task = { ...r.task, ...patch, updatedAt: new Date(this.#now()) };
    Object.assign(r, rec);
    return r.task;
  }

  async create(input: NewTask): Promise<Task> {
    const now = new Date(this.#now());
    const task: Task = {
      id: toTaskId(randomUUID()),
      customerId: input.customerId,
      agent: input.agent,
      title: input.title,
      instructions: input.instructions,
      site: input.site ?? null,
      status: "queued",
      nextInput: { kind: "start" },
      result: null,
      error: null,
      attempts: 0,
      cancelRequested: false,
      interruptRequested: false,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    this.recs.set(task.id, { task, worker: null, leaseUntil: 0, availableAt: this.#now(), priority: input.priority ?? priorityOf(input.title) });
    return task;
  }

  async get(id: TaskId): Promise<Task | null> {
    return this.recs.get(id)?.task ?? null;
  }

  /** Set by a test: how long each teammate's runs take. */
  pace: AgentPace[] = [];

  async paces(): Promise<AgentPace[]> {
    return this.pace;
  }

  async listFor(customerId: CustomerId, opts: { statuses?: readonly TaskStatus[]; limit?: number } = {}): Promise<Task[]> {
    return [...this.recs.values()]
      .map((r) => r.task)
      .filter((t) => t.customerId === customerId && (!opts.statuses || opts.statuses.includes(t.status)))
      .reverse()
      .slice(0, opts.limit ?? 50);
  }

  async requeue(id: TaskId, input: TaskInput): Promise<Task | null> {
    const r = this.recs.get(id);
    if (!r || r.task.status !== "waiting") return null;
    return this.#set(id, { status: "queued", nextInput: input }, { availableAt: this.#now() });
  }

  async requestCancel(id: TaskId): Promise<Task | null> {
    const r = this.recs.get(id);
    if (!r || !["queued", "running", "waiting"].includes(r.task.status)) return null;
    if (r.task.status === "running") return this.#set(id, { cancelRequested: true });
    return this.#set(id, { status: "cancelled", finishedAt: new Date(this.#now()) });
  }

  async requestInterrupt(id: TaskId, input: TaskInput): Promise<Task | null> {
    const r = this.recs.get(id);
    if (!r || !["queued", "running"].includes(r.task.status)) return null;
    return this.#set(id, { nextInput: input, interruptRequested: r.task.status === "running" });
  }

  async claim(worker: string, leaseMs: number, perCustomer: number, solo: readonly string[] = []): Promise<ClaimedTask | null> {
    const now = this.#now();
    const soloBusy = (r: { task: Task }) => solo.includes(r.task.agent) && [...this.recs.values()].some((s) => s.task.id !== r.task.id && s.task.customerId === r.task.customerId && solo.includes(s.task.agent) && s.task.status === "running" && s.leaseUntil >= now);
    const running = (c: CustomerId) =>
      [...this.recs.values()].filter((r) => r.task.customerId === c && r.task.status === "running" && r.leaseUntil >= now).length;
    // A task kept to a site waits while another of theirs works there: one at a time on a site, in turn.
    const siteBusy = (r: { task: Task }) =>
      r.task.site !== null &&
      [...this.recs.values()].some((s) => s.task.id !== r.task.id && s.task.customerId === r.task.customerId && s.task.site === r.task.site && s.task.status === "running" && s.leaseUntil >= now);
    const next = [...this.recs.values()]
      .filter((r) => (r.task.status === "queued" && r.availableAt <= now) || (r.task.status === "running" && r.leaseUntil < now))
      .filter((r) => running(r.task.customerId) < perCustomer && !siteBusy(r) && !soloBusy(r))
      .filter((r) => { const rest = this.restOf(r.task.customerId); return !this.offOf(r.task.customerId) && (rest === null || rest <= now); })
      .sort((a, b) => a.priority - b.priority || a.availableAt - b.availableAt)[0];
    if (!next) return null;
    const recovered = next.task.status === "running";
    const task = this.#set(next.task.id, { status: "running", attempts: next.task.attempts + 1 }, { worker, leaseUntil: now + leaseMs });
    return { task, recovered };
  }

  async heartbeat(id: TaskId, worker: string, leaseMs: number): Promise<TaskSignals> {
    const r = this.recs.get(id);
    if (!r || r.worker !== worker || r.task.status !== "running") return { held: false, cancelRequested: false, interruptRequested: false };
    r.leaseUntil = this.#now() + leaseMs;
    return { held: true, cancelRequested: r.task.cancelRequested, interruptRequested: r.task.interruptRequested };
  }

  async finish(id: TaskId, worker: string, outcome: TaskOutcome): Promise<void> {
    const r = this.recs.get(id);
    if (!r || r.worker !== worker || r.task.status !== "running") return;
    this.#set(
      id,
      {
        status: outcome.status,
        result: outcome.status === "succeeded" ? outcome.result : null,
        error: outcome.status === "failed" ? outcome.error : null,
        finishedAt: new Date(this.#now()),
        cancelRequested: false,
        interruptRequested: false,
      },
      { worker: null, leaseUntil: 0 },
    );
  }

  async park(id: TaskId, worker: string): Promise<void> {
    const r = this.recs.get(id);
    if (!r || r.worker !== worker || r.task.status !== "running") return;
    this.#set(id, { status: "waiting", attempts: Math.max(0, r.task.attempts - 1) }, { worker: null, leaseUntil: 0 });
  }

  async release(id: TaskId, worker: string, input: TaskInput, delayMs: number, clean = false): Promise<void> {
    const r = this.recs.get(id);
    if (!r || r.worker !== worker || r.task.status !== "running") return;
    const attempts = clean ? Math.max(0, r.task.attempts - 1) : r.task.attempts;
    this.#set(id, { status: "queued", nextInput: input, interruptRequested: false, attempts }, { worker: null, leaseUntil: 0, availableAt: this.#now() + delayMs });
  }
}

export class MemoryQuestions implements QuestionRepository {
  readonly questions = new Map<string, Question>();

  async create(input: NewQuestion): Promise<Question> {
    const same = [...this.questions.values()].find((q) => q.taskId === input.taskId && q.interruptId === input.interruptId);
    if (same) return same;
    const q: Question = {
      id: toQuestionId(randomUUID()),
      customerId: input.customerId,
      taskId: input.taskId,
      interruptId: input.interruptId,
      agent: input.agent,
      text: input.text,
      options: input.options,
      why: input.why,
      status: "pending",
      answer: null,
      answeredBy: null,
      askedRef: null,
      createdAt: new Date(),
      askedAt: null,
      answeredAt: null,
    };
    this.questions.set(q.id, q);
    return q;
  }

  async get(id: QuestionId): Promise<Question | null> {
    return this.questions.get(id) ?? null;
  }

  async listFor(customerId: CustomerId, statuses: readonly QuestionStatus[]): Promise<Question[]> {
    return [...this.questions.values()].filter((q) => q.customerId === customerId && statuses.includes(q.status));
  }

  async listForTask(taskId: TaskId, statuses: readonly QuestionStatus[]): Promise<Question[]> {
    return [...this.questions.values()].filter((q) => q.taskId === taskId && statuses.includes(q.status));
  }

  async findByAskedRef(customerId: CustomerId, ref: string): Promise<Question | null> {
    return [...this.questions.values()].find((q) => q.customerId === customerId && q.askedRef === ref) ?? null;
  }

  async markAsked(id: QuestionId, ref: string | null): Promise<void> {
    const q = this.questions.get(id);
    if (q && (q.status === "pending" || q.status === "asked")) this.questions.set(id, { ...q, status: "asked", askedRef: ref ?? q.askedRef, askedAt: new Date() });
  }

  async answer(id: QuestionId, answer: string, by: AnsweredBy): Promise<Question | null> {
    const q = this.questions.get(id);
    if (!q || (q.status !== "pending" && q.status !== "asked")) return null;
    const next: Question = { ...q, status: "answered", answer, answeredBy: by, answeredAt: new Date() };
    this.questions.set(id, next);
    return next;
  }

  async dismiss(id: QuestionId, note: string): Promise<Question | null> {
    const q = this.questions.get(id);
    if (!q || (q.status !== "pending" && q.status !== "asked")) return null;
    const next: Question = { ...q, status: "dismissed", answer: note, answeredBy: "manager", answeredAt: new Date() };
    this.questions.set(id, next);
    return next;
  }

  async closeForTask(id: TaskId): Promise<void> {
    for (const q of this.questions.values()) {
      if (q.taskId === id && (q.status === "pending" || q.status === "asked")) this.questions.set(q.id, { ...q, status: "dismissed" });
    }
  }
}

export class FakeChannel implements ChatChannel {
  readonly kind = "telegram" as const;
  readonly sent: { to: string; text: string; question?: OutgoingQuestion; ref: string; answers?: readonly string[] }[] = [];
  readonly answersShown: { ref: string; answer: string }[] = [];
  readonly acks: { ackRef: string; text?: string }[] = [];
  #ref = 100;

  async sendText(to: ChannelAddress, text: string, answers: readonly string[] = []): Promise<string> {
    const ref = String(++this.#ref);
    this.sent.push({ to: to.address, text, ref, ...(answers.length ? { answers } : {}) });
    return ref;
  }

  /** Every edit of a message's words, in order; the message in `sent` shows its last words. */
  readonly edits: { ref: string; text: string }[] = [];

  async editText(_to: ChannelAddress, ref: string, text: string): Promise<boolean> {
    const at = this.sent.findIndex((m) => m.ref === ref);
    if (at < 0) return false;
    this.sent[at] = { ...this.sent[at]!, text };
    this.edits.push({ ref, text });
    return true;
  }

  async sendQuestion(to: ChannelAddress, question: OutgoingQuestion): Promise<string> {
    const ref = String(++this.#ref);
    this.sent.push({ to: to.address, text: question.text, question, ref });
    return ref;
  }

  async showAnswer(_to: ChannelAddress, ref: string, _q: OutgoingQuestion, answer: string): Promise<void> {
    this.answersShown.push({ ref, answer });
  }

  async acknowledge(ackRef: string, text?: string): Promise<void> {
    this.acks.push({ ackRef, ...(text ? { text } : {}) });
  }

  async showTyping(): Promise<void> {}

  readonly reactions: { to: string; ref: string; emoji: string }[] = [];

  async react(to: ChannelAddress, ref: string, emoji: string): Promise<void> {
    this.reactions.push({ to: to.address, ref, emoji });
  }

  /** Every card as sent, and every redraw after, in order. */
  readonly cards: { ref: string; find: Find; redraw: boolean }[] = [];

  async sendFind(to: ChannelAddress, find: Find): Promise<string> {
    const ref = String(++this.#ref);
    this.sent.push({ to: to.address, text: `[find] ${find.url}`, ref });
    this.cards.push({ ref, find, redraw: false });
    return ref;
  }

  async updateFind(_to: ChannelAddress, ref: string, find: Find): Promise<void> {
    this.cards.push({ ref, find, redraw: true });
  }

  /** Every draft card as sent, and every redraw after, in order. */
  readonly drafts: { ref: string; draft: Draft; redraw: boolean }[] = [];

  async sendDraft(to: ChannelAddress, draft: Draft): Promise<string> {
    const ref = String(++this.#ref);
    this.sent.push({ to: to.address, text: `[draft] ${draft.kind} ${draft.url}`, ref });
    this.drafts.push({ ref, draft, redraw: false });
    return ref;
  }

  async updateDraft(_to: ChannelAddress, ref: string, draft: Draft): Promise<void> {
    this.drafts.push({ ref, draft, redraw: true });
  }

  /** Each "what should change?" asked under a card, by the card's ref. */
  readonly editAsks: { cardRef: string; ref: string; text: string }[] = [];

  async askEdit(to: ChannelAddress, cardRef: string, text: string): Promise<string> {
    const ref = String(++this.#ref);
    this.sent.push({ to: to.address, text, ref });
    this.editAsks.push({ cardRef, ref, text });
    return ref;
  }

  /** Cards whose buttons were taken off. */
  readonly closed: string[] = [];

  async closeCard(_to: ChannelAddress, ref: string): Promise<void> {
    this.closed.push(ref);
  }

  /** Every message with link buttons (the Chrome setup). */
  readonly linkMessages: { to: string; text: string; links: readonly OutgoingLink[] }[] = [];

  readonly switches: { to: string; text: string; on: boolean }[] = [];
  readonly ideaCards: { to: string; ref: string; idea: Idea; decided?: Idea }[] = [];

  async sendIdea(to: ChannelAddress, idea: Idea): Promise<string> {
    const ref = String(++this.#ref);
    this.sent.push({ to: to.address, text: `${idea.text}`, ref });
    this.ideaCards.push({ to: to.address, ref, idea });
    return ref;
  }

  async showIdeaDecided(_to: ChannelAddress, ref: string, idea: Idea): Promise<void> {
    const card = this.ideaCards.find((c) => c.ref === ref);
    if (card) card.decided = idea;
  }

  async sendSwitch(to: ChannelAddress, text: string, on: boolean): Promise<string> {
    const ref = String(++this.#ref);
    this.sent.push({ to: to.address, text, ref });
    this.switches.push({ to: to.address, text, on });
    return ref;
  }

  async sendLinks(to: ChannelAddress, text: string, links: readonly OutgoingLink[]): Promise<string> {
    const ref = String(++this.#ref);
    this.sent.push({ to: to.address, text, ref });
    this.linkMessages.push({ to: to.address, text, links });
    return ref;
  }

  /** The language choices sent, and the language each ended on. */
  readonly languageChoices: { ref: string; detected: string }[] = [];
  readonly languagesShown: { ref: string; locale: string }[] = [];

  async sendLanguageChoice(to: ChannelAddress, detected: string): Promise<string> {
    const ref = String(++this.#ref);
    this.sent.push({ to: to.address, text: "[language choice]", ref });
    this.languageChoices.push({ ref, detected });
    return ref;
  }

  async showLanguageChosen(_to: ChannelAddress, ref: string, locale: string): Promise<void> {
    this.languagesShown.push({ ref, locale });
  }

  /** Files people sent, by ref. */
  readonly files = new Map<string, Uint8Array>();

  /** Files Telegram will not hand over: bigger than a bot may take. */
  readonly tooBig = new Set<string>();

  async download(fileRef: string): Promise<Uint8Array> {
    if (this.tooBig.has(fileRef)) throw new Error("Telegram getFile failed (400): Bad Request: file is too big");
    const f = this.files.get(fileRef);
    if (!f) throw new Error(`no file ${fileRef}`);
    return f;
  }

  /** Every picture as sent, then every replacement; `gone` refs are messages the person deleted. */
  readonly photos: { ref: string; jpeg: Uint8Array; caption: string | null; replaced: boolean }[] = [];
  readonly gone = new Set<string>();

  async sendPhoto(to: ChannelAddress, jpeg: Uint8Array, caption: string | null): Promise<string> {
    const ref = String(++this.#ref);
    this.sent.push({ to: to.address, text: "[photo]", ref });
    this.photos.push({ ref, jpeg, caption, replaced: false });
    return ref;
  }

  async replacePhoto(_to: ChannelAddress, ref: string, jpeg: Uint8Array, caption: string | null): Promise<boolean> {
    if (this.gone.has(ref)) return false;
    this.photos.push({ ref, jpeg, caption, replaced: true });
    return true;
  }

  /** Every label the chat's Quest button was given, in order (null: back to its usual name); false: the chat has no such button. */
  readonly buttons: { to: string; label: string | null }[] = [];
  hasButton = true;

  async showWork(to: ChannelAddress, label: string | null): Promise<boolean> {
    if (!this.hasButton) return false;
    this.buttons.push({ to: to.address, label });
    return true;
  }

  /** Progress boards an older version pinned, taken down. */
  readonly removedBoards: string[] = [];

  async removeBoard(_to: ChannelAddress, ref: string): Promise<void> {
    this.removedBoards.push(ref);
  }

  /** Every deck drawn, in order: sent anew (`sent`, with `silent`) or redrawn in place. The last per ref is what the chat shows. */
  readonly decks: { ref: string; view: DeckView; sent: boolean; silent: boolean }[] = [];
  /** Messages taken out of the chat. */
  readonly removed: string[] = [];

  async showDeck(to: ChannelAddress, ref: string | null, view: DeckView, opts: { silent?: boolean } = {}): Promise<string | null> {
    if (ref && (this.gone.has(ref) || this.removed.includes(ref))) return null;
    const at = ref ?? String(++this.#ref);
    if (!ref) this.sent.push({ to: to.address, text: `[deck] ${view.ask?.key ?? "empty"}`, ref: at });
    this.decks.push({ ref: at, view, sent: !ref, silent: Boolean(opts.silent) });
    return at;
  }

  /** What the deck shows now: the last draw of the newest deck. */
  get deck(): { ref: string; view: DeckView } | null {
    const last = this.decks.at(-1);
    if (!last) return null;
    const newest = [...this.decks].reverse().find((d) => d.sent)?.ref ?? last.ref;
    return [...this.decks].reverse().find((d) => d.ref === newest) ?? null;
  }

  async removeMessage(_to: ChannelAddress, ref: string): Promise<void> {
    this.removed.push(ref);
  }
}

/** mq.customers.deck in memory. */
export class MemoryDecks implements DeckStore {
  readonly rows = new Map<CustomerId, DeckState>();

  async get(customerId: CustomerId): Promise<DeckState | null> {
    return this.rows.get(customerId) ?? null;
  }

  async save(customerId: CustomerId, state: DeckState): Promise<void> {
    this.rows.set(customerId, state);
  }
}

/** mq.task_boards in memory. */
export class MemoryBoards implements BoardRepository {
  readonly rows = new Map<CustomerId, PinnedBoard>();

  async get(customerId: CustomerId): Promise<PinnedBoard | null> {
    return this.rows.get(customerId) ?? null;
  }

  async save(customerId: CustomerId, board: PinnedBoard): Promise<void> {
    this.rows.set(customerId, board);
  }

  async clear(customerId: CustomerId, ref: string): Promise<void> {
    if (this.rows.get(customerId)?.ref === ref) this.rows.delete(customerId);
  }

  async list(): Promise<{ customerId: CustomerId; board: PinnedBoard }[]> {
    return [...this.rows].map(([customerId, board]) => ({ customerId, board }));
  }
}

/** mq.chrome_links in memory, with the same rules: one-time codes, one connected Chrome per customer. */
export class MemoryChromeLinks implements ChromeLinkRepository {
  readonly rows: {
    id: string;
    customerId: CustomerId;
    codeHash: string | null;
    codeExpiresAt: Date | null;
    tokenHash: string | null;
    device: string | null;
    createdAt: Date;
    pairedAt: Date | null;
    lastSeenAt: Date | null;
    revokedAt: Date | null;
  }[] = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #link(r: MemoryChromeLinks["rows"][number]): ChromeLink {
    return { id: r.id, customerId: r.customerId, device: r.device, pairedAt: r.pairedAt!, lastSeenAt: r.lastSeenAt };
  }

  #active = (r: MemoryChromeLinks["rows"][number]): boolean => r.pairedAt !== null && r.revokedAt === null;

  async offer(customerId: CustomerId, codeHash: string, expiresAt: Date): Promise<void> {
    for (let i = this.rows.length - 1; i >= 0; i--) if (this.rows[i]!.customerId === customerId && !this.rows[i]!.pairedAt) this.rows.splice(i, 1);
    this.rows.push({
      id: randomUUID(),
      customerId,
      codeHash,
      codeExpiresAt: expiresAt,
      tokenHash: null,
      device: null,
      createdAt: new Date(this.#now()),
      pairedAt: null,
      lastSeenAt: null,
      revokedAt: null,
    });
  }

  async lastOffer(customerId: CustomerId): Promise<Date | null> {
    return this.rows.filter((x) => x.customerId === customerId && !x.pairedAt && x.codeHash).at(-1)?.createdAt ?? null;
  }

  async redeem(codeHash: string, tokenHash: string, device: string | null, now: Date): Promise<ChromeLink | null> {
    const r = this.rows.find((x) => x.codeHash === codeHash && !x.pairedAt && x.codeExpiresAt && x.codeExpiresAt > now);
    if (!r) return null;
    for (const old of this.rows) if (old.customerId === r.customerId && this.#active(old)) old.revokedAt = now;
    Object.assign(r, { codeHash: null, codeExpiresAt: null, tokenHash, device, pairedAt: now, lastSeenAt: now });
    return this.#link(r);
  }

  async byToken(tokenHash: string): Promise<ChromeLink | null> {
    const r = this.rows.find((x) => x.tokenHash === tokenHash && this.#active(x));
    return r ? this.#link(r) : null;
  }

  async active(customerId: CustomerId): Promise<ChromeLink | null> {
    const r = this.rows.find((x) => x.customerId === customerId && this.#active(x));
    return r ? this.#link(r) : null;
  }

  async seen(linkId: string, at: Date): Promise<void> {
    const r = this.rows.find((x) => x.id === linkId && this.#active(x));
    if (r) r.lastSeenAt = at;
  }

  async revoke(linkId: string, at: Date): Promise<ChromeLink | null> {
    const r = this.rows.find((x) => x.id === linkId && this.#active(x));
    if (!r) return null;
    r.revokedAt = at;
    return this.#link(r);
  }
}

/** The customer's Chrome as the manager sees it: connected and open unless a test says otherwise. */
export class FakeChrome {
  state: ChromeStatus = { linked: true, online: true, device: "Chrome on Test", lastSeenAt: null };
  readonly offers: { customerId: CustomerId; force: boolean }[] = [];
  readonly awaited: CustomerId[] = [];
  /** Whether the setup ever went out, as ChromeLinkService.offerFirst knows it from the links. */
  everOffered = false;

  async status(): Promise<ChromeStatus> {
    return this.state;
  }

  async offer(customerId: CustomerId, opts: { force?: boolean } = {}): Promise<OfferOutcome> {
    this.offers.push({ customerId, force: Boolean(opts.force) });
    // offeredAt is there only while it is too soon to send the setup again, as ChromeLinkService.status gives it.
    if (!opts.force && this.state.offeredAt) return { sent: false, why: "recent", at: this.state.offeredAt };
    this.everOffered = true;
    return { sent: true, code: "TESTCODE" };
  }

  async offerFirst(customerId: CustomerId): Promise<OfferOutcome> {
    if (this.everOffered || this.state.linked) return { sent: false, why: this.state.linked ? "connected" : "recent", at: new Date(0) } as OfferOutcome;
    this.everOffered = true;
    return this.offer(customerId);
  }

  awaitOnline(customerId: CustomerId): void {
    this.awaited.push(customerId);
  }
}

/** Every customer reads with the same fake reader and search. */
export class FakeReach implements WebReach {
  readonly reader: PageReader;
  readonly posts: PostSearch;

  constructor(reader: PageReader, posts: PostSearch) {
    this.reader = reader;
    this.posts = posts;
  }

  forCustomer(): { reader: PageReader; posts: PostSearch } {
    return { reader: this.reader, posts: this.posts };
  }
}

/** Finds in memory, with the database's rules: one per post per customer, decisions only on shown cards. */
export class MemoryFinds implements FindRepository {
  readonly finds = new Map<string, Find>();
  readonly watches = new Map<string, { next: Date | null; checks: number; seen: readonly string[] }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async beginPost(id: FindId, alone = false): Promise<boolean> {
    const f = this.finds.get(id);
    if (!f || f.sentAt || (f.postState ?? "open") !== "open" || !["shown", "kept"].includes(f.status)) return false;
    this.finds.set(id, { ...f, postState: "posting", sentAlone: alone });
    return true;
  }

  async endPost(id: FindId, uncertain: boolean): Promise<void> {
    const f = this.finds.get(id);
    if (f && !f.sentAt && ["posting", "uncertain"].includes(f.postState ?? "open")) this.finds.set(id, { ...f, postState: uncertain ? "uncertain" : "open" });
  }

  async leftPosting(): Promise<Find[]> {
    return [...this.finds.values()].filter((f) => f.postState === "posting" && !f.sentAt);
  }

  async add(input: NewFind): Promise<Find | null> {
    if ([...this.finds.values()].some((f) => f.customerId === input.customerId && f.url === input.url)) return null;
    const f: Find = {
      ...input,
      replyTo: input.replyTo ?? null,
      id: toFindId(randomUUID()),
      status: "new",
      skipReason: null,
      cardRef: null,
      createdAt: new Date(this.#now()),
      shownAt: null,
      decidedAt: null,
      sentUrl: null,
      sentAs: null,
      sentAt: null,
      sentAlone: false,
    };
    this.finds.set(f.id, f);
    return f;
  }

  async get(id: FindId): Promise<Find | null> {
    return this.finds.get(id) ?? null;
  }

  async listFor(customerId: CustomerId, statuses: readonly FindStatus[], limit: number): Promise<Find[]> {
    const at = (f: Find) => (f.decidedAt ?? f.shownAt ?? f.createdAt).getTime();
    return [...this.finds.values()]
      .filter((f) => f.customerId === customerId && statuses.includes(f.status))
      .sort((a, b) => at(b) - at(a))
      .slice(0, limit);
  }

  async nextToShow(customerId: CustomerId, limit: number): Promise<Find[]> {
    const posted = (f: Find) => f.postedAt?.getTime() ?? -Infinity;
    return [...this.finds.values()]
      .filter((f) => f.customerId === customerId && f.status === "new")
      .sort((a, b) => Number(b.strength === "strong") - Number(a.strength === "strong") || posted(b) - posted(a))
      .slice(0, limit);
  }

  async known(customerId: CustomerId, urls: readonly string[]): Promise<Set<string>> {
    return new Set([...this.finds.values()].filter((f) => f.customerId === customerId && urls.includes(f.url)).map((f) => f.url));
  }

  async markShown(id: FindId, cardRef: string | null): Promise<void> {
    const f = this.finds.get(id);
    if (f?.status === "new") this.finds.set(id, { ...f, status: "shown", cardRef, shownAt: new Date(this.#now()) });
  }

  async decide(id: FindId, decision: FindDecision): Promise<Find | null> {
    const f = this.finds.get(id);
    if (f?.status !== "shown" && !(f?.status === "kept" && decision !== "kept" && !f.sentAt)) return null;
    const next: Find = { ...f, status: decision, decidedAt: new Date(this.#now()) };
    this.finds.set(id, next);
    return next;
  }

  async giveReason(id: FindId, reason: SkipReason): Promise<Find | null> {
    const f = this.finds.get(id);
    if (f?.status !== "skipped") return null;
    const next: Find = { ...f, skipReason: reason };
    this.finds.set(id, next);
    return next;
  }

  async markSent(id: FindId, url: string, account: string, alone = false): Promise<Find | null> {
    const f = this.finds.get(id);
    if (!f || f.sentAt) return null;
    const at = new Date(this.#now());
    const next: Find = { ...f, status: "replied", postState: "posted", skipReason: null, decidedAt: at, sentUrl: url, sentAs: account, sentAt: at, sentAlone: alone };
    this.finds.set(id, next);
    return next;
  }

  async revise(id: FindId, reply: string): Promise<Find | null> {
    const f = this.finds.get(id);
    if (!f || f.sentAt || !["new", "shown", "kept"].includes(f.status)) return null;
    const next: Find = { ...f, reply };
    this.finds.set(id, next);
    return next;
  }

  async byCard(customerId: CustomerId, cardRef: string): Promise<Find | null> {
    const all = [...this.finds.values()].filter((f) => f.customerId === customerId);
    return all.find((f) => f.cardRef === cardRef) ?? all.find((f) => this.otherRefs.get(f.id)?.includes(cardRef)) ?? null;
  }

  /** Older copies of a card, and questions asked under it, by id. */
  readonly otherRefs = new Map<string, string[]>();

  async moveCard(id: FindId, cardRef: string): Promise<void> {
    const x = this.finds.get(id);
    if (!x) return;
    if (x.cardRef && x.cardRef !== cardRef) this.otherRefs.set(id, [...(this.otherRefs.get(id) ?? []), x.cardRef]);
    this.finds.set(id, { ...x, cardRef });
  }

  async addRef(id: FindId, ref: string): Promise<void> {
    this.otherRefs.set(id, [...(this.otherRefs.get(id) ?? []), ref]);
  }


  async dropWaiting(customerId: CustomerId, ids: readonly FindId[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      const f = this.finds.get(id);
      if (f?.customerId === customerId && f.status === "new" && this.finds.delete(id)) n++;
    }
    return n;
  }

  async sentSince(customerId: CustomerId, since: Date): Promise<number> {
    return [...this.finds.values()].filter((f) => f.customerId === customerId && f.sentAt && f.sentAt >= since).length;
  }

  async dueWatches(now: Date, limit: number, _only?: readonly CustomerId[]): Promise<WatchedFind[]> {
    return [...this.watches]
      .filter(([, w]) => w.next && w.next <= now)
      .sort(([, a], [, b]) => a.next!.getTime() - b.next!.getTime())
      .slice(0, limit)
      .map(([id, w]) => ({ find: this.finds.get(id)!, checks: w.checks, seen: w.seen }));
  }

  async watch(id: FindId, next: Date | null, checks: number, seen: readonly string[]): Promise<void> {
    this.watches.set(id, { next, checks, seen: [...seen] });
  }

  async toldAnswers(customerId: CustomerId): Promise<ToldAnswers[]> {
    return [...this.watches].flatMap(([id, w]) => {
      const f = this.finds.get(id);
      return f?.customerId === customerId && w.seen.length ? [{ url: f.url, seen: w.seen }] : [];
    });
  }

  async counts(customerId: CustomerId): Promise<FindCounts> {
    const counts: Record<FindStatus, number> = { new: 0, shown: 0, kept: 0, skipped: 0, replied: 0 };
    for (const f of this.finds.values()) if (f.customerId === customerId) counts[f.status]++;
    return counts;
  }
}

/** Places in memory: one per key per customer, a second save updates it. */
export class MemoryPlaces implements PlaceRepository {
  readonly places: Place[] = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async save(p: NewPlace): Promise<{ place: Place; added: boolean }> {
    const at = this.places.findIndex((x) => x.customerId === p.customerId && x.key === p.key);
    const now = new Date(this.#now());
    if (at >= 0) {
      const place: Place = { ...this.places[at]!, ...p, updatedAt: now };
      this.places[at] = place;
      return { place, added: false };
    }
    const place: Place = { ...p, foundAt: now, updatedAt: now };
    this.places.unshift(place);
    return { place, added: true };
  }

  async listFor(customerId: CustomerId): Promise<Place[]> {
    return this.places.filter((p) => p.customerId === customerId);
  }
}

/** The customer's Chrome as a poster: posts what it is given, or fails the way it is told to. */
export class FakePoster implements ReplyPoster {
  readonly posts: { customerId: CustomerId; post: ChromePost }[] = [];
  failWith: { reason: ChromeFailure; message: string } | null = null;
  /** Thrown by the next post only, as the poster throws it (a TooLong with its numbers). */
  throwNext: Error | null = null;
  /** When set, a post waits for this before it answers (to see what happens meanwhile). */
  hold: Promise<void> | null = null;
  /** What a held post fails as when the agent stops: before it was sent ("unavailable") or once it may have been ("uncertain"). */
  stoppedAs: ChromeFailure = "unavailable";

  async post(customerId: CustomerId, post: ChromePost, signal?: AbortSignal): Promise<ChromePosted> {
    this.posts.push({ customerId, post });
    const hold = this.hold;
    if (hold) {
      await new Promise<void>((resolve, reject) => {
        const stop = () => reject(new ChromeError(this.stoppedAs, "the agent stopped"));
        if (signal?.aborted) stop();
        else signal?.addEventListener("abort", stop, { once: true });
        hold.then(resolve, reject);
      });
    }
    const next = this.throwNext;
    this.throwNext = null;
    if (next) throw next;
    if (this.failWith) throw new ChromeError(this.failWith.reason, this.failWith.message);
    // The addresses the extension builds: a new post's thread, the sent messages, or the thread with the new comment's id.
    if (post.platform === "browser") return { url: post.url, account: "connected account" };
    if (post.kind === "post") return { url: `${post.url}comments/p1/${post.title.toLowerCase().replace(/[^a-z0-9]+/g, "_")}/`, account: "dana_builds" };
    if (post.kind === "message") return { url: "https://www.reddit.com/message/sent/", account: "dana_builds" };
    return { url: post.url.replace(/\/comments\/([a-z0-9]+)\/.*$/i, "/comments/$1/comment/new1/"), account: "dana_builds" };
  }
}

export class FakeReader implements PageReader {
  readonly reads: string[] = [];
  /** The pages read as a visitor, not logged in. */
  readonly visitorReads: string[] = [];
  readonly pages: Record<string, PageText>;

  constructor(pages: Record<string, PageText> = {}) {
    this.pages = pages;
  }

  async readPage(url: string, opts: { asVisitor?: boolean } = {}): Promise<PageText> {
    this.reads.push(url);
    if (opts.asVisitor) this.visitorReads.push(url);
    return this.pages[url] ?? { url, title: "Acme", description: null, text: "Acme builds invoicing for freelancers." };
  }

  async readSite(url: string): Promise<SiteRead> {
    return { pages: [await this.readPage(url)] };
  }
}

export class FakePostSearch implements PostSearch {
  readonly queries: PostQuery[] = [];
  readonly results: Record<string, FoundPost[]>;

  constructor(results: Record<string, FoundPost[]> = {}) {
    this.results = results;
  }

  sources(): readonly SourceInfo[] {
    return [{ name: "hackernews", covers: "Hacker News", queryHint: "plain words" }];
  }

  async search(q: PostQuery): Promise<FoundPost[]> {
    this.queries.push(q);
    return this.results[q.source] ?? [];
  }
}

/** A one-page PDF with one line of text, as a person's CV might arrive (built by hand, offsets and all). */
export function pdfWith(line: string): Uint8Array {
  const content = `BT /F1 12 Tf 72 720 Td (${line.replace(/[()\\]/g, (ch) => `\\${ch}`)}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((o, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

/** What Quest keeps for good, in memory, with the database's rule: the same words are kept once. */
export class MemoryKept implements MemoryRepository {
  readonly rows: (Memory & { retired: boolean })[] = [];
  #id = 0;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async add(customerId: CustomerId, m: NewMemory): Promise<{ memory: Memory; added: boolean }> {
    const had = this.rows.find((r) => r.customerId === customerId && !r.retired && r.text.toLowerCase() === m.text.trim().toLowerCase());
    if (had) return { memory: had, added: false };
    const row = { id: String(++this.#id), customerId, kind: m.kind, text: m.text.trim(), source: m.source, createdAt: new Date(this.#now()), retired: false };
    this.rows.push(row);
    return { memory: row, added: true };
  }

  async retire(customerId: CustomerId, id: string): Promise<Memory | null> {
    const row = this.rows.find((r) => r.customerId === customerId && r.id === id && !r.retired);
    if (!row) return null;
    row.retired = true;
    return row;
  }

  async list(customerId: CustomerId, limit: number): Promise<Memory[]> {
    return this.rows
      .filter((r) => r.customerId === customerId && !r.retired)
      .reverse()
      .slice(0, limit);
  }
}

/** A day's record, counted from the in-memory stores. */
export class MemoryDay implements DayLedger {
  readonly #finds: MemoryFinds;
  readonly #tasks: MemoryTasks;

  constructor(finds: MemoryFinds, tasks: MemoryTasks) {
    this.#finds = finds;
    this.#tasks = tasks;
  }

  async day(customerId: CustomerId, since: Date): Promise<DayFacts> {
    const after = (d: Date | null): boolean => Boolean(d && d >= since);
    const fs = [...this.#finds.finds.values()].filter((f) => f.customerId === customerId);
    const saved: Record<string, number> = {};
    for (const f of fs.filter((f) => after(f.createdAt))) saved[f.source] = (saved[f.source] ?? 0) + 1;
    return {
      since,
      tasks: [...this.#tasks.recs.values()]
        .map((r) => r.task)
        .filter((t) => t.customerId === customerId && after(t.updatedAt))
        .map((t) => ({ agent: t.agent, title: t.title, status: t.status })),
      saved,
      shown: fs.filter((f) => after(f.shownAt)).length,
      kept: fs.filter((f) => after(f.decidedAt) && f.status === "kept").length,
      skipped: fs.filter((f) => after(f.decidedAt) && f.status === "skipped").length,
      replied: fs.filter((f) => after(f.decidedAt) && f.status === "replied").length,
      posted: fs.filter((f) => after(f.sentAt)).length,
      answers: 0,
      removed: 0,
      places: [],
      messagesIn: 0,
      messagesOut: 0,
    };
  }
}

export class MemoryDrafts implements DraftRepository {
  readonly drafts = new Map<string, Draft>();
  readonly watches = new Map<string, { next: Date | null; checks: number; seen: readonly string[] }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async add(d: NewDraft): Promise<Draft> {
    const draft: Draft = {
      ...d,
      id: toDraftId(randomUUID()),
      status: "open",
      cardRef: null,
      createdAt: new Date(this.#now()),
      decidedAt: null,
      sentUrl: null,
      sentAs: null,
      sentAt: null,
      alone: false,
    };
    this.drafts.set(draft.id, draft);
    return draft;
  }

  async get(id: DraftId): Promise<Draft | null> {
    return this.drafts.get(id) ?? null;
  }

  async markShown(id: DraftId, cardRef: string | null): Promise<void> {
    const d = this.drafts.get(id);
    if (d) this.drafts.set(id, { ...d, cardRef });
  }

  async beginPost(id: DraftId, alone = false): Promise<boolean> {
    const d = this.drafts.get(id);
    if (!d || d.status !== "open") return false;
    this.drafts.set(id, { ...d, status: "posting", alone, decidedAt: new Date(this.#now()) });
    return true;
  }

  async endPost(id: DraftId, uncertain: boolean): Promise<void> {
    const d = this.drafts.get(id);
    if (d && ["posting", "uncertain"].includes(d.status)) this.drafts.set(id, { ...d, status: uncertain ? "uncertain" : "open" });
  }

  async leftPosting(): Promise<Draft[]> {
    return [...this.drafts.values()].filter((d) => d.status === "posting");
  }

  async skip(id: DraftId, answered = false): Promise<Draft | null> {
    const d = this.drafts.get(id);
    if (!d || d.status !== "open") return null;
    const decidedAt = new Date(this.#now());
    const next: Draft = { ...d, status: "skipped", decidedAt, ...(answered ? { answeredAt: decidedAt } : {}) };
    this.drafts.set(id, next);
    return next;
  }

  async markSent(id: DraftId, url: string, account: string, alone = false): Promise<Draft | null> {
    const d = this.drafts.get(id);
    if (!d || !["open", "posting", "uncertain"].includes(d.status)) return null;
    const at = new Date(this.#now());
    const next: Draft = { ...d, status: "posted", decidedAt: at, sentUrl: url, sentAs: account, sentAt: at, alone };
    this.drafts.set(id, next);
    return next;
  }

  async revise(id: DraftId, text: string, title: string | null): Promise<Draft | null> {
    const d = this.drafts.get(id);
    if (!d || d.status !== "open") return null;
    const next: Draft = { ...d, text, title: title ?? d.title };
    this.drafts.set(id, next);
    return next;
  }

  async byCard(customerId: CustomerId, cardRef: string): Promise<Draft | null> {
    const all = [...this.drafts.values()].filter((d) => d.customerId === customerId);
    return all.find((d) => d.cardRef === cardRef) ?? all.find((d) => this.otherRefs.get(d.id)?.includes(cardRef)) ?? null;
  }

  /** Older copies of a card, and questions asked under it, by id. */
  readonly otherRefs = new Map<string, string[]>();

  async moveCard(id: DraftId, cardRef: string): Promise<void> {
    const x = this.drafts.get(id);
    if (!x) return;
    if (x.cardRef && x.cardRef !== cardRef) this.otherRefs.set(id, [...(this.otherRefs.get(id) ?? []), x.cardRef]);
    this.drafts.set(id, { ...x, cardRef });
  }

  async addRef(id: DraftId, ref: string): Promise<void> {
    this.otherRefs.set(id, [...(this.otherRefs.get(id) ?? []), ref]);
  }


  async sentSince(customerId: CustomerId, since: Date): Promise<number> {
    return [...this.drafts.values()].filter((d) => d.customerId === customerId && d.sentAt && d.sentAt >= since).length;
  }

  async recent(customerId: CustomerId, limit: number): Promise<Draft[]> {
    return [...this.drafts.values()]
      .filter((d) => d.customerId === customerId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async dueWatches(now: Date, limit: number, _only?: readonly CustomerId[]): Promise<WatchedDraft[]> {
    return [...this.watches]
      .filter(([, w]) => w.next && w.next <= now)
      .sort(([, a], [, b]) => a.next!.getTime() - b.next!.getTime())
      .slice(0, limit)
      .map(([id, w]) => ({ draft: this.drafts.get(id)!, checks: w.checks, seen: w.seen }));
  }

  async watch(id: DraftId, next: Date | null, checks: number, seen: readonly string[]): Promise<void> {
    this.watches.set(id, { next, checks, seen });
  }

  async toldAnswers(customerId: CustomerId): Promise<ToldAnswers[]> {
    return [...this.watches].flatMap(([id, w]) => {
      const d = this.drafts.get(id);
      return d?.customerId === customerId && w.seen.length ? [{ url: d.url, seen: w.seen }] : [];
    });
  }
}

/** Approvals per platform, in memory. */
export class MemoryTrust implements TrustRepository {
  readonly counts = new Map<string, number>();
  readonly review = new Map<string, boolean>();
  /** Their yes to doing a kind alone there (mq.trust.granted). */
  readonly granted = new Map<string, boolean>();

  #row(customerId: CustomerId, platform: string): string {
    for (const p of [platform, everywhere(platform)]) if (this.counts.has(`${customerId}:${p}`)) return `${customerId}:${p}`;
    return `${customerId}:*`;
  }

  async approved(customerId: CustomerId, platform: string): Promise<number> {
    const key = this.#row(customerId, platform);
    return this.review.get(key) ? 0 : this.counts.get(key) ?? 0;
  }

  async initialize(customerId: CustomerId): Promise<void> {
    const key = `${customerId}:*`;
    if (!this.counts.has(key)) {
      this.counts.set(key, 3);
      this.granted.set(key, true);
    }
  }

  async approve(customerId: CustomerId, platform: string): Promise<number> {
    const key = `${customerId}:${platform}`;
    const from = this.#row(customerId, everywhere(platform));
    const n = (this.counts.get(key) ?? this.counts.get(from) ?? 0) + 1;
    if (!this.counts.has(key)) {
      this.review.set(key, this.review.get(from) ?? false);
      this.granted.set(key, this.granted.get(from) ?? false);
    }
    this.counts.set(key, n);
    return n;
  }

  async set(customerId: CustomerId, platform: string, approved: number, explicit = false): Promise<void> {
    if (platform.startsWith("*")) {
      for (const key of this.counts.keys()) {
        if (!key.startsWith(`${customerId}:`) || (platform !== "*" && !key.endsWith(platform.slice(1)))) continue;
        this.counts.set(key, approved);
        this.granted.set(key, approved >= 3);
        if (explicit) this.review.set(key, approved < 3);
      }
    }
    const key = `${customerId}:${platform}`;
    if (explicit || !this.counts.has(key)) this.review.set(key, explicit ? approved < 3 : this.review.get(`${customerId}:*`) ?? false);
    this.counts.set(key, approved);
    this.granted.set(key, approved >= 3);
  }

  async alone(customerId: CustomerId, platform: string): Promise<boolean> {
    const key = this.#row(customerId, platform);
    return (this.counts.get(key) ?? 0) >= 3 && Boolean(this.granted.get(key)) && !this.review.get(key);
  }

  async offered(customerId: CustomerId): Promise<string[]> {
    const prefix = `${customerId}:`;
    return [...this.counts.entries()]
      .filter(([key, n]) => key.startsWith(prefix) && !key.startsWith(`${prefix}*`) && n >= 3 && !this.granted.get(key) && !this.review.get(key))
      .map(([key]) => key.slice(prefix.length));
  }

  async answer(customerId: CustomerId, platform: string, yes: boolean): Promise<void> {
    const key = `${customerId}:${platform}`;
    if (!this.counts.has(key)) return;
    if (yes) {
      this.granted.set(key, true);
      this.review.set(key, false);
    } else {
      this.counts.set(key, 0);
      this.granted.set(key, false);
    }
  }
}

/** The people Quest got to know, in memory, as mq.contacts keeps them. */
export class MemoryContacts implements ContactRepository {
  readonly rows = new Map<string, Contact>();

  async get(customerId: CustomerId, key: string): Promise<Contact | null> {
    return this.rows.get(`${customerId}|${key}`) ?? null;
  }

  async list(customerId: CustomerId, limit: number): Promise<Contact[]> {
    return [...this.rows.values()].filter((c) => c.customerId === customerId).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, limit);
  }

  async keep(customerId: CustomerId, c: ContactCheck): Promise<Contact> {
    const key = contactKey(c.site, c.handle);
    const had = this.rows.get(`${customerId}|${key}`);
    const now = new Date();
    const kept: Contact = {
      customerId,
      key,
      site: c.site,
      handle: c.handle.replace(/^@/, ""),
      name: c.name ?? had?.name ?? null,
      profileUrl: c.profileUrl ?? had?.profileUrl ?? null,
      siteUrl: c.siteUrl ?? had?.siteUrl ?? null,
      about: c.about,
      needs: c.needs ?? had?.needs ?? null,
      canGive: c.canGive ?? had?.canGive ?? null,
      given: [...(had?.given ?? []), ...(c.gave ? [c.gave] : [])].slice(-CONTACT_NOTES),
      notes: [...(had?.notes ?? []), ...(c.note ? [{ at: now, text: c.note }] : [])].slice(-CONTACT_NOTES),
      checkedAt: now,
      createdAt: had?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(`${customerId}|${key}`, kept);
    return kept;
  }
}

/** The spend log, kept in a list: what each model call used, as the agent recorded it. */
/** Rests and credits as mq.customers.rest_until and mq.wallets keep them; spend from a MemorySpend. */
export class MemoryBilling implements BillingRepository {
  readonly rests = new Map<CustomerId, number>();
  readonly wallets = new Map<CustomerId, { paid: number; spent: number; countedTo: number }>();
  readonly topUps: TopUp[] = [];
  /** Who came in by buying credits (`mq.customers.invite = 'pack'`). */
  readonly bought = new Set<CustomerId>();
  /** Lets someone waiting in, as the top-up's SQL does; true when it did. */
  letIn: (customerId: CustomerId) => Promise<boolean> = async () => false;
  readonly #spend: MemorySpend;
  readonly #now: () => number;

  constructor(spend: MemorySpend, now: () => number = Date.now) {
    this.#spend = spend;
    this.#now = now;
  }

  async day(customerId: CustomerId, since: Date): Promise<DaySpend> {
    const spent = this.#spend.spentSince(customerId, since.getTime());
    const rest = this.rests.get(customerId);
    return { spent, wallet: this.#wallet(customerId), bought: this.bought.has(customerId), restUntil: rest === undefined ? null : new Date(rest) };
  }

  async rest(customerId: CustomerId, until: Date): Promise<boolean> {
    const rest = this.rests.get(customerId);
    if (rest !== undefined && rest > this.#now()) return false;
    this.rests.set(customerId, until.getTime());
    return true;
  }

  async endRest(customerId: CustomerId): Promise<void> {
    this.rests.delete(customerId);
  }

  async draw(customerId: CustomerId, upTo: Date): Promise<void> {
    const w = this.wallets.get(customerId);
    if (!w || w.countedTo >= upTo.getTime()) return;
    w.spent = Math.min(w.paid, w.spent + this.#spend.spentSince(customerId, w.countedTo + 1) - this.#spend.spentSince(customerId, upTo.getTime() + 1));
    w.countedTo = upTo.getTime();
  }

  async startFree(customerId: CustomerId, usd: number): Promise<boolean> {
    if (!(await this.letIn(customerId))) return false;
    this.bought.add(customerId);
    if (!this.wallets.has(customerId)) this.wallets.set(customerId, { paid: usd, spent: 0, countedTo: this.#now() });
    return true;
  }

  async topUp(t: TopUp): Promise<ToppedUp | null> {
    if (this.topUps.some((x) => x.session === t.session)) return null;
    const bonus = this.topUps.some((x) => x.customerId === t.customerId && x.paid >= 20) ? 0 : t.bonus;
    this.topUps.push({ ...t, bonus });
    const w = this.wallets.get(t.customerId) ?? { paid: 0, spent: 0, countedTo: this.#now() };
    w.paid += t.paid + bonus;
    this.wallets.set(t.customerId, w);
    const letIn = await this.letIn(t.customerId);
    if (letIn) this.bought.add(t.customerId);
    return { credit: t.paid + bonus, bonus, wallet: this.#wallet(t.customerId)!, letIn };
  }

  #wallet(customerId: CustomerId): Wallet | null {
    const w = this.wallets.get(customerId);
    return w ? { paid: w.paid, spent: w.spent, topUps: this.topUps.filter((x) => x.customerId === customerId && x.paid >= 20).length } : null;
  }
}

export class MemorySpend implements SpendLog {
  readonly calls: ModelCall[] = [];
  /** When each call was made (ms), as mq.model_calls.at. */
  readonly #at: number[] = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  record(call: ModelCall): void {
    this.calls.push(call);
    this.#at.push(this.#now());
  }

  /** What a customer's calls cost since `since` (ms), in dollars. */
  spentSince(customerId: CustomerId, since: number): number {
    return this.calls.reduce((sum, c, i) => (c.customerId === customerId && this.#at[i]! >= since ? sum + (c.usage.cost ?? 0) : sum), 0);
  }
}

/** Hears a "recording" made with `spoken`: its bytes are the words. `spoken("!")` is one that cannot be heard. */
export class FakeTranscriber implements Transcriber {
  readonly heard: { format: AudioFormat; customerId: CustomerId | null }[] = [];
  /** What `timed` answers: set by a test that reads a video. */
  speech: TimedSpeech = { text: "", language: null, seconds: 0, words: [] };
  timedFails: string | null = null;

  async transcribe(audio: Uint8Array, format: AudioFormat, customerId: CustomerId | null): Promise<string> {
    const words = new TextDecoder().decode(audio);
    if (words === "!") throw new Error("Provider returned 400");
    this.heard.push({ format, customerId });
    return words;
  }

  async timed(_audio: Uint8Array, format: AudioFormat, customerId: CustomerId | null): Promise<TimedSpeech> {
    if (this.timedFails) throw new Error(this.timedFails);
    this.heard.push({ format, customerId });
    return this.speech;
  }
}

export const spoken = (words: string): Uint8Array => new TextEncoder().encode(words);


/** What Quest owes, in memory, with the database's rules: settled once, moved only while open. */
export class MemoryCommitments implements CommitmentRepository {
  readonly rows: Commitment[] = [];
  #id = 0;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async add(customerId: CustomerId, c: NewCommitment, checkAt: Date): Promise<Commitment> {
    const row: Commitment = { id: String(++this.#id), customerId, ...c, held: c.held ?? null, checkAt, status: "open", moves: 0, note: null, createdAt: new Date(this.#now()), closedAt: null };
    this.rows.push(row);
    return row;
  }

  async get(customerId: CustomerId, id: string): Promise<Commitment | null> {
    return this.rows.find((r) => r.customerId === customerId && r.id === id) ?? null;
  }

  async open(customerId: CustomerId): Promise<Commitment[]> {
    return this.rows.filter((r) => r.customerId === customerId && r.status === "open").sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  }

  async close(customerId: CustomerId, id: string, status: "kept" | "dropped", note: string | null): Promise<Commitment | null> {
    return this.#update(customerId, id, (r) => ({ ...r, status, note: note ?? r.note, closedAt: new Date(this.#now()) }));
  }

  async move(customerId: CustomerId, id: string, change: { dueAt: Date; checkAt: Date; words: string | null; note: string | null }): Promise<Commitment | null> {
    return this.#update(customerId, id, (r) => ({ ...r, dueAt: change.dueAt, checkAt: change.checkAt, words: change.words ?? r.words, note: change.note ?? r.note, moves: r.moves + 1 }));
  }

  async settled(customerId: CustomerId, limit: number): Promise<Commitment[]> {
    return this.rows
      .filter((r) => r.customerId === customerId && r.status !== "open")
      .sort((a, b) => b.closedAt!.getTime() - a.closedAt!.getTime())
      .slice(0, limit);
  }

  #update(customerId: CustomerId, id: string, f: (r: Commitment) => Commitment): Commitment | null {
    const i = this.rows.findIndex((r) => r.customerId === customerId && r.id === id && r.status === "open");
    if (i < 0) return null;
    this.rows[i] = f(this.rows[i]!);
    return this.rows[i]!;
  }
}

/** Results in memory: a person once per stage, counts as often as given. */
export class MemoryResults implements ResultRepository {
  readonly rows: ResultEntry[] = [];
  #id = 0;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async record(customerId: CustomerId, r: NewResult): Promise<{ entry: ResultEntry; added: boolean }> {
    const person = r.person?.trim() || null;
    const had = person && this.rows.find((x) => x.customerId === customerId && x.stage === r.stage && x.person?.toLowerCase() === person.toLowerCase());
    if (had) return { entry: had, added: false };
    const entry: ResultEntry = { id: String(++this.#id), customerId, ...r, person, count: person ? 1 : r.count, at: new Date(this.#now()) };
    this.rows.push(entry);
    return { entry, added: true };
  }

  async list(customerId: CustomerId, limit: number): Promise<ResultEntry[]> {
    return this.rows.filter((r) => r.customerId === customerId).reverse().slice(0, limit);
  }
}

/** Routes in memory, with routes.ts's arithmetic. */
export class MemoryRoutes implements RouteRepository {
  readonly rows: Route[] = [];
  #id = 0;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async log(customerId: CustomerId, name: string, result: RouteResult, note: string | null): Promise<Route> {
    const i = this.rows.findIndex((r) => r.customerId === customerId && routeKey(r.name) === routeKey(name));
    const before = i >= 0 ? this.rows[i]! : { id: String(++this.#id), customerId, name: name.trim(), status: "trying" as const, tries: 0, wins: 0, misses: 0, lastNote: null, updatedAt: new Date(this.#now()) };
    const row: Route = { ...before, ...afterTry(before, result), lastNote: note ?? before.lastNote, updatedAt: new Date(this.#now()) };
    if (i >= 0) this.rows[i] = row;
    else this.rows.push(row);
    return row;
  }

  async reopen(customerId: CustomerId, name: string, why: string): Promise<Route | null> {
    const i = this.rows.findIndex((r) => r.customerId === customerId && routeKey(r.name) === routeKey(name) && r.status === "spent");
    if (i < 0) return null;
    this.rows[i] = { ...this.rows[i]!, status: "trying", misses: SPENT_AFTER - 1, lastNote: `tried again: ${why}`, updatedAt: new Date(this.#now()) };
    return this.rows[i]!;
  }

  async get(customerId: CustomerId, name: string): Promise<Route | null> {
    return this.rows.find((r) => r.customerId === customerId && routeKey(r.name) === routeKey(name)) ?? null;
  }

  async list(customerId: CustomerId): Promise<Route[]> {
    return this.rows.filter((r) => r.customerId === customerId).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }
}

/** The searches runs made, in memory, newest first as Postgres gives them. */
export class MemorySearches implements SearchLog {
  readonly rows: (SearchRecord & { readonly customerId: CustomerId; readonly taskId: TaskId })[] = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async record(customerId: CustomerId, taskId: TaskId, agent: string, runs: readonly SearchRun[]): Promise<void> {
    for (const r of runs) this.rows.push({ customerId, taskId, agent, site: r.site, query: r.query, hits: r.hits, at: new Date(this.#now()) });
  }

  async recent(customerId: CustomerId, opts: { site?: string | null; days: number; limit: number }): Promise<SearchRecord[]> {
    const since = this.#now() - opts.days * 86_400_000;
    return this.rows
      .filter((r) => r.customerId === customerId && r.at.getTime() > since && (!opts.site || r.site === opts.site))
      .reverse()
      .slice(0, opts.limit)
      .map(({ agent, site, query, hits, at }) => ({ agent, site, query, hits, at }));
  }
}

/** What they share for their posts, as mq.assets keeps it. */
export class MemoryAssets implements AssetRepository {
  readonly assets: (Asset & { dropped: boolean })[] = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async add(a: NewAsset): Promise<Asset> {
    const asset = { ...a, reading: a.reading ?? null, id: randomUUID(), createdAt: new Date(this.#now()), dropped: false };
    this.assets.push(asset);
    return asset;
  }

  async get(id: string): Promise<Asset | null> {
    return this.assets.find((a) => a.id === id && !a.dropped) ?? null;
  }

  async list(customerId: CustomerId, limit: number): Promise<Asset[]> {
    return this.assets.filter((a) => a.customerId === customerId && !a.dropped).reverse().slice(0, limit);
  }

  async setReading(id: string, reading: ClipReading): Promise<void> {
    const a = this.assets.find((x) => x.id === id);
    if (a) this.assets[this.assets.indexOf(a)] = { ...a, reading };
  }

  async drop(customerId: CustomerId, id: string): Promise<boolean> {
    const a = this.assets.find((x) => x.id === id && x.customerId === customerId && !x.dropped);
    if (!a) return false;
    a.dropped = true;
    return true;
  }
}

/** Ideas for posts, as mq.ideas keeps them. */
export class MemoryIdeas implements IdeaRepository {
  readonly ideas: Idea[] = [];
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async add(i: NewIdea, status: IdeaStatus): Promise<Idea> {
    const idea: Idea = { ...i, assets: [...i.assets], id: randomUUID(), status, cardRef: null, draftId: null, createdAt: new Date(this.#now()), decidedAt: null };
    this.ideas.push(idea);
    return idea;
  }

  async get(id: string): Promise<Idea | null> {
    return this.ideas.find((i) => i.id === id) ?? null;
  }

  async list(customerId: CustomerId, limit: number): Promise<Idea[]> {
    return this.ideas.filter((i) => i.customerId === customerId).reverse().slice(0, limit);
  }

  async decide(customerId: CustomerId, id: string, status: IdeaStatus, draftId: string | null = null): Promise<Idea | null> {
    const at = this.ideas.findIndex((i) => i.id === id && i.customerId === customerId);
    if (at < 0) return null;
    const idea: Idea = { ...this.ideas[at]!, status, decidedAt: new Date(this.#now()), draftId: draftId ?? this.ideas[at]!.draftId };
    this.ideas[at] = idea;
    return idea;
  }

  async markShown(id: string, cardRef: string | null): Promise<void> {
    const at = this.ideas.findIndex((i) => i.id === id);
    if (at >= 0) this.ideas[at] = { ...this.ideas[at]!, cardRef };
  }
}

/** The outbox in memory, as Postgres keeps it: one line at a time for a draft or a find, claims that take one waiting. */
export class MemoryOutbox implements OutboxRepository {
  readonly items: OutboxItem[] = [];
  #next = 1;
  readonly #now: () => number;
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #find(ref: OutboxRef): OutboxItem | undefined {
    return this.items.find((i) => ("draftId" in ref ? i.draftId === ref.draftId : i.findId === ref.findId) && (i.status === "queued" || i.status === "sending"));
  }

  #set(id: string, patch: Partial<OutboxItem>): void {
    const at = this.items.findIndex((i) => i.id === id);
    if (at >= 0) this.items[at] = { ...this.items[at]!, ...patch, updatedAt: new Date(this.#now()) };
  }

  async add(item: NewOutboxItem): Promise<OutboxItem | null> {
    if (this.#find(item.ref)) return null;
    const now = new Date(this.#now());
    const added: OutboxItem = {
      id: String(this.#next++),
      customerId: item.customerId,
      draftId: "draftId" in item.ref ? item.ref.draftId : null,
      findId: "findId" in item.ref ? item.ref.findId : null,
      target: item.target ?? null,
      site: item.site,
      approved: item.approved,
      light: item.light ?? false,
      status: "queued",
      dueAt: item.dueAt ?? now,
      tries: 0,
      reason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.items.push(added);
    return added;
  }

  async of(ref: OutboxRef): Promise<OutboxItem | null> {
    return this.#find(ref) ?? null;
  }

  async due(now: Date, limit: number): Promise<OutboxItem[]> {
    return this.items.filter((i) => i.status === "queued" && i.dueAt <= now).sort((a, b) => Number(a.approved === "trust") - Number(b.approved === "trust") || a.dueAt.getTime() - b.dueAt.getTime() || Number(a.id) - Number(b.id)).slice(0, limit);
  }

  async active(customerId: CustomerId): Promise<OutboxItem[]> {
    return this.items.filter((i) => i.customerId === customerId && (i.status === "queued" || i.status === "sending"));
  }

  async sentSince(customerId: CustomerId, since: Date): Promise<{ site: string; light: boolean; at: Date }[]> {
    const last = new Map<string, { site: string; light: boolean; at: Date }>();
    for (const i of this.items) {
      if (i.customerId !== customerId || (i.status !== "sending" && i.status !== "done") || i.updatedAt <= since) continue;
      const key = `${i.site}|${i.light}`;
      if (!last.has(key) || last.get(key)!.at < i.updatedAt) last.set(key, { site: i.site, light: i.light, at: i.updatedAt });
    }
    return [...last.values()];
  }

  async claim(id: string): Promise<boolean> {
    const item = this.items.find((i) => i.id === id);
    if (item?.status !== "queued") return false;
    this.#set(id, { status: "sending" });
    return true;
  }

  async wait(id: string, dueAt: Date, reason: string, approved?: OutboxApproval): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    if (item?.status !== "queued" && item?.status !== "sending") return;
    this.#set(id, { status: "queued", dueAt, reason, ...(approved ? { approved } : {}) });
  }

  async settle(id: string, status: "done" | "dropped", reason: string): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    if (item?.status !== "queued" && item?.status !== "sending") return;
    this.#set(id, { status, reason, tries: item.tries + (status === "dropped" && item.status === "sending" ? 1 : 0) });
  }

  async drop(ref: OutboxRef, reason: string): Promise<boolean> {
    const item = this.#find(ref);
    if (item?.status !== "queued") return false;
    this.#set(item.id, { status: "dropped", reason });
    return true;
  }

  async leftSending(): Promise<OutboxItem[]> {
    return this.items.filter((i) => i.status === "sending");
  }
}

/** Says the same of every picture, and keeps what kinds it was shown; a sheet of a video's frames (asked about with a question of its own) gets `sheetSays`. */
export class FakePictures {
  says = "A screenshot of an X profile.";
  sheetSays = "One man talks to the camera in a kitchen.\nFACE_X: 0.4";
  sheetFails: string | null = null;
  readonly seen: string[] = [];
  readonly asked: (string | undefined)[] = [];

  async describe(_customerId: CustomerId, _bytes: Uint8Array, mimeType: string, ask?: string): Promise<string> {
    this.seen.push(mimeType);
    this.asked.push(ask);
    if (ask) {
      if (this.sheetFails) throw new Error(this.sheetFails);
      return this.sheetSays;
    }
    return this.says;
  }
}
