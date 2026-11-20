import type { Clock, CustomerId, Logger, NewOutboxItem, OutboxItem, OutboxRef, OutboxRepository } from "@mq/core";
import type { Errands } from "../lifecycle/errands.ts";
import type { Loop } from "../lifecycle/idle-sleeper.ts";
import { modelRest } from "../lib/model-rest.ts";
import { pauseFor } from "../lib/pause.ts";

/**
 * Everything goes up this far apart on one site, their taps too: live, 2026-11-01, seven Reddit replies sent on their
 * word went up 3 s apart, and moderators took five down within 35 minutes. What Quest sends by itself also waits this
 * far apart across sites: a person's pace.
 */
export const SITE_GAP_MS = 4 * 60_000;
// Between two sites nothing waits (the founder, 2026-11-13: "pauses make sense while working on a single site, not
// switching between them"): a send on another site goes as soon as the one before it is done.
export const ACROSS_GAP_MS = 0;
/**
 * The longest of those pauses: each one is drawn between the shortest and these, from the send it follows (pause.ts), so
 * nothing goes up on a beat (the founder, 2026-11-04: "random pauses between actions").
 */
export const SITE_GAP_MAX_MS = 11 * 60_000;
export const ACROSS_GAP_MAX_MS = 0;
/**
 * Sites whose words keep a shorter gap, at most this long (the founder, 2026-11-14, "Yes, cut it": Bluesky's 4 to 11
 * minutes held 19 introductions in line, about two hours of work, and nothing new was written meanwhile).
 */
export const QUICK_SITES: Readonly<Record<string, readonly [number, number]>> = {};
/**
 * A like or a follow is a tap, not words anyone reads: it follows what went up on a site after a shorter pause, and
 * across sites after a shorter one still, and words are not paced from it (else a run of likes would hold a reply back
 * for good). Live, 2026-11-06: at the gap words keep, 77 sends on Threads waited up to 83 minutes in line.
 */
export const LIGHT_GAP_MS: readonly [number, number] = [10_000, 45_000];
export const LIGHT_ACROSS_MS: readonly [number, number] = [0, 0];
/**
 * One site at a time (the founder, 2026-11-11: "if I approved 3 likes on TikTok and a DM on Instagram, it opens the
 * first one and does 3 likes, then closes the tab and open Instagram"): a site's likes follow each other within
 * `LIGHT_GAP_MS`, and anything for another site, a tap too, waits this long after the last send, so what is due on the
 * site at work goes first.
 */
export const SWITCH_SITE_MS = 0;
/** A send waits this long for their Chrome at most; then its card comes back for them to decide again. */
export const STALE_MS = 3 * 86_400_000;
/**
 * Words Quest sends by itself wait this long first, so they can be skimmed and struck where "Here's what I'm sending"
 * shows them (drafts/out-list.ts; the founder, 2026-11-18: "it goes out unless you strike something"). Short: a site's
 * own gap is longer, and someone waiting for an answer should not wait on a list nobody reads.
 */
export const SKIM_MS = 3 * 60_000;
/** How often the line is looked at while the agent is up, besides when a Chrome comes back and when something joins it. */
const PASS_MS = 15_000;
/** A Chrome that went away while it was sending is asked again after this. */
const AGAIN_MS = 30_000;
/** After a send, how long a run whose step waits for the front has their Chrome before the next send takes it. */
// With one run in their Chrome at a time (the task queue's `solo`), a minute is two to four of its steps: the line stays
// tight and the run still moves. At 150 s, five sites due at once went up over a quarter of an hour.
const RUN_SLICE_MS = 60_000;

/** A send the site turned away for now is tried again after this: its limits run by the day. */
export const LIMIT_WAIT_MS = 86_400_000;

/** The tap's answer when their Chrome is not there: it waits in line and goes when Chrome is back. */
export const QUEUED = "Queued: it goes up when your Chrome is back";

/**
 * What became of a send: it went up; it may have (held for them to look); it did not, and they heard why; their
 * Chrome was not there, so it waits again; the site takes no more of it for now, so it waits for that; or it should not
 * go any more (closed, trust taken back, a reply already there).
 */
export type SendOutcome = "sent" | "held" | "failed" | "waits" | "limited" | "dropped" | { readonly at: Date; readonly reason: string };

/** Who sends one kind of line (a draft's, a find's reply): the services that know how. */
export interface OutboxSender {
  /** The errand it runs as: the key its service checks `errands.running` by. */
  errand(item: OutboxItem): string;
  send(item: OutboxItem, stopping: AbortSignal): Promise<SendOutcome>;
  /** It waited too long and is out of line: its card comes back. */
  expired(item: OutboxItem): Promise<void>;
  /**
   * Out of line after a send that did not go up (failed, or held as uncertain): Your move shows it again. Its send
   * redrew the deck while it was still in line, which leaves out what is in line; live, 2026-10-31, a failed YouTube
   * reply was gone from the deck while the chat said to tap Post it there.
   */
  back?(item: OutboxItem): Promise<void>;
}

/**
 * One line for everything that goes out as the customer (`mq.outbox`). A tap, a draft the manager may send by itself,
 * a strong find's reply on trust, or their own words in a turn: each joins the line, and goes at once when it may.
 * While their Chrome is closed it waits, and goes when the Chrome is back (`kick`, from the broker), in the order it
 * came, under every rule a post keeps: each sender checks again what can change while it waited. Everything keeps a
 * person's pace on a site, and what Quest sends by itself across sites too, from the table, so a restart does not
 * start it over. Nothing that may have gone up is
 * ever sent again by itself. The founder, 2026-10-23: "a single common outbound queue for when chrome is inactive or
 * something else is happening, it picks it up when it gets back to work".
 */
export class Outbox implements Loop {
  readonly #store: OutboxRepository;
  readonly #errands: Errands;
  readonly #online: (customerId: CustomerId) => boolean;
  readonly #off: (customerId: CustomerId) => boolean;
  readonly #held: (customerId: CustomerId) => boolean;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #siteGapMs: number;
  readonly #acrossGapMs: number;
  readonly #siteGapMaxMs: number;
  readonly #acrossGapMaxMs: number;
  readonly #staleMs: number;
  readonly #skimMs: number;
  readonly #changed: (customerId: CustomerId) => void;
  readonly #switchMs: number;
  readonly #senders = new Map<"draft" | "find", OutboxSender>();
  /**
   * Whose send is going up now: the next one of theirs is claimed only once it ended. Live, 2026-11-14: ten taps in a
   * minute were all claimed at once and waited their turn in memory, so two Bluesky replies were due back to back with
   * no pause between them, and a restart held all nine that had not begun as "maybe sent".
   */
  readonly #going = new Set<string>();
  /** Whose words were held to be shown first: a drop names no customer, so these are told when one leaves the line. */
  readonly #listed = new Set<CustomerId>();
  /** When each customer's last send ended, and whether a run's step waits for the front of their Chrome. */
  readonly #ended = new Map<string, number>();
  readonly #sliceKick = new Map<string, NodeJS.Timeout>();
  readonly #stepWaiting: ((customerId: CustomerId) => boolean) | undefined;
  #timer: NodeJS.Timeout | null = null;
  #passing: Promise<void> | null = null;
  #again = false;

  constructor(
    deps: {
      store: OutboxRepository;
      errands: Errands;
      online: (customerId: CustomerId) => boolean;
      off: (customerId: CustomerId) => boolean;
      /** Their Chrome holds all work while they answer a first-day card (answering.ts): what is due waits for it, not fails. */
      held?: (customerId: CustomerId) => boolean;
      /** A run's browser step waits for the front of their Chrome (`ChromeBroker.stepWaiting`). */
      stepWaiting?: (customerId: CustomerId) => boolean;
      /** The line moved for a customer (something joined, went or left): "Here's what I'm sending" is drawn again. */
      changed?: (customerId: CustomerId) => void;
      clock: Clock;
      log: Logger;
    },
    /** The gaps' longest (`siteGapMaxMs`, `acrossGapMaxMs`): unsaid, each gap is its shortest, always. */
    opts: { siteGapMs?: number; acrossGapMs?: number; siteGapMaxMs?: number; acrossGapMaxMs?: number; staleMs?: number; skimMs?: number } = {},
  ) {
    this.#store = deps.store;
    this.#errands = deps.errands;
    this.#online = deps.online;
    this.#off = deps.off;
    this.#held = deps.held ?? (() => false);
    this.#stepWaiting = deps.stepWaiting;
    this.#clock = deps.clock;
    this.#log = deps.log;
    this.#siteGapMs = opts.siteGapMs ?? SITE_GAP_MS;
    this.#acrossGapMs = opts.acrossGapMs ?? ACROSS_GAP_MS;
    this.#siteGapMaxMs = Math.max(this.#siteGapMs, opts.siteGapMaxMs ?? this.#siteGapMs);
    this.#acrossGapMaxMs = Math.max(this.#acrossGapMs, opts.acrossGapMaxMs ?? this.#acrossGapMs);
    this.#staleMs = opts.staleMs ?? STALE_MS;
    this.#skimMs = opts.skimMs ?? 0;
    this.#changed = deps.changed ?? (() => undefined);
    // Tests pace by the gaps they give: only the real line (the longest gaps said) keeps to one site at a time.
    this.#switchMs = opts.siteGapMaxMs ? SWITCH_SITE_MS : 0;
  }

  /** Who sends a draft's line, and who a find's. */
  serve(kind: "draft" | "find", sender: OutboxSender): void {
    this.#senders.set(kind, sender);
  }

  /** It holds the agent up for nothing: what waits needs their Chrome, whose asking wakes the agent anyway. */
  get busy(): boolean {
    return false;
  }

  start(): void {
    this.#timer ??= setInterval(() => void this.kick(), PASS_MS);
    void this.kick();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#passing;
  }

  /**
   * Joins the line and goes at once when it may; `waits` when their Chrome is not there to take it. A tap (or their
   * words) on one that waits on trust makes it theirs, and it goes now. Or why it cannot join.
   */
  async enqueue(item: NewOutboxItem): Promise<{ readonly waits: boolean } | string> {
    let line = await this.#store.add(item);
    if (!line) {
      const there = await this.#store.of(item.ref);
      if (!there) return "it is already done";
      if (there.status === "sending") return "Already posting it";
      if (item.approved !== "trust") await this.#store.wait(there.id, this.#clock.now(), "tapped", item.approved);
      line = (await this.#store.of(item.ref)) ?? there;
    }
    this.#log.info("outbox.queued", { customerId: item.customerId, id: line.id, site: line.site, approved: line.approved });
    this.#changed(item.customerId);
    return { waits: (await this.#try(line)) === "waits" };
  }

  /**
   * Joins the line to go no sooner than `at` (a platform's day limit full: it goes when the day has room, not refused);
   * false when it is already going up or done.
   */
  async schedule(item: NewOutboxItem, at: Date, reason: string): Promise<boolean> {
    const line = (await this.#store.add({ ...item, dueAt: at })) ?? (await this.#store.of(item.ref));
    if (!line || line.status === "sending") return false;
    await this.#store.wait(line.id, at, reason, item.approved);
    this.#log.info("outbox.scheduled", { customerId: item.customerId, id: line.id, site: line.site, at: at.toISOString(), reason });
    return true;
  }

  /** Looks at the line now: something joined it, or a Chrome came back. Settles when that look is done. */
  kick(): Promise<void> {
    if (this.#passing) {
      this.#again = true;
      return this.#passing;
    }
    this.#passing = this.#pass()
      .catch((e) => this.#log.error("outbox.pass_failed", { error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        this.#passing = null;
        if (this.#again) {
          this.#again = false;
          void this.kick();
        }
      });
    return this.#passing;
  }

  /** Takes one out of line while it waits (they edit it, skip it, or replied by hand); true when it was waiting. */
  async drop(ref: OutboxRef, reason: string): Promise<boolean> {
    const dropped = await this.#store.drop(ref, reason);
    if (dropped) this.#log.info("outbox.dropped", { ...ref, reason });
    if (dropped) for (const id of this.#listed) this.#changed(id);
    return dropped;
  }

  /** What of theirs waits or goes up now, for their page. */
  waiting(customerId: CustomerId): Promise<OutboxItem[]> {
    return this.#store.active(customerId);
  }

  /** At start: what a stopped machine left sending may have gone up, so it is done (its card is held by its service). */
  async recover(): Promise<number> {
    const left = await this.#store.leftSending();
    for (const item of left) await this.#store.settle(item.id, "done", "uncertain: the agent stopped while it was sending");
    return left.length;
  }

  async #pass(): Promise<void> {
    for (const item of await this.#store.due(this.#clock.now(), 50)) {
      try {
        await this.#try(item);
      } catch (e) {
        this.#log.error("outbox.try_failed", { id: item.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  /** Sends it if it may go now: "started"; their Chrome is not there: "waits"; not yet, or not any more: "later" or "gone". */
  async #try(item: OutboxItem): Promise<"started" | "waits" | "later" | "gone"> {
    const sender = this.#senders.get(item.draftId ? "draft" : "find");
    if (!sender) return "later";
    const now = this.#clock.now().getTime();
    if (now - item.createdAt.getTime() > this.#staleMs) {
      await this.#store.settle(item.id, "dropped", "waited too long for their Chrome");
      this.#log.info("outbox.expired", { customerId: item.customerId, id: item.id });
      await sender.expired(item);
      return "gone";
    }
    // The poster needs a model: while the models rest, what is due waits rather than fail.
    if (this.#off(item.customerId) || this.#held(item.customerId) || modelRest.until()) return "later";
    if (!this.#online(item.customerId)) return "waits";
    // Words going up by themselves are shown first, for a moment: time to strike one.
    if (item.approved === "trust" && !item.light && this.#skimMs > 0 && now - item.createdAt.getTime() < this.#skimMs) {
      this.#listed.add(item.customerId);
      await this.#store.wait(item.id, new Date(item.createdAt.getTime() + this.#skimMs), "shown first: time to strike it");
      return "later";
    }
    const turn = await this.#turn(item, now);
    if (turn > now) {
      await this.#store.wait(item.id, new Date(turn), "its turn: a person's pace");
      return "later";
    }
    if (this.#going.has(item.customerId)) return "later";
    // A run whose step waits for the front gets a stretch of its own after each send, else it gets one step between two.
    const sliceLeft = RUN_SLICE_MS - (now - (this.#ended.get(item.customerId) ?? 0));
    if (item.approved !== "words" && sliceLeft > 0 && this.#stepWaiting?.(item.customerId)) {
      // The line is looked at again the moment the run's stretch is over, not at the next pass up to 15 s later.
      if (!this.#sliceKick.has(item.customerId)) {
        const t = setTimeout(() => { this.#sliceKick.delete(item.customerId); void this.kick(); }, sliceLeft + 50);
        t.unref();
        this.#sliceKick.set(item.customerId, t);
      }
      return "later";
    }
    this.#going.add(item.customerId);
    if (!(await this.#store.claim(item.id).catch(() => false))) {
      this.#going.delete(item.customerId);
      return "gone";
    }
    const started = this.#errands.run(sender.errand(item), async (stopping) => {
      let out: SendOutcome;
      try {
        out = await sender.send(item, stopping);
      } catch (e) {
        this.#log.error("outbox.send_failed", { id: item.id, error: e instanceof Error ? e.message : String(e) });
        out = "failed";
      } finally {
        this.#going.delete(item.customerId);
        this.#ended.set(item.customerId, this.#clock.now().getTime());
      }
      this.#log.info("outbox.sent", { customerId: item.customerId, id: item.id, outcome: typeof out === "object" ? `later: ${out.reason}` : out });
      this.#changed(item.customerId);
      if (typeof out === "object") await this.#store.wait(item.id, out.at, out.reason);
      else if (out === "waits") await this.#store.wait(item.id, new Date(this.#clock.now().getTime() + AGAIN_MS), "their Chrome went away");
      else if (out === "limited") await this.#store.wait(item.id, new Date(this.#clock.now().getTime() + LIMIT_WAIT_MS), "the site's limit");
      else await this.#store.settle(item.id, out === "sent" || out === "held" ? "done" : "dropped", out);
      if (out === "failed" || out === "held") await sender.back?.(item).catch((e: unknown) => this.#log.warn("outbox.back_failed", { id: item.id, error: e instanceof Error ? e.message : String(e) }));
      void this.kick();
    });
    if (started) return "started";
    this.#going.delete(item.customerId);
    // The same card is going up already (a retry tapped meanwhile): this line waits for it.
    await this.#store.wait(item.id, new Date(now + AGAIN_MS), "already going up");
    return "later";
  }

  /**
   * When the next thing may go here: a pause after the last on this site; by itself, a shorter one after any. A like or
   * a follow, on either side of the pause, makes it the light one. Each pause is drawn from the send it follows, the same
   * at every look.
   */
  async #turn(item: OutboxItem, now: number): Promise<number> {
    const since = new Date(now - Math.max(this.#siteGapMaxMs, this.#acrossGapMaxMs));
    let turn = 0;
    for (const last of await this.#store.sentSince(item.customerId, since)) {
      const at = last.at.getTime();
      const site = item.light || last.light ? pauseFor(`${at}|${last.site}|light`, ...LIGHT_GAP_MS) : Math.min(pauseFor(`${at}|${last.site}`, this.#siteGapMs, this.#siteGapMaxMs), QUICK_SITES[last.site] ? pauseFor(`${at}|${last.site}|quick`, ...QUICK_SITES[last.site]!) : Infinity);
      const across = item.light ? pauseFor(`${at}|across|light`, ...LIGHT_ACROSS_MS) : pauseFor(`${at}|across`, this.#acrossGapMs, this.#acrossGapMaxMs);
      turn = Math.max(turn, last.site === item.site ? at + site : Math.max(item.approved === "trust" ? at + across : 0, at + this.#switchMs));
    }
    return turn;
  }
}
