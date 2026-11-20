import type { Clock, CustomerId } from "@mq/core";
import type { BrowsingHold } from "../chrome/broker.ts";

/** A card waiting on them holds their Chrome this long after their last move: a card they walked away from does not stop the work. */
export const ANSWERING_MS = 3 * 60_000;
/** Between an answer and the next card (a take is looked back at and the next one written): the hold bridges it. */
export const NEXT_CARD_MS = 30_000;

/**
 * Whether they are answering the first-day cards right now. While they are, Quest's Chrome takes no work: nothing
 * comes to the front of their screen or browses while they answer (the founder, 2026-10-23: "ensure it is not
 * raising/browsing while I'm still answering an onboarding question", and, asked whether only raising should wait,
 * "Hold all browsing"). They are answering while a card waits and they moved (an answer, a tick, a message) or got
 * the card in the last `ANSWERING_MS`, and for `NEXT_CARD_MS` after an answer while the next card is on its way.
 *
 * In memory, told by IntakeService: after a restart nothing holds until they answer again.
 */
export class Answering implements BrowsingHold {
  readonly #clock: Clock;
  /** A card that waits on them: when it went out, and their last move since. */
  readonly #waiting = new Map<CustomerId, { asked: number; moved: number }>();
  /** When they last answered, while the next card may still come. */
  readonly #answered = new Map<CustomerId, number>();
  #changed: (customerId: CustomerId) => void = () => undefined;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** Called when the hold ends sooner than it said (an answer, the last card): what waits may go. */
  whenChanged(listener: (customerId: CustomerId) => void): void {
    this.#changed = listener;
  }

  /** A card went out and waits on their answer. */
  asked(customerId: CustomerId): void {
    const now = this.#clock.now().getTime();
    this.#waiting.set(customerId, { asked: now, moved: now });
    this.#answered.delete(customerId);
  }

  /** They did something on the card that waits without answering it (ticked one of several, or wrote about it). */
  moved(customerId: CustomerId): void {
    const w = this.#waiting.get(customerId);
    if (w) w.moved = this.#clock.now().getTime();
  }

  /** They answered the card; the next may come. */
  answered(customerId: CustomerId): void {
    this.#waiting.delete(customerId);
    this.#answered.set(customerId, this.#clock.now().getTime());
    this.#changed(customerId);
  }

  /** No more cards are coming: nothing holds. */
  finished(customerId: CustomerId): void {
    this.#waiting.delete(customerId);
    this.#answered.delete(customerId);
    this.#changed(customerId);
  }

  until(customerId: CustomerId): number | null {
    const now = this.#clock.now().getTime();
    const w = this.#waiting.get(customerId);
    const until = w ? Math.max(w.asked, w.moved) + ANSWERING_MS : (this.#answered.get(customerId) ?? -Infinity) + NEXT_CARD_MS;
    return until > now ? until : null;
  }
}
