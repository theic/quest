import type { Clock, CustomerId, Logger } from "@mq/core";
import type { Queryable } from "../infra/db.ts";
import { platformName } from "./autopilot.ts";

/** How long a brake holds unless they lift it. */
export const BRAKE_MS = 24 * 3_600_000;
/** The answer rate is judged only on this many replies in each stretch. */
export const RATE_MIN_SENDS = 25;
/** A platform whose answers fell to under this share of what they were is braked. */
export const RATE_DROP = 1 / 3;

/** Whether their words ask if they are talking to a bot or an AI, or say so. */
export const asksBot = (text: string): boolean =>
  /\b(are|r) (you|u) (a |an )?(bot|ai|robot|chat ?gpt|llm|automated|real( person)?|human)\b|\bis this (a |an )?(bot|ai|automated|chat ?gpt)\b|\b(you'?re|ur|this is|sounds like|looks like|smells like|written by|reads like) (a |an )?(bot|ai\b|chat ?gpt|llm|automation|ai[- ]generated)\b|\b(ai|bot|llm)[- ](generated|written|reply|slop|spam|account)\b|\bbot\?/i.test(
    text.replace(/\s+/g, " "),
  );

export interface Brake {
  readonly platform: string;
  readonly kind: string;
  readonly reason: string;
  readonly until: Date;
}

/**
 * Brakes on bad signs (the founder, 2026-11-18: "Someone asks 'are you a bot?', a reply is taken down, or a platform's
 * answer rate drops sharply: that kind pauses on that platform and you're told"). While a brake holds, nothing of that
 * kind goes up by itself there and no first word to a stranger is drafted; an answer to someone already talking waits
 * for their tap. It passes by itself in a day, or when they say go ahead. Kept in mq.brakes and in memory.
 */
export class Brakes {
  readonly #db: Queryable;
  readonly #say: (customerId: CustomerId, text: string) => Promise<void>;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #on = new Map<string, Brake>();

  constructor(deps: { db: Queryable; say: (customerId: CustomerId, text: string) => Promise<void>; clock: Clock; log: Logger }) {
    this.#db = deps.db;
    this.#say = deps.say;
    this.#clock = deps.clock;
    this.#log = deps.log;
  }

  /** At start: the brakes still holding. */
  async load(): Promise<void> {
    const { rows } = await this.#db.query<{ customer_id: string; platform: string; kind: string; reason: string; until: Date }>(
      `select customer_id, platform, kind, reason, until from mq.brakes where lifted_at is null and until > now()`,
    );
    for (const r of rows) this.#on.set(`${r.customer_id} ${r.platform} ${r.kind}`, { platform: r.platform, kind: r.kind, reason: r.reason, until: r.until });
  }

  /** The brake on a kind on a platform now, if one holds. */
  on(customerId: CustomerId, platform: string, kind: string): Brake | null {
    const key = `${customerId} ${platform} ${kind}`;
    const b = this.#on.get(key);
    if (!b) return null;
    if (b.until.getTime() > this.#clock.now().getTime()) return b;
    this.#on.delete(key);
    return null;
  }

  /** Every brake of theirs that holds now. */
  list(customerId: CustomerId): Brake[] {
    return [...this.#on.entries()].filter(([k, b]) => k.startsWith(`${customerId} `) && b.until.getTime() > this.#clock.now().getTime()).map(([, b]) => b);
  }

  /** A bad sign: that kind stops there for a day, and they are told once. One already holding is left as it is. */
  async pull(customerId: CustomerId, platform: string, kind: string, reason: string): Promise<boolean> {
    if (this.on(customerId, platform, kind)) return false;
    const until = new Date(this.#clock.now().getTime() + BRAKE_MS);
    this.#on.set(`${customerId} ${platform} ${kind}`, { platform, kind, reason, until });
    await this.#db.query(`insert into mq.brakes (customer_id, platform, kind, reason, until) values ($1, $2, $3, $4, $5)`, [customerId, platform, kind, reason.slice(0, 300), until]).catch((e: unknown) => this.#log.warn("brakes.not_kept", { error: e instanceof Error ? e.message : String(e) }));
    this.#log.info("brakes.pulled", { customerId, platform, kind, reason: reason.slice(0, 120) });
    const what = kind === "reply" ? "replies" : kind === "message" ? "messages" : `${kind}s`;
    await this.#say(customerId, `I paused ${what} on ${platformName(platform)} for a day: ${reason}. Answers to people already talking wait for your ok meanwhile. Say "go ahead on ${platformName(platform)}" to lift it sooner.`).catch(() => undefined);
    return true;
  }

  /** They said go ahead: the brakes there (or everywhere, with no platform) are lifted. */
  async lift(customerId: CustomerId, platform: string | null = null): Promise<number> {
    let n = 0;
    for (const [key, b] of this.#on) {
      if (!key.startsWith(`${customerId} `) || (platform && b.platform !== platform)) continue;
      this.#on.delete(key);
      n++;
    }
    if (n) await this.#db.query(`update mq.brakes set lifted_at = now() where customer_id = $1 and lifted_at is null and ($2::text is null or platform = $2)`, [customerId, platform]).catch(() => undefined);
    if (n) this.#log.info("brakes.lifted", { customerId, platform, n });
    return n;
  }

  /**
   * A platform's answers dropping sharply: of the replies that went up there in the last three days, the share of
   * people who answered fell to under a third of the week before. Looked at now and then, for whoever is at work.
   */
  async checkRates(customerId: CustomerId): Promise<void> {
    const { rows } = await this.#db.query<{ platform: string; recent: string; recent_answers: string; before: string; before_answers: string }>(
      `with sent as (
         select platform, sent_at from mq.drafts
          where customer_id = $1 and kind = 'reply' and sent_at > now() - interval '10 days'
       ), heard as (
         select substring(url from '^https?://(?:www\\.)?([^/]+)') as platform, created_at as at from mq.results
          where customer_id = $1 and stage = 'conversation' and created_at > now() - interval '10 days'
       )
       select s.platform,
              count(*) filter (where s.sent_at > now() - interval '3 days') as recent,
              (select count(*) from heard h where h.platform = s.platform and h.at > now() - interval '3 days') as recent_answers,
              count(*) filter (where s.sent_at <= now() - interval '3 days') as before,
              (select count(*) from heard h where h.platform = s.platform and h.at <= now() - interval '3 days') as before_answers
         from sent s group by s.platform`,
      [customerId],
    );
    for (const r of rows) {
      const [recent, before] = [Number(r.recent), Number(r.before)];
      if (recent < RATE_MIN_SENDS || before < RATE_MIN_SENDS) continue;
      const now = Number(r.recent_answers) / recent;
      const was = Number(r.before_answers) / before;
      if (was < 0.08 || now >= was * RATE_DROP) continue;
      const pct = (x: number): string => `${Math.round(x * 100)}%`;
      await this.pull(customerId, r.platform, "reply", `answers there dropped from ${pct(was)} to ${pct(now)} of what went up`);
    }
  }
}
