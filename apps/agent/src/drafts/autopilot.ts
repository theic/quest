import { DRAFT_KINDS, TRUST_AFTER, trustKey, type Clock, type CustomerId, type TrustRepository } from "@mq/core";
import type { Messenger } from "../conversation/messenger.ts";

const PLATFORMS: Readonly<Record<string, string>> = { reddit: "Reddit", "*": "All connected platforms" };
/** "Reddit", "x.com", "Reddit posts", "x.com likes": a trust key as the customer reads it. */
export const platformName = (key: string): string => {
  const [platform = key, rest] = key.split(/ (?=(?:posts|messages|likes|follows|profiles)$)/);
  return rest ? `${PLATFORMS[platform] ?? platform} ${rest}` : (PLATFORMS[key] ?? key);
};

/** Of their last decisions on a kind, this share went up as written before Quest stops asking. */
export const TRUSTED_SHARE = 0.9;

/** A profile check always waits for their tap: it is who they are on that site (the founder, 2026-10-29: "one 'profile check' ask per platform"). */
const ALWAYS_ASKS = / profiles$/;

/** Whether a kind on a platform may ever go alone: never a profile check, never a private message. */
export const mayGoAlone = (key: string): boolean => !ALWAYS_ASKS.test(key) && !/ messages$/.test(key);

/**
 * Whether Quest posts on a platform by itself yet. The first TRUST_AFTER of a kind on a platform go up on the customer's
 * tap (after an edit, if they want one); then Quest offers to do that kind there itself, on Your move (the founder,
 * 2026-11-04: "The transition to autopilot approve per platform should start with the agent's suggestion"), and only
 * their yes, or "go ahead", lets it. A no starts the count over. A reply taken down there, or "ask me first", brings the
 * taps back. Its pace when it does is the outbox's (outbox.ts), kept in the table so a restart does not start it over.
 */
export class Autopilot {
  readonly #trust: TrustRepository;
  readonly #messenger: Pick<Messenger, "say">;
  readonly #off: (customerId: CustomerId) => boolean;
  readonly #brakes: { on(customerId: CustomerId, platform: string, kind: string): { readonly reason: string; readonly until: Date } | null; pull(customerId: CustomerId, platform: string, kind: string, reason: string): Promise<boolean> } | null;
  readonly #record: ((customerId: CustomerId, platform: string, kind: string) => Promise<{ readonly n: number; readonly clean: number }>) | null;
  /** Your move, told when an offer joins it (asks/deck.ts); set once the deck is made. */
  offers: ((customerId: CustomerId) => Promise<void>) | null = null;

  /** `off`: whether they switched Quest off (lifecycle/power.ts); then nothing posts, by itself or on a tap. */
  constructor(deps: { trust: TrustRepository; messenger: Pick<Messenger, "say">; clock: Clock; off?: (customerId: CustomerId) => boolean; brakes?: { on(customerId: CustomerId, platform: string, kind: string): { readonly reason: string; readonly until: Date } | null; pull(customerId: CustomerId, platform: string, kind: string, reason: string): Promise<boolean> }; record?: (customerId: CustomerId, platform: string, kind: string) => Promise<{ readonly n: number; readonly clean: number }> }) {
    this.#trust = deps.trust;
    this.#off = deps.off ?? (() => false);
    this.#messenger = deps.messenger;
    this.#record = deps.record ?? null;
    this.#brakes = deps.brakes ?? null;
  }

  /** The brake on a kind on a platform now (drafts/brakes.ts): why, and until when; null when none holds. */
  braked(customerId: CustomerId, platform: string, kind: string): { readonly reason: string; readonly until: Date } | null {
    return this.#brakes?.on(customerId, platform, kind) ?? null;
  }

  async alone(customerId: CustomerId, platform: string): Promise<boolean> {
    // A brake holds that kind there: nothing of it goes up by itself until it passes.
    const kind = / likes$/.test(platform) ? "like" : / follows$/.test(platform) ? "follow" : / posts$/.test(platform) ? "post" : / messages$/.test(platform) ? "message" : "reply";
    if (this.braked(customerId, platform.replace(/ (posts|likes|follows|messages|profiles)$/, ""), kind)) return false;
    // A private message never goes alone, whatever the trust rows say (live, 2026-11-13 to 18: a "go ahead" for
    // everything had set "<site> messages" granted, and 27 messages went out with no tap).
    return mayGoAlone(platform) && !this.#off(customerId) && (await this.#trust.alone(customerId, platform));
  }

  /** Stops a kind on a platform for a day and tells them, once (drafts/brakes.ts). */
  async brake(customerId: CustomerId, platform: string, kind: string, reason: string): Promise<void> {
    await this.#brakes?.pull(customerId, platform, kind, reason);
  }

  /** They switched Quest off: nothing goes up, by itself or on a tap, until it is on. */
  switchedOff(customerId: CustomerId): boolean {
    return this.#off(customerId);
  }

  /** A post they approved went up: one more toward going alone there, and Quest's offer the moment it gets there. */
  async approved(customerId: CustomerId, platform: string): Promise<void> {
    const n = await this.#trust.approve(customerId, platform);
    if (n < TRUST_AFTER || !mayGoAlone(platform)) return;
    if (await this.alone(customerId, platform)) {
      // Their "go ahead" for everything (*) came first: nothing to offer, only to say so once.
      if (n !== TRUST_AFTER) return;
      this.note(customerId, "Quest", `posts on ${platformName(platform)} by itself from now on (${n} approved)`);
      const what = / (likes|follows)$/.test(platform) ? "do these there" : "post there";
      await this.#messenger.say(customerId, `That's ${n} approved on ${platformName(platform)}, so from now on I ${what} myself. Say "ask me first" and I'll ask before each one again.`);
      return;
    }
    // Their own behaviour decides (the founder, 2026-11-18: "If you approve a kind unedited nine times in ten, Quest should
    // stop asking for it"): of their last ten decisions on this kind here, nine in ten went up as Quest wrote them, and
    // at least the first few by hand. Until then it keeps asking, and nothing is offered. "Ask me first" still holds.
    const kind = / likes$/.test(platform) ? "like" : / follows$/.test(platform) ? "follow" : / posts$/.test(platform) ? "post" : "reply";
    const r = await this.#record?.(customerId, platform.replace(/ (posts|likes|follows)$/, ""), kind).catch(() => null);
    const earned = r && r.n >= TRUST_AFTER ? r.clean / r.n >= TRUSTED_SHARE : !r && n === TRUST_AFTER;
    if (!earned) return;
    await this.#trust.set(customerId, platform, Math.max(n, TRUST_AFTER));
    if (!(await this.alone(customerId, platform))) return;
    this.note(customerId, "Quest", `does ${platformName(platform)} by itself from now on: ${r ? `${r.clean} of their last ${r.n} went up as written` : `${n} approved`}`);
    const what = / (likes|follows)$/.test(platform) ? "do these there" : "send these there";
    await this.#messenger.say(customerId, `You sent my last few on ${platformName(platform)} as I wrote them, so from now on I ${what} myself. Words show under "Here's what I'm sending" first, and you can strike any. Say "ask me first" and I'll ask before each one again.`);
  }

  /** Their answer to the offer on Your move. */
  async answer(customerId: CustomerId, platform: string, yes: boolean): Promise<string> {
    if (!(await this.#trust.offered(customerId)).includes(platform)) return "That one is settled already";
    await this.#trust.answer(customerId, platform, yes);
    this.note(customerId, "Quest", yes ? `does ${platformName(platform)} by itself from now on: they said yes` : `keeps asking before ${platformName(platform)}: they said not yet`);
    return yes ? "Okay, I'll do them myself from now on" : "Okay, I'll keep asking";
  }

  /** A reply or post taken down there: back to asking, for every kind of thing on that platform. */
  async removed(customerId: CustomerId, platform: string): Promise<void> {
    for (const kind of DRAFT_KINDS) await this.#trust.set(customerId, trustKey(platform, kind), 0);
    this.note(customerId, "Quest", `asks before posting on ${platformName(platform)} again: a reply was taken down`);
    await this.#brakes?.pull(customerId, platform, "reply", "a reply there was taken down").catch(() => false);
  }

  note(customerId: CustomerId, who: string, what: string): void {
  }
}
