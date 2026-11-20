import type { CustomerId } from "@mq/core";

interface Waiting {
  readonly who: string;
  readonly site: string;
  /** A post of their own or a profile change: it lets a reply, a message or a like that waits go first. */
  readonly long: boolean;
  readonly go: () => void;
}

interface Lane {
  /** Who acts now, and on which site. */
  holder: string | null;
  site: string | null;
  /** Who waits their turn, in the order they asked. */
  readonly waiting: Waiting[];
}

/** Their line, as the customer's page shows it. */
export interface LaneView {
  readonly site: string;
  readonly holder: string | null;
  readonly waiting: readonly string[];
}

/**
 * Work that acts as the customer (a post, a reply, a like, a profile edit) goes one at a time, in the order it asked:
 * two runs typing into X at once would fight over one account, and a site that sees two composers open in the same
 * second treats the account as a bot. One line for all their sites: a post is drawn in front of their Chrome, and two
 * at once took the front from each other (live, 2026-11-05: LinkedIn and YouTube clicks failed beside other posts, and
 * the broker, which follows one post a customer, held a post's own steps as another run's). Reading needs no turn.
 * A post of their own takes minutes on a site with an editor (Medium, a Facebook page), so what answers a person goes
 * before it (live, 2026-11-14: ten taps in a minute, and six replies waited 25 minutes behind three posts that failed).
 * In memory, like the Chrome broker: one agent machine serves every Chrome.
 */
export class SiteLanes {
  readonly #lanes = new Map<CustomerId, Lane>();

  /**
   * Runs `work` when its turn comes. `onWait` hears its site while it waits behind someone, then null once its turn
   * came, so the page can say why it is not moving.
   */
  async run<T>(customerId: CustomerId, site: string, who: string, work: () => Promise<T>, onWait?: (site: string | null) => void, long = false): Promise<T> {
    let lane = this.#lanes.get(customerId);
    if (!lane) {
      lane = { holder: null, site: null, waiting: [] };
      this.#lanes.set(customerId, lane);
    }
    if (lane.holder !== null) {
      onWait?.(site);
      const mine = lane;
      await new Promise<void>((go) => mine.waiting.push({ who, site, long, go }));
      onWait?.(null);
    }
    lane.holder = who;
    lane.site = site;
    try {
      return await work();
    } finally {
      const next = lane.waiting.find((w) => !w.long) ?? lane.waiting[0];
      if (next) {
        lane.waiting.splice(lane.waiting.indexOf(next), 1);
        // Theirs from this moment, so nobody who asks before it wakes takes the turn.
        lane.holder = next.who;
        lane.site = next.site;
        next.go();
      } else {
        this.#lanes.delete(customerId);
      }
    }
  }

  /** Where something acts for this customer now, and who waits behind it. */
  view(customerId: CustomerId): LaneView[] {
    const lane = this.#lanes.get(customerId);
    return lane && (lane.holder || lane.waiting.length) ? [{ site: lane.site ?? "", holder: lane.holder, waiting: lane.waiting.map((w) => w.who) }] : [];
  }
}
