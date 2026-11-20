import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { ChromeError, type ChromeFailure, type ChromeJob, type ChromePost, type ChromePosted, type ChromeRead, type CustomerId, type ReplyPoster, type BrowserJob, type BrowserView, type BrowserTransport } from "@mq/core";
import { paceOf, type ReadPace } from "../platforms.ts";

export interface BrokerOptions {
  /** A Chrome counts as online this long after it last asked for work. */
  readonly onlineWindowMs: number;
  /** How long a page may take, from the moment the extension takes it. */
  readonly jobTimeoutMs: number;
  /** How long a job may wait for the extension to take it. */
  readonly queueTimeoutMs: number;
  /**
   * How long a job may wait for its site's turn, or for them to finish answering, while their Chrome takes other
   * work: past it, it fails as paced rather than hang the run that asked.
   */
  readonly turnTimeoutMs: number;
  /** How long a browser session keeps the front of their window between its steps (`FRONT_HOLD_MS`). */
  readonly frontHoldMs: number;
}

export const BROKER_DEFAULTS: BrokerOptions = { onlineWindowMs: 45_000, jobTimeoutMs: 90_000, queueTimeoutMs: 120_000, turnTimeoutMs: 300_000, frontHoldMs: 40_000 };

/** How many jobs a Chrome takes at once, each in a tab of its own: one per poller the extension runs. */
export const CHROME_TABS = 3;

/**
 * One thing in front at a time (the founder, 2026-11-11: "reduce the work in parallel to a single browser task at once
 * ... many websites have to be on foreground to render properly and allow you to click a button"). A browser session
 * (a run's, a post's) and a page read drawn on screen need the front of their window; whoever took it keeps it between
 * its steps for `frontHoldMs` (40 s), so another session's step does not push its page behind while its model thinks. With
 * others waiting, it keeps it `FRONT_MAX_MS` at most. Plain reading goes on in background tabs beside it.
 */
export const FRONT_MAX_MS = 4 * 60_000;

/** Who has the front of their window: a browser session, since when, how many steps of it are in their Chrome now, and when its last one ended. */
interface Front {
  session: string;
  since: number;
  busy: number;
  at: number;
}

/**
 * While they are answering an onboarding card, Quest's Chrome takes no work, so nothing comes to the front of their
 * screen or browses while they answer (the founder, 2026-10-23). `until` is when the hold ends as things stand, or
 * null when nothing holds.
 */
export interface BrowsingHold {
  until(customerId: CustomerId): number | null;
}

/** How fast Quest opens pages on a host; null when it may open them back to back. */
export type SitePace = (host: string) => ReadPace | null;

/** A job as the extension receives it: a page to read (no `kind`, as before posting existed), or a reply to post. */
export type IssuedJob =
  | (ChromeJob & { readonly id: string; readonly kind?: undefined })
  | { readonly id: string; readonly kind: "post"; readonly post: ChromePost }
  | { readonly id: string; readonly kind: "browser"; readonly browser: BrowserJob };

/** What the extension sends back: the read, the post, or why there is none. */
export type JobOutcome =
  | { readonly ok: true; readonly read: ChromeRead }
  | { readonly ok: true; readonly posted: ChromePosted }
  | { readonly ok: true; readonly view: BrowserView }
  | { readonly ok: false; readonly reason: string; readonly message: string };

interface Pending {
  readonly job: IssuedJob;
  /** The site it opens a page on; null for a step in a page already open, which opens nothing. */
  readonly site: string | null;
  /** When it was asked for. */
  readonly queuedAt: number;
  /** Background reading: after everyone else's. */
  readonly quiet: boolean;
  /** Hands the outcome to whoever asked, as what they asked for or as an error. */
  readonly settle: (outcome: JobOutcome) => void;
  readonly reject: (e: ChromeError) => void;
  timer: NodeJS.Timeout;
}

interface Waiter {
  readonly resolve: (job: IssuedJob | null) => void;
  readonly timer: NodeJS.Timeout;
}

interface Chrome {
  lastContact: number;
  /** When reads failed because their Chrome window was minimised or covered, newest last. */
  hidden: number[];
  /** Its pollers waiting for work, by slot: each takes one job at a time, in a tab of its own. */
  readonly waiters: Map<string, Waiter>;
  readonly queue: Pending[];
  readonly issued: Map<string, Pending>;
  /** Wakes the line when the next held or paced job's turn comes. */
  turn: NodeJS.Timeout | null;
}

/** A site's clock, for one customer: its pages in flight, when it may open the next, and those of the last ten minutes. */
interface Site {
  open: number;
  nextAt: number;
  recent: number[];
}

const TEN_MINUTES = 600_000;

const REASONS: ReadonlySet<string> = new Set<ChromeFailure>(["invalid_url", "blocked", "not_found", "timeout", "hidden", "limit", "login", "rate_limited", "refused", "unavailable"]);

const failure = (outcome: { reason: string; message: string }): ChromeError =>
  new ChromeError(REASONS.has(outcome.reason) ? (outcome.reason as ChromeFailure) : "unavailable", outcome.message);

/** An extension from before posting reads a post job as a page with no address, and says so. */
const outdated = (): ChromeError => new ChromeError("outdated", "the Quest extension in this Chrome is older than posting: it has to be reloaded or updated");

const DAY_MS = 24 * 3_600_000;

/** Why their Chrome gets nothing while they switched Quest off. */
export const SWITCHED_OFF = "they switched Quest off, so nothing happens in their Chrome until they switch it on";

const where = (job: IssuedJob): string => (job.kind === "post" ? job.post.url : job.kind === "browser" ? job.browser.url ?? "its browser session" : job.url);

/**
 * Reading asked for inside `QUIET.run(true, ...)` is background work (the matcher's searches): it goes after any run's
 * or watch's reading. Live, 2026-11-14: a run answering five people on X asked for three pages and waited six minutes
 * behind twenty searches the matcher had queued on X, each at the site's pace.
 */
export const QUIET = new AsyncLocalStorage<boolean>();

/** Which jobs go first: a post the customer is waiting on, then a session's step, then reading, then background reading. */
const rank = (job: IssuedJob, quiet = false): number => (job.kind === "post" ? 0 : job.kind === "browser" ? 1 : quiet ? 3 : 2);

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
};

/** The site a job opens a page on: a read's, a post's, a session's when it goes to an address. */
const siteOf = (job: IssuedJob): string | null =>
  job.kind === "post" ? hostOf(job.post.url) : job.kind === "browser" ? (job.browser.url ? hostOf(job.browser.url) : null) : hostOf(job.url);

/** Who answers a site's pace: its platform's (platforms.ts), so Reddit is read slower than a forum. */
const PLATFORM_PACE: SitePace = (host) => paceOf(host);

/**
 * Hands pages to read to each customer's Chrome and gives the reads back to whoever asked. The extension
 * long-polls for work (`next`) from a few pollers, each reading one page at a time in a tab of its own, and answers
 * (`complete`); a Chrome that has not asked for a while is offline, and asking it for a page fails at once rather
 * than hang a task. A reply to post (the customer's tap) goes ahead of any reading.
 *
 * Each site keeps its own clock: one page at a time there, a reader's pause between two, at most so many in ten
 * minutes (platforms.ts). So their Chrome reads several sites at once and none of them sees a burst; a job whose site
 * is not ready waits while the others go. While they answer an onboarding card (`BrowsingHold`) nothing is handed out.
 *
 * In memory: one agent machine holds every connection. A second machine would need the queue in the database.
 */
export class ChromeBroker implements ReplyPoster, BrowserTransport {
  readonly #chromes = new Map<string, Chrome>();
  /** The browser session of a post being written in their Chrome and the site it is on, by customer (`posting`). */
  readonly #posting = new Map<CustomerId, { readonly session: string; readonly site: string | null }>();
  /** Each customer's sites, kept across a reconnect: a Chrome that comes back does not start a site's pace over. */
  readonly #sites = new Map<string, Map<string, Site>>();
  /** Who has the front of each customer's window (`Front`). */
  readonly #front = new Map<string, Front>();
  /** When a run last asked for the front of each customer's Chrome (`stepWaiting`). */
  readonly #lastStep = new Map<string, number>();
  /** Customers who switched Quest off: their Chrome gets no work from Quest until it is on. */
  readonly #off = new Set<string>();
  readonly #o: BrokerOptions;
  readonly #now: () => number;
  readonly #pace: SitePace;
  readonly #hold: BrowsingHold | null;
  readonly #random: () => number;
  readonly #onOnline: ((customerId: CustomerId) => void)[] = [];

  constructor(
    options: Partial<BrokerOptions> = BROKER_DEFAULTS,
    now: () => number = Date.now,
    more: { pace?: SitePace; hold?: BrowsingHold; random?: () => number } = {},
  ) {
    this.#o = { ...BROKER_DEFAULTS, ...options };
    this.#now = now;
    this.#pace = more.pace ?? PLATFORM_PACE;
    this.#hold = more.hold ?? null;
    this.#random = more.random ?? Math.random;
  }

  /** Called when a customer's Chrome asks for work after being offline (or for the first time since the agent started). */
  whenOnline(listener: (customerId: CustomerId) => void): void {
    this.#onOnline.push(listener);
  }

  /**
   * True when the customer's Chrome asked for work recently, is asking now, or is at a page it took (until that page's
   * time runs out). Live, 2026-10-31: its three tabs on slow pages, nobody asking for 45 s, and Quest told them their
   * Chrome had gone quiet in the middle of the sweep, while it read on.
   */
  online(customerId: CustomerId): boolean {
    const c = this.#chromes.get(customerId);
    return Boolean(c && (c.waiters.size > 0 || c.issued.size > 0 || this.#now() - c.lastContact < this.#o.onlineWindowMs));
  }

  /** Every customer whose Chrome is online now (`online`). */
  onlineCustomers(): CustomerId[] {
    return [...this.#chromes.keys()].map((id) => id as CustomerId).filter((id) => this.online(id));
  }

  /**
   * Reads in the last day that failed because the customer's Chrome window was minimised
   * or covered. Only the customer can fix that, so the manager sees it on its board.
   */
  hiddenReads(customerId: CustomerId): { readonly count: number; readonly last: Date } | null {
    const c = this.#chromes.get(customerId);
    const recent = (c?.hidden ?? []).filter((t) => this.#now() - t < DAY_MS);
    return recent.length ? { count: recent.length, last: new Date(recent.at(-1)!) } : null;
  }

  #noteHidden(customerId: CustomerId): void {
    const c = this.#chromes.get(customerId);
    if (!c) return;
    c.hidden = [...c.hidden.filter((t) => this.#now() - t < DAY_MS), this.#now()].slice(-50);
  }

  lastContact(customerId: CustomerId): Date | null {
    const c = this.#chromes.get(customerId);
    return c ? new Date(c.lastContact) : null;
  }

  /** Reads a page in the customer's Chrome. Fails with "offline" at once when it is not connected. */
  read(customerId: CustomerId, job: ChromeJob): Promise<ChromeRead> {
    return this.#request(customerId, { ...job, id: randomUUID() }, (outcome) => {
      if (!outcome.ok && outcome.reason === "hidden") this.#noteHidden(customerId);
      if (!outcome.ok) throw failure(outcome);
      if ("read" in outcome) return outcome.read;
      throw new ChromeError("unavailable", "the extension answered a page to read with something else");
    });
  }

  /**
   * Posts as the customer (a reply, a post or a message), in their Chrome, ahead of any page waiting to be read.
   * Stopped (`signal`) while it waits to be taken, it is taken back and nothing went out; once their Chrome took it,
   * nobody can tell from here whether it went up.
   */
  post(customerId: CustomerId, post: ChromePost, signal?: AbortSignal): Promise<ChromePosted> {
    return this.#request(customerId, { id: randomUUID(), kind: "post", post }, (outcome) => {
      // An extension from before posts and messages takes one for a reply with nothing to go under.
      const older = outcome.ok === false && post.kind !== undefined && post.kind !== "reply" && /no post or comment to go under/.test(outcome.message);
      if (!outcome.ok) throw outcome.reason === "invalid_url" || older ? outdated() : failure(outcome);
      if ("posted" in outcome) return outcome.posted;
      throw outdated();
    }, signal);
  }

  browser(customerId: CustomerId, browser: BrowserJob): Promise<BrowserView> {
    return this.#request(customerId, { id: randomUUID(), kind: "browser", browser }, (outcome) => {
      if (!outcome.ok) throw outcome.reason === "invalid_url" ? new ChromeError("outdated", "Reload or update Quest's extension to work across forums, messengers and email.") : failure(outcome);
      if ("view" in outcome) return outcome.view;
      throw outdated();
    });
  }

  #request<T>(customerId: CustomerId, job: IssuedJob, unwrap: (outcome: JobOutcome) => T, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new ChromeError("unavailable", "stopped before the Chrome took it; nothing was sent"));
    if (this.#off.has(customerId)) return Promise.reject(new ChromeError("offline", SWITCHED_OFF));
    if (!this.online(customerId)) {
      return Promise.reject(new ChromeError("offline", "the customer's Chrome is not connected"));
    }
    const chrome = this.#chrome(customerId);
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        job,
        site: siteOf(job),
        queuedAt: this.#now(),
        quiet: QUIET.getStore() === true,
        settle: (outcome) => {
          try {
            resolve(unwrap(outcome));
          } catch (e) {
            reject(e);
          }
        },
        reject,
        timer: setTimeout(() => this.#expire(customerId, chrome, pending, "queue"), this.#o.queueTimeoutMs),
      };
      // In turn within its kind: posts first, then browser sessions, then reading, each in the order it asked.
      // Put at the front, the newest went first: a run asking step after step pushed another run's steps back.
      const at = chrome.queue.findIndex((p) => rank(p.job, p.quiet) > rank(job, pending.quiet));
      const front = this.#frontOf(pending);
      if (front && front !== this.#posting.get(customerId)?.session) this.#lastStep.set(customerId, this.#now());
      if (at < 0) chrome.queue.push(pending);
      else chrome.queue.splice(at, 0, pending);
      // Stopped: still in line, it is taken back; taken by their Chrome, it may already have gone through.
      signal?.addEventListener("abort", () => {
        const waiting = chrome.queue.indexOf(pending);
        if (waiting >= 0) chrome.queue.splice(waiting, 1);
        else if (!chrome.issued.delete(job.id)) return;
        else this.#closed(customerId, pending);
        clearTimeout(pending.timer);
        reject(waiting >= 0 ? new ChromeError("unavailable", "stopped before the Chrome took it; nothing was sent") : new ChromeError("uncertain", "stopped while the Chrome was at it; whether it went through is unknown"));
      }, { once: true });
      this.#dispatch(customerId, chrome);
    });
  }

  /** What this customer's Chrome is doing and what waits for it, for their page. */
  view(customerId: CustomerId): { readonly online: boolean; readonly doing: { readonly kind: string; readonly site: string | null } | null; readonly tabs: number; readonly waiting: number } {
    const c = this.#chromes.get(customerId);
    const issued = c ? [...c.issued.values()].at(-1) : undefined;
    return {
      online: this.online(customerId),
      doing: issued ? { kind: issued.job.kind ?? "read", site: hostOf(where(issued.job)) } : null,
      tabs: c?.issued.size ?? 0,
      waiting: c?.queue.length ?? 0,
    };
  }

  /**
   * Whether a run is working in front of their Chrome: a step or a drawn read of its own waits now, or one was asked
   * for in the last `withinMs` (between two steps its model thinks). The outbox asks before its next send: a post
   * being written takes the front as soon as it is free, so with sends due one after another a run got one step
   * between two of them (live, 2026-11-14: a run answering people on LinkedIn made 8 steps in 30 minutes).
   */
  stepWaiting(customerId: CustomerId, withinMs = 45_000): boolean {
    const posting = this.#posting.get(customerId)?.session;
    if (this.#now() - (this.#lastStep.get(customerId) ?? 0) < withinMs) return true;
    return (this.#chromes.get(customerId)?.queue ?? []).some((p) => {
      const front = this.#frontOf(p);
      return front !== null && front !== posting;
    });
  }

  /**
   * One of the extension's pollers asks for work: the next job whose turn it is, or null after `waitMs` with none.
   * A newer ask on the same slot answers the older one with null, and an ask whose request went away (`signal`)
   * stops waiting, so no page is handed to a poller that is no longer listening. An extension from before several
   * tabs polls with no slot: it is slot "0", one job at a time.
   */
  next(customerId: CustomerId, waitMs: number, signal?: AbortSignal, slot = "0"): Promise<IssuedJob | null> {
    const wasOnline = this.online(customerId);
    const chrome = this.#chrome(customerId);
    chrome.lastContact = this.#now();
    if (!wasOnline) for (const listener of this.#onOnline) listener(customerId);
    this.#release(chrome, slot, null);
    const at = this.#ready(customerId, chrome);
    if (at >= 0) {
      const [pending] = chrome.queue.splice(at, 1);
      this.#issue(customerId, chrome, pending!);
      this.#refresh(customerId, chrome);
      return Promise.resolve(pending!.job);
    }
    return new Promise<IssuedJob | null>((resolve) => {
      const waiter: Waiter = { resolve, timer: setTimeout(() => this.#release(chrome, slot, null, waiter), waitMs) };
      chrome.waiters.set(slot, waiter);
      signal?.addEventListener("abort", () => this.#release(chrome, slot, null, waiter));
      this.#dispatch(customerId, chrome);
    });
  }

  /** The extension's answer to a job. Returns false for a job nobody waits on any more. */
  complete(customerId: CustomerId, jobId: string, outcome: JobOutcome): boolean {
    const chrome = this.#chromes.get(customerId);
    const pending = chrome?.issued.get(jobId);
    if (!chrome || !pending) return false;
    chrome.lastContact = this.#now();
    chrome.issued.delete(jobId);
    clearTimeout(pending.timer);
    this.#closed(customerId, pending);
    pending.settle(outcome);
    this.#dispatch(customerId, chrome);
    return true;
  }

  /** Something that held work back changed (they answered the card): whatever can go now goes. */
  recheck(customerId: CustomerId): void {
    const chrome = this.#chromes.get(customerId);
    if (chrome) this.#dispatch(customerId, chrome);
  }

  /**
   * They switched Quest off (or on): off, their Chrome gets nothing from Quest, and what waits for it and was not taken
   * yet fails now, with nothing sent. A job their Chrome is already at finishes.
   */
  switchOff(customerId: CustomerId, off: boolean): void {
    const chrome = this.#chromes.get(customerId);
    // Every poll that waits is answered now, so their Chrome hears of the switch at once and not a poll later.
    for (const slot of [...(chrome?.waiters.keys() ?? [])]) this.#release(chrome!, slot, null);
    if (!off) {
      this.#off.delete(customerId);
      return;
    }
    this.#off.add(customerId);
    for (const p of chrome?.queue.splice(0) ?? []) {
      clearTimeout(p.timer);
      p.reject(new ChromeError("unavailable", `${SWITCHED_OFF}; nothing was sent`));
    }
  }

  /** The Chrome was disconnected: whatever waits on it fails now. */
  drop(customerId: CustomerId): void {
    const chrome = this.#chromes.get(customerId);
    if (!chrome) return;
    this.#chromes.delete(customerId);
    this.#front.delete(customerId);
    for (const slot of [...chrome.waiters.keys()]) this.#release(chrome, slot, null);
    if (chrome.turn) clearTimeout(chrome.turn);
    for (const p of chrome.issued.values()) this.#closed(customerId, p);
    for (const p of [...chrome.queue, ...chrome.issued.values()]) {
      clearTimeout(p.timer);
      p.reject(new ChromeError("offline", "the customer disconnected their Chrome"));
    }
  }

  #chrome(customerId: CustomerId): Chrome {
    let c = this.#chromes.get(customerId);
    if (!c) {
      c = { lastContact: this.#now(), hidden: [], waiters: new Map(), queue: [], issued: new Map(), turn: null };
      this.#chromes.set(customerId, c);
    }
    return c;
  }

  #site(customerId: CustomerId, host: string): Site {
    let sites = this.#sites.get(customerId);
    if (!sites) this.#sites.set(customerId, (sites = new Map()));
    let s = sites.get(host);
    if (!s) sites.set(host, (s = { open: 0, nextAt: 0, recent: [] }));
    const since = this.#now() - TEN_MINUTES;
    s.recent = s.recent.filter((t) => t > since);
    return s;
  }

  /**
   * When a job's turn comes, as far as its site goes: now (or earlier) when it may go, Infinity while its site has a
   * page in flight (its answer brings the next look). A post or a step in a page already open waits on no clock but
   * its site's page in flight; a post marks the site all the same.
   */
  #turnOf(customerId: CustomerId, p: Pending): number {
    return Math.max(this.#frontTurn(customerId, p), this.#siteTurn(customerId, p));
  }

  /** The browser session a job needs the front for; a drawn read is a session of one step; null for what reads in the background. */
  #frontOf(p: Pending): string | null {
    if (p.job.kind === "browser") return p.job.browser.session;
    if (p.job.kind === "post") return null;
    return p.job.drawn ? `read:${p.job.id}` : null;
  }

  /** When the front is free for a job: now, Infinity while another's step is in their Chrome, or when its hold lapses. */
  #frontTurn(customerId: CustomerId, p: Pending): number {
    const session = this.#frontOf(p);
    const f = this.#front.get(customerId);
    if (!session || !f || f.session === session) return 0;
    if (f.busy > 0) return Infinity;
    // A post being written takes the front as soon as it is free; a drawn read held it for its one page only.
    if (this.#posting.get(customerId)?.session === session || f.session.startsWith("read:")) return 0;
    return this.#now() - f.since > FRONT_MAX_MS ? 0 : f.at + this.#o.frontHoldMs;
  }

  #siteTurn(customerId: CustomerId, p: Pending): number {
    if (!p.site) return 0;
    const pace = this.#pace(p.site);
    if (!pace) return 0;
    const s = this.#site(customerId, p.site);
    if (s.open > 0) return Infinity;
    if (p.job.kind === "post") return 0;
    // A post's own steps wait on no pause and no cap, as a post job does: live, 2026-11-11, a LinkedIn like waited five
    // minutes behind the pages a run had read there (12 in ten minutes) and failed with nothing opened.
    if (p.job.kind === "browser" && this.#posting.get(customerId)?.session === p.job.browser.session) return 0;
    const capped = s.recent.length >= pace.per10Min ? s.recent[s.recent.length - pace.per10Min]! + TEN_MINUTES : 0;
    return Math.max(s.nextAt, capped);
  }

  /**
   * While Quest posts as them on a site (`url`), nothing else of theirs runs there or in front: the post's own steps go
   * once what is already at work there is done, and the rest waits its turn. Live, 2026-10-31: three X searches, drawn
   * in front, ran while a reply was written on X, and the poster gave up twice with nothing sent; alone, the same reply
   * went up at once. A read of another site in a background tab goes on (live, 2026-11-04: a LinkedIn reply held every
   * read for 8 minutes, and an X search failed after waiting 5). Returns what ends it.
   */
  posting(customerId: CustomerId, session: string, url?: string): () => void {
    const mine = { session, site: url ? hostOf(url) : null };
    this.#posting.set(customerId, mine);
    return () => {
      if (this.#posting.get(customerId) !== mine) return;
      this.#posting.delete(customerId);
      this.recheck(customerId);
    };
  }

  /**
   * Whether a job may go while they are being posted for: the post's own steps, a post, or a read in the background
   * of a site other than the post's. Another run's browser steps wait: a fill or a click comes to the front.
   */
  #forPost(customerId: CustomerId, p: Pending): boolean {
    const now = this.#posting.get(customerId);
    if (!now || p.job.kind === "post") return true;
    if (p.job.kind === "browser") return p.job.browser.session === now.session;
    return now.site !== null && p.site !== null && p.site !== now.site && !p.job.drawn;
  }

  /** The first job in line whose turn it is, or -1. Its turn not come, a job lets the ones behind it go. */
  #ready(customerId: CustomerId, chrome: Chrome): number {
    if (this.#held(customerId) !== null) return -1;
    if ([...chrome.issued.values()].some((p) => !this.#forPost(customerId, p))) return -1;
    const now = this.#now();
    return chrome.queue.findIndex((p) => this.#forPost(customerId, p) && this.#turnOf(customerId, p) <= now);
  }

  #held(customerId: CustomerId): number | null {
    const until = this.#hold?.until(customerId) ?? null;
    return until !== null && until > this.#now() ? until : null;
  }

  /** Hands what may go to the pollers waiting, and sets the line to look again when the next one's turn comes. */
  #dispatch(customerId: CustomerId, chrome: Chrome): void {
    if (chrome.turn) {
      clearTimeout(chrome.turn);
      chrome.turn = null;
    }
    while (chrome.waiters.size) {
      const at = this.#ready(customerId, chrome);
      if (at < 0) break;
      const [slot] = chrome.waiters.keys();
      const [pending] = chrome.queue.splice(at, 1);
      this.#issue(customerId, chrome, pending!);
      this.#release(chrome, slot!, pending!.job);
    }
    // Only a poller waiting can take what comes due: with none, the next ask looks for itself.
    if (!chrome.queue.length || !chrome.waiters.size) return;
    const held = this.#held(customerId);
    // While a post is written, what waits on it is looked at again when its steps come or the work in flight ends.
    const next = held ?? Math.min(...chrome.queue.filter((p) => this.#forPost(customerId, p)).map((p) => this.#turnOf(customerId, p)));
    // Looked at again at least every minute: a hold can end sooner than it said.
    if (Number.isFinite(next)) chrome.turn = setTimeout(() => this.#dispatch(customerId, chrome), Math.min(60_000, Math.max(0, next - this.#now()) + 5));
  }

  #issue(customerId: CustomerId, chrome: Chrome, pending: Pending): void {
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this.#expire(customerId, chrome, pending, "read"), this.#o.jobTimeoutMs);
    chrome.issued.set(pending.job.id, pending);
    const session = this.#frontOf(pending);
    if (session) {
      const f = this.#front.get(customerId);
      if (f?.session === session) f.busy++;
      else this.#front.set(customerId, { session, since: this.#now(), busy: 1, at: this.#now() });
    }
    if (!pending.site) return;
    const pace = this.#pace(pending.site);
    if (!pace) return;
    const s = this.#site(customerId, pending.site);
    const now = this.#now();
    s.open++;
    // A page opened to post as them is not reading: it does not use up the site's pages of ten minutes (live,
    // 2026-11-11: LinkedIn's likes, now seconds apart, filled its 12, and seven reads of a run waited 5 minutes and failed).
    if (!(pending.job.kind === "browser" && this.#posting.get(customerId)?.session === pending.job.browser.session)) s.recent.push(now);
    const [lo, hi] = pace.gapMs;
    s.nextAt = now + lo + this.#random() * (hi - lo);
  }

  /** A job's page is done with (answered, timed out, stopped): its site may open the next once its pause is over. */
  #closed(customerId: CustomerId, pending: Pending): void {
    const f = this.#front.get(customerId);
    if (f && f.session === this.#frontOf(pending)) {
      f.busy = Math.max(0, f.busy - 1);
      f.at = this.#now();
      // A session closed, or a drawn page read: the front is free at once.
      if (!f.busy && (f.session.startsWith("read:") || (pending.job.kind === "browser" && pending.job.browser.action?.kind === "close"))) this.#front.delete(customerId);
    }
    if (!pending.site || !this.#pace(pending.site)) return;
    const s = this.#site(customerId, pending.site);
    s.open = Math.max(0, s.open - 1);
  }

  /**
   * The Chrome took a job: what waits behind it waits in a line that moves, not on a Chrome that went away, so its
   * time to be taken counts from now. With several runs at work, one step could wait behind the others' past two minutes.
   */
  #refresh(customerId: CustomerId, chrome: Chrome): void {
    for (const p of chrome.queue) {
      clearTimeout(p.timer);
      p.timer = setTimeout(() => this.#expire(customerId, chrome, p, "queue"), this.#o.queueTimeoutMs);
    }
  }

  /** Answers a poller (with a job, or null), unless `only` says which ask it was and a newer one took its place. */
  #release(chrome: Chrome, slot: string, job: IssuedJob | null, only?: Waiter): void {
    const w = chrome.waiters.get(slot);
    if (!w || (only && w !== only)) return;
    chrome.waiters.delete(slot);
    clearTimeout(w.timer);
    chrome.lastContact = this.#now();
    w.resolve(job);
  }

  #expire(customerId: CustomerId, chrome: Chrome, pending: Pending, stage: "queue" | "read"): void {
    if (stage === "queue") {
      const at = chrome.queue.indexOf(pending);
      if (at < 0) return;
      // Their Chrome is asking for work and this one waits for its site's turn, or for them to finish answering: it
      // keeps its place, for a while.
      const waited = this.#now() - pending.queuedAt;
      if (this.online(customerId) && waited < this.#o.turnTimeoutMs) {
        pending.timer = setTimeout(() => this.#expire(customerId, chrome, pending, "queue"), Math.min(this.#o.queueTimeoutMs, this.#o.turnTimeoutMs - waited));
        return;
      }
      chrome.queue.splice(at, 1);
      if (this.online(customerId)) {
        const why = this.#held(customerId) !== null
          ? "their Chrome waits while they answer Quest's questions in the chat, and they were still at it"
          : `Quest reads ${pending.site ?? "that site"} at a person's pace, and this page's turn did not come in time: read another site meanwhile, or come back to it later`;
        pending.reject(new ChromeError("rate_limited", why));
        return;
      }
      pending.reject(new ChromeError("offline", "the customer's Chrome was silent and did not take the job (nobody can tell from here whether it is closed, asleep or can't reach Quest)"));
      return;
    }
    if (!chrome.issued.delete(pending.job.id)) return;
    this.#closed(customerId, pending);
    pending.reject(new ChromeError("timeout", `the customer's Chrome did not finish ${pending.job.kind === "post" ? "posting on" : "reading"} ${where(pending.job)} in time`));
    this.#dispatch(customerId, chrome);
  }
}
