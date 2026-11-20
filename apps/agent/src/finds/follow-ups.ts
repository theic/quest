import type { CommitmentRepository, CustomerId, Logger } from "@mq/core";
import { profileUrlOf } from "../contacts/handles.ts";
import { listPage } from "../drafts/one-reply.ts";
import { platformOf } from "../platforms.ts";

/**
 * A warm conversation is planned ahead (the founder, 2026-11-13: "after 2 days of a successful interaction or connection
 * write another message (what gojiberry does for linkedin). And this should be illustrated on the people's tab"). When
 * someone answers what went up as the customer, a next step is kept for two days later (`mq.commitments`, marked by its
 * `words`), which their feed on the People tab shows as planned; when it falls due, code writes it, with no model turn
 * deciding whether to: a private message where the site has them and their profile is known (it waits for a tap, as
 * every message does), else a reply under their answer. One planned at a time for a person.
 */
export const FOLLOW_UP_AFTER_MS = 2 * 86_400_000;
/** How a planned follow-up is told from a next step the manager planned. */
export const FOLLOW_UP_MARK = "follow-up";
/** Written this many at a look at most: the rest wait for the next. */
const A_LOOK = 3;

const pick = <T>(list: readonly T[], roll: () => number): T => list[Math.min(list.length - 1, Math.floor(roll() * list.length))]!;

/**
 * What the second message starts from; the writer rewrites it in their voice, with what Quest knows of the person. It
 * never offers something Quest does not hold (live, 2026-11-13: "I came across a couple of places where people tracking
 * calories hang out, want me to send them over?" went to Dhruv, who said yes please, and there were no places): only
 * a question, or looking for people once they say who.
 */
export function followUpDraft(roll: () => number = Math.random): string {
  return pick(
    [
      "hey, how's it going since we talked? who's been the happiest user so far?",
      "been thinking about what you're building. did anyone new try it this week? if you tell me who your best users are I'll keep an eye out for more of them",
      "quick one, what's the hardest part right now, getting people in or getting them to stay?",
      "how's it going since? what do the people who stick around have in common?",
      "checking back in, any luck getting people in? if you say who it's for, I'll look for a few who are asking for it",
    ],
    roll,
  );
}

export interface FollowUpDeps {
  readonly commitments: Pick<CommitmentRepository, "add" | "open" | "close">;
  /** Offers the draft; a string says why it was refused. */
  readonly offer: (customerId: CustomerId, draft: { kind: "reply" | "message"; url: string; target: string; text: string; quote: string | null; author: string }) => Promise<string | null>;
  /** Their profile, when they are kept: an answer read off a list of notifications has no address of its own. */
  readonly profileOf?: (customerId: CustomerId, onUrl: string, person: string) => Promise<string | null>;
  readonly online: () => readonly CustomerId[];
  readonly now: () => Date;
  readonly log: Logger;
  readonly roll?: () => number;
}

export class FollowUps {
  readonly #d: FollowUpDeps;

  constructor(deps: FollowUpDeps) {
    this.#d = deps;
  }

  /** Someone answered: a second message is planned for two days on, unless one is planned for them already. */
  async plan(customerId: CustomerId, a: { person: string; url: string; quote: string }): Promise<void> {
    const open = await this.#d.commitments.open(customerId);
    if (open.some((c) => c.kind === "next_step" && c.person === a.person)) return;
    const dueAt = new Date(this.#d.now().getTime() + FOLLOW_UP_AFTER_MS);
    await this.#d.commitments.add(
      customerId,
      { kind: "next_step", what: `A second message to ${a.person}, two days after they answered: "${a.quote.slice(0, 160)}"`.slice(0, 500), words: FOLLOW_UP_MARK, person: a.person.slice(0, 200), url: a.url, taskId: null, dueAt, onTime: false, source: "manager" },
      dueAt,
    );
    this.#d.log.info("follow_up.planned", { customerId, person: a.person, dueAt: dueAt.toISOString() });
  }

  /** Writes the follow-ups that fell due, for everyone whose Chrome is open. */
  async look(): Promise<void> {
    for (const customerId of this.#d.online()) {
      const due = (await this.#d.commitments.open(customerId)).filter((c) => c.kind === "next_step" && c.words === FOLLOW_UP_MARK && c.url && c.person && c.dueAt <= this.#d.now());
      for (const c of due.slice(0, A_LOOK)) {
        const person = c.person!;
        const url = c.url!;
        const quote = /: "(.*)"$/s.exec(c.what)?.[1] ?? null;
        const profile = profileUrlOf(url) ?? (await this.#d.profileOf?.(customerId, url, person).catch(() => null)) ?? null;
        const text = followUpDraft(this.#d.roll);
        // A private message first, where the site has them: the second word is a conversation, not a comment.
        const asMessage = profile && (platformOf(url)?.limits.messages ?? 0) > 0 ? await this.#d.offer(customerId, { kind: "message", url: profile, target: person, text, quote, author: person }).catch((e: unknown) => String(e)) : "no profile to write to";
        const refused = asMessage === null ? null : listPage(url) ? `${asMessage}; and their answer has no address of its own to reply under` : await this.#d.offer(customerId, { kind: "reply", url, target: person, text, quote, author: person }).catch((e: unknown) => String(e));
        await this.#d.commitments.close(customerId, c.id, refused === null ? "kept" : "dropped", refused === null ? (asMessage === null ? "written as a message" : "written as a reply") : `not written: ${refused}`.slice(0, 500));
        this.#d.log.info("follow_up.due", { customerId, person, as: refused === null ? (asMessage === null ? "message" : "reply") : null, ...(refused ? { refused: refused.slice(0, 200), message: String(asMessage).slice(0, 200) } : {}) });
      }
    }
  }
}
