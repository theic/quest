import { forLanguage } from "@mq/i18n";
import { sourceLabel, WORK_BUTTON, type AgentPace, type BoardRepository, type ChannelAddress, type Clock, type CustomerId, type CustomerRepository, type Logger } from "@mq/core";
import type { ChannelRegistry } from "../conversation/channel-registry.ts";
import { clip, errorText } from "../lib/sleeper.ts";

/** One run the board follows: a teammate's task, or the poster putting one card up. */
export interface WorkRun {
  readonly id: string;
  readonly customerId: CustomerId;
  readonly agent: string;
  /** In their language already (a task's), or words their language has (the poster's). */
  readonly title: string | Doing;
}

/** What the task runner and the poster tell the board as a run goes. Never throws: a board is never worth failing work over. */
export interface TaskProgress {
  /** A run began; `budget` is the model calls it may make. */
  started(run: WorkRun, budget: number): void;
  /** One model call ended. */
  step(id: string): void;
  /** A tool call started: what the run is doing now. */
  tool(id: string, name: string, args: unknown): void;
  /** Waiting its turn to act on a site another run is acting on (site-lanes.ts); null when its turn came. */
  waiting?(id: string, site: string | null): void;
  /** The run stopped, whatever the reason; `finished`: with its report. */
  stopped(id: string, finished: boolean): void;
}

/** What the manager's turn tells the board: Quest itself thinking, and what it does in the turn. */
export interface ManagerActivity {
  turnStarted(customerId: CustomerId): void;
  turnTool(customerId: CustomerId, name: string, args: unknown): void;
  turnEnded(customerId: CustomerId): void;
}

type Translate = (source: string, values?: Record<string, string | number>) => string;

/** What a run is doing, as words the customer's language has (an English source and its values). */
export interface Doing {
  readonly text: string;
  readonly values?: Readonly<Record<string, string>>;
}

interface Row {
  readonly customerId: CustomerId;
  readonly agent: string;
  readonly title: string | Doing;
  readonly budget: number;
  readonly startedAt: number;
  steps: number;
  doing: Doing | null;
  /** The last page it opened, for what it does there next. */
  place: string | null;
  /** The site of that page: where it works now. */
  site: string | null;
  /** The site it waits to act on, while another run acts there. */
  waitingFor: string | null;
  /** The share shown last: progress never goes back. */
  shown: number;
  /** Finished with its report: shown done for the grace, then dropped. */
  doneAt: number | null;
}

interface Turn {
  readonly since: number;
  doing: Doing | null;
  place: string | null;
  site: string | null;
}

interface Chat {
  readonly rows: Map<string, Row>;
  turn: Turn | null;
  /** The button's words up now: undefined until known, null for its usual name, STALE for words left from before a restart. */
  label: string | null | undefined;
  /** Where the button is. */
  to: ChannelAddress | null;
  /** When a button whose work is over goes back to its usual name. */
  resetAt: number | null;
  /** The chat has no button to show work on (an agent on a laptop): the page still shows it. */
  unsupported: boolean;
  /** Its chat calls, one at a time. */
  chain: Promise<void>;
}

export interface TaskBoardOptions {
  /** How long a button keeps saying work runs once it is over, for the next run of the same work (new instructions, an answer). */
  readonly graceMs: number;
  /** After a restart, how long a button left saying work runs waits for that work to start again. */
  readonly startupGraceMs: number;
  readonly tickMs: number;
}

export const TASK_BOARD_DEFAULTS: TaskBoardOptions = { graceMs: 15_000, startupGraceMs: 90_000, tickMs: 2_000 };

/** Words a button had before the agent restarted: never the words it wants now. */
const STALE = "\u0000";

/** A teammate's runs are timed once it has this many. */
const MIN_RUNS = 3;
const PACE_WINDOW_MS = 14 * 24 * 3_600_000;
const PACE_TTL_MS = 15 * 60_000;
/** Short of done until it is done. */
const CAP = 0.95;

/** "reddit.com/r/SaaS", "tally.so": where a page is, as short as it can be said. */
export function placeOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const sub = /^\/(r|u|user)\/([^/]+)/.exec(u.pathname);
    return sub && host.endsWith("reddit.com") ? `${host}/${sub[1]}/${sub[2]}` : host;
  } catch {
    return null;
  }
}

/** "x.com": the site a page is on. */
export function siteOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).hostname.replace(/^(www|old|new|mobile|m)\./, "");
  } catch {
    return null;
  }
}

/** What the poster's steps and the manager's own tools say it is doing, where the teammates' tools do not say it. */
const STEPS: Readonly<Record<string, string>> = {
  inspect: "Getting it ready on {place}",
  prepare: "Getting it ready on {place}",
  publish: "Sending it on {place}",
  confirm_post: "Checking it went up",
  confirm_visual: "Checking it went up",
  start_task: "Briefing a teammate",
  draft: "Writing a draft",
  send_draft: "Sending a draft",
  message_user: "Writing to you",
  best_people: "Going through finds",
  show_finds: "Going through finds",
};

/** What a tool call says the run is doing; null for its own bookkeeping (plans, notes), which changes nothing shown. */
export function doingOf(name: string, args: unknown, place: string | null): Doing | null {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  switch (name) {
    case "search_posts": {
      const source = typeof a["source"] === "string" ? a["source"] : "web";
      const query = typeof a["query"] === "string" ? clip(a["query"].trim(), 40) : "";
      // The web has a sentence of its own: "the web" would not fit every language's "on {where}".
      if (source === "web") return query ? { text: "Searching the web for “{query}”", values: { query } } : { text: "Searching the web" };
      const where = sourceLabel(source, "");
      return query ? { text: "Searching {where} for “{query}”", values: { where, query } } : { text: "Searching {where}", values: { where } };
    }
    case "read_page":
    case "read_site":
    case "browser_open": {
      const at = placeOf(a["url"]);
      return at ? { text: "Reading {place}", values: { place: at } } : null;
    }
    case "browser_act":
    case "browser_observation":
    case "read_visual":
      return place ? { text: "Looking through {place}", values: { place } } : { text: "Looking through the page" };
    case "save_find":
      return { text: "Saving a find" };
    case "save_place":
      return { text: "Saving a place to post" };
    case "outreach_draft":
      return { text: "Writing a draft" };
    case "ask_human":
      return { text: "Asking you a question" };
    default: {
      const step = STEPS[name];
      if (!step) return null;
      return step.includes("{place}") ? (place ? { text: step, values: { place } } : null) : { text: step };
    }
  }
}

/**
 * How far a run is, and how long it has left: by its teammate's past runs (eight in ten finish within p80), and by
 * the pace of its own steps were it to use its whole budget, whichever ends sooner. The share follows from the time
 * left, so the bar and the minutes agree; it stops short of full until the run is over.
 */
export function estimate(row: { readonly steps: number; readonly budget: number; readonly startedAt: number }, pace: AgentPace | undefined, now: number): { share: number; leftMs: number | null; late: boolean } {
  const elapsed = Math.max(0, now - row.startedAt);
  const byPace = pace && pace.runs >= MIN_RUNS ? pace.p80Ms - elapsed : null;
  const bySteps = row.steps >= MIN_RUNS ? (elapsed / row.steps) * Math.max(0, row.budget - row.steps) : null;
  const known = [byPace, bySteps].filter((x): x is number => x !== null);
  const left = known.length ? Math.max(0, Math.min(...known)) : null;
  const share = left === null ? row.steps / row.budget : elapsed + left > 0 ? elapsed / (elapsed + left) : 0;
  return { share: Math.min(CAP, share), leftMs: left, late: byPace !== null && byPace <= 0 };
}

const cleanTitle = (title: string): string => clip(title.replace(/[*`_\n]+/g, " ").replace(/\s+/g, " ").trim(), 60);

/**
 * The button's words while work runs: how many runs are at it ("2 working"), and its usual "Quest" once none are.
 * Short, because a phone shows the button beside the message box: "Quest · 2 working" was cut to "Quest · 2 …".
 */
export const workLabel = (count: number, t: Translate): string | null => (count > 0 ? t("{count} working", { count }) : null);

/** One run as the customer's page shows it, live. */
export interface LiveRun {
  readonly id: string;
  readonly agent: string;
  readonly title: string;
  /** 0 to 1: full only when done. */
  readonly share: number;
  readonly leftMs: number | null;
  readonly late: boolean;
  readonly done: boolean;
  /** What it does now, in their language. */
  readonly doing: string | null;
  /** The site it works on now. */
  readonly site: string | null;
  /** The site it waits its turn to act on. */
  readonly waitingFor: string | null;
  readonly startedAt: string;
}

/** Quest itself, in a turn: what it does now. */
export interface LiveManager {
  readonly busy: boolean;
  readonly doing: string | null;
  readonly site: string | null;
  readonly since: string | null;
}

export interface LiveWork {
  readonly manager: LiveManager;
  readonly runs: readonly LiveRun[];
}

const working = (c: Chat): number => [...c.rows.values()].filter((r) => r.doneAt === null).length;

export interface TaskBoardDeps {
  readonly channels: ChannelRegistry;
  readonly customers: Pick<CustomerRepository, "get" | "primaryChannel">;
  readonly boards: BoardRepository;
  /** How long each teammate's runs took since then (the task queue's paces). */
  readonly paces: (since: Date) => Promise<AgentPace[]>;
  readonly clock: Clock;
  readonly log: Logger;
}

/**
 * The work going on for each customer, kept in memory as it goes: every run of their team (what it does now, how
 * far it is, the site it is on), and Quest's own turn. Their page (http/glass-routes.ts) draws it live, and while
 * runs are at work their chat's Quest button says how many ("2 working"), back to "Quest" once the work is
 * over: no message, no pin, nothing in the chat to scroll past. Where a button says work runs is kept, so a
 * restart puts it right; progress boards an older version pinned are taken down at start.
 */
export class TaskBoard implements TaskProgress, ManagerActivity {
  readonly #d: TaskBoardDeps;
  readonly #o: TaskBoardOptions;
  readonly #chats = new Map<CustomerId, Chat>();
  readonly #rows = new Map<string, Row>();
  #paces: { at: number; value: AgentPace[] } | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #adopting: Promise<void> = Promise.resolve();

  constructor(deps: TaskBoardDeps, options: Partial<TaskBoardOptions> = {}) {
    this.#d = deps;
    this.#o = { ...TASK_BOARD_DEFAULTS, ...options };
  }

  /** Takes up what a restart left (buttons saying work runs, old pinned boards), then ticks. */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.#o.tickMs);
    this.#timer.unref?.();
    this.#adopting = this.#adopt();
  }

  /** Puts back the buttons whose work is over; a button of running work keeps its words, for after the restart. */
  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const [id, c] of this.#chats) {
      if (working(c)) continue;
      c.resetAt = null;
      this.#enqueue(id, c, () => this.#label(id, c));
    }
    await this.settled();
  }

  /** While a button says work runs, or is about to stop saying it: a sleeping machine would leave it there. */
  get busy(): boolean {
    return [...this.#chats.values()].some((c) => working(c) > 0 || c.resetAt !== null || (c.label !== null && c.label !== undefined));
  }

  started(run: WorkRun, budget: number): void {
    const chat = this.#chat(run.customerId);
    // New work: what finished before leaves the page.
    for (const [id, r] of chat.rows) if (r.doneAt !== null) chat.rows.delete(id);
    const row: Row = { customerId: run.customerId, agent: run.agent, title: typeof run.title === "string" ? cleanTitle(run.title) : run.title, budget, startedAt: this.#now(), steps: 0, doing: null, place: null, site: null, waitingFor: null, shown: 0, doneAt: null };
    this.#rows.set(run.id, row);
    chat.rows.set(run.id, row);
    chat.resetAt = null;
    this.#enqueue(run.customerId, chat, () => this.#label(run.customerId, chat));
  }

  step(id: string): void {
    const row = this.#rows.get(id);
    if (row) row.steps++;
  }

  tool(id: string, name: string, args: unknown): void {
    const row = this.#rows.get(id);
    if (!row) return;
    const url = (args as Record<string, unknown> | null)?.["url"];
    row.place = placeOf(url) ?? row.place;
    row.site = siteOf(url) ?? row.site;
    row.waitingFor = null;
    row.doing = doingOf(name, args, row.place) ?? row.doing;
  }

  waiting(id: string, site: string | null): void {
    const row = this.#rows.get(id);
    if (!row) return;
    row.waitingFor = site;
    if (site) row.doing = { text: "Waiting for its turn on {place}", values: { place: site } };
  }

  stopped(id: string, finished: boolean): void {
    const row = this.#rows.get(id);
    if (!row) return;
    this.#rows.delete(id);
    const chat = this.#chat(row.customerId);
    // Finished with its report: it shows done for the grace; a run stopped short (a question, a cancel) just leaves.
    if (finished) row.doneAt = this.#now();
    else chat.rows.delete(id);
    if (working(chat)) return this.#enqueue(row.customerId, chat, () => this.#label(row.customerId, chat));
    // The last of the work: the button keeps its words for the grace, for the next run of the same work.
    chat.resetAt = this.#now() + this.#o.graceMs;
  }

  turnStarted(customerId: CustomerId): void {
    this.#chat(customerId).turn = { since: this.#now(), doing: null, place: null, site: null };
  }

  turnTool(customerId: CustomerId, name: string, args: unknown): void {
    const turn = this.#chats.get(customerId)?.turn;
    if (!turn) return;
    const url = (args as Record<string, unknown> | null)?.["url"];
    turn.place = placeOf(url) ?? turn.place;
    turn.site = siteOf(url) ?? turn.site;
    turn.doing = doingOf(name, args, turn.place) ?? turn.doing;
  }

  turnEnded(customerId: CustomerId): void {
    const chat = this.#chats.get(customerId);
    if (!chat) return;
    chat.turn = null;
    this.#forgetIfIdle(customerId, chat);
  }

  /** The work going on for a customer now, for their page, in their language. */
  async live(customerId: CustomerId, language: string | null): Promise<LiveWork> {
    const chat = this.#chats.get(customerId);
    const t: Translate = forLanguage(language);
    const now = this.#now();
    const said = (d: Doing | null): string | null => (d ? t(d.text, d.values) : null);
    const paces = chat?.rows.size ? await this.#pace() : [];
    const runs = [...(chat?.rows ?? new Map<string, Row>())].map(([id, row]): LiveRun => {
      const done = row.doneAt !== null;
      const e = done ? { share: 1, leftMs: 0, late: false } : estimate(row, paces.find((p) => p.agent === row.agent), now);
      if (!done) row.shown = Math.max(row.shown, e.share);
      const title = typeof row.title === "string" ? row.title : t(row.title.text, row.title.values);
      return { id, agent: row.agent, title, share: done ? 1 : row.shown, leftMs: e.leftMs, late: e.late, done, doing: done ? null : said(row.doing) ?? t("Starting"), site: row.site, waitingFor: row.waitingFor, startedAt: new Date(row.startedAt).toISOString() };
    });
    const turn = chat?.turn ?? null;
    return {
      manager: { busy: Boolean(turn), doing: turn ? said(turn.doing) ?? t("Thinking") : null, site: turn?.site ?? null, since: turn ? new Date(turn.since).toISOString() : null },
      runs,
    };
  }

  /** Puts back the buttons whose work is over, and drops finished runs once their grace is up; the timer calls it, and tests do. */
  tick(): Promise<void> {
    const now = this.#now();
    for (const [id, c] of this.#chats) {
      for (const [runId, r] of c.rows) if (r.doneAt !== null && now - r.doneAt >= this.#o.graceMs) c.rows.delete(runId);
      if (!working(c) && c.resetAt !== null && now >= c.resetAt) {
        c.resetAt = null;
        this.#enqueue(id, c, () => this.#label(id, c));
      } else this.#forgetIfIdle(id, c);
    }
    return this.settled();
  }

  /** Every chat call so far, done. */
  async settled(): Promise<void> {
    await this.#adopting;
    await Promise.all([...this.#chats.values()].map((c) => c.chain));
  }

  #now(): number {
    return this.#d.clock.now().getTime();
  }

  #chat(customerId: CustomerId): Chat {
    let c = this.#chats.get(customerId);
    if (!c) {
      c = { rows: new Map(), turn: null, label: undefined, to: null, resetAt: null, unsupported: false, chain: Promise.resolve() };
      this.#chats.set(customerId, c);
    }
    return c;
  }

  #enqueue(customerId: CustomerId, chat: Chat, work: () => Promise<void>): void {
    chat.chain = chat.chain.then(work).catch((e: unknown) => this.#d.log.warn("board.failed", { customerId, error: errorText(e) }));
  }

  /** A chat with nothing going on and its button at its usual name holds nothing worth keeping. */
  #forgetIfIdle(customerId: CustomerId, chat: Chat): void {
    if (!chat.rows.size && !chat.turn && chat.resetAt === null && (chat.label === null || chat.label === undefined || chat.unsupported)) this.#chats.delete(customerId);
  }

  /** Sets the button's words to what the work wants now: how many runs are at it, or its usual name. */
  async #label(customerId: CustomerId, chat: Chat): Promise<void> {
    const count = working(chat);
    // Within the grace a button keeps its words: the next run of the same work comes in it.
    if (!count && chat.resetAt !== null) return;
    const customer = count ? await this.#d.customers.get(customerId) : null;
    const want = workLabel(count, forLanguage(customer?.language ?? null));
    // A button never shown says nothing yet: its usual name is up already.
    if (want === chat.label || (want === null && chat.label === undefined) || (chat.unsupported && want !== null)) return this.#forgetIfIdle(customerId, chat);
    const to = chat.to ?? (await this.#d.customers.primaryChannel(customerId));
    if (!to) return;
    chat.to = to;
    const shown = await this.#d.channels.get(to.kind).showWork(to, want);
    if (!shown) {
      chat.unsupported = true;
      chat.label = null;
      if (want === null) await this.#d.boards.clear(customerId, WORK_BUTTON);
      return this.#forgetIfIdle(customerId, chat);
    }
    const was = chat.label;
    chat.label = want;
    if (want !== null && (was === null || was === undefined)) await this.#d.boards.save(customerId, { to, ref: WORK_BUTTON });
    if (want === null) {
      await this.#d.boards.clear(customerId, WORK_BUTTON);
      this.#d.log.info("board.idle", { customerId });
    } else this.#d.log.info("board.working", { customerId, runs: count });
    this.#forgetIfIdle(customerId, chat);
  }

  async #adopt(): Promise<void> {
    try {
      const left = await this.#d.boards.list();
      const at = this.#now() + this.#o.startupGraceMs;
      for (const { customerId, board } of left) {
        const c = this.#chat(customerId);
        if (board.ref !== WORK_BUTTON) {
          // A progress board pinned by a version before the button: it comes down now.
          this.#enqueue(customerId, c, async () => {
            await this.#d.channels.get(board.to.kind).removeBoard(board.to, board.ref);
            await this.#d.boards.clear(customerId, board.ref);
            this.#d.log.info("board.removed", { customerId, ref: board.ref });
            this.#forgetIfIdle(customerId, c);
          });
          continue;
        }
        c.to = board.to;
        if (c.label === undefined) c.label = STALE;
        if (!working(c)) c.resetAt = at;
      }
      if (left.length) this.#d.log.info("board.adopted", { chats: left.length });
    } catch (e) {
      this.#d.log.warn("board.adopt_failed", { error: errorText(e) });
    }
  }

  async #pace(): Promise<AgentPace[]> {
    const now = this.#now();
    if (this.#paces && now - this.#paces.at < PACE_TTL_MS) return this.#paces.value;
    const value = await this.#d.paces(new Date(now - PACE_WINDOW_MS)).catch(() => []);
    this.#paces = { at: now, value };
    return value;
  }
}
