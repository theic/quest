import { draftLabel, type ChannelAddress, type CustomerId, type Draft, type Logger, type OutboxItem } from "@mq/core";

/** Lines the list shows: the next ones to go. */
export const OUT_LINES = 8;
/** Changes within this long are drawn once. */
const SETTLE_MS = 8_000;

/** One thing going up by itself soon: what it is, its words, and what strikes it (a draft's own Skip). */
export interface OutLine {
  readonly id: string;
  readonly label: string;
  readonly words: string;
  readonly at: Date;
}

/** A channel that can keep the list as one message with a button a line (Telegram's). */
export interface OutListChannel {
  showOutList(to: ChannelAddress, ref: string | null, text: string, lines: readonly OutLine[]): Promise<string | null>;
}

export interface OutListDeps {
  readonly outbox: { waiting(customerId: CustomerId): Promise<readonly OutboxItem[]> };
  readonly drafts: { recent(customerId: CustomerId, limit: number): Promise<Draft[]> };
  /** Where they talk with Quest, and that channel when it can keep the list. */
  readonly channel: (customerId: CustomerId) => Promise<{ readonly to: ChannelAddress; readonly list: OutListChannel | null } | null>;
  /** The day's message, kept so a restart edits it instead of sending another (mq.customers.out_list). */
  readonly kept: { get(customerId: CustomerId): Promise<{ readonly ref: string; readonly day: string } | null>; set(customerId: CustomerId, ref: string, day: string): Promise<void> };
  /** Their own date (their time zone), "2026-11-18": one message a day. */
  readonly day: (customerId: CustomerId) => Promise<string>;
  /** Told when the list changed, for a surface that draws it itself (the extension's panel). */
  readonly news?: (customerId: CustomerId) => void;
  readonly log: Logger;
}

/** The list's words, as the chat shows them. */
export function outListText(lines: readonly OutLine[], more: number): string {
  if (!lines.length) return "Going out: nothing waits now. What I send next shows here first.";
  return [
    `Here's what I'm sending now (${lines.length + more}). It goes up by itself; strike any with its number.`,
    ...lines.map((l, i) => `${i + 1}. ${l.label}: ${l.words}`),
    ...(more > 0 ? [`and ${more} more after these`] : []),
  ].join("\n");
}

/**
 * Approve by exception (the founder, 2026-11-18: "Once a kind is trusted, Quest shows a short daily list, 'Here's what
 * I'm sending today/or rn', and it goes out unless you strike something. You skim one feed instead of tapping twelve
 * cards"). What Quest sends by itself waits a moment in the outbox first, and this is where it shows: one message a day
 * in their chat, edited in place as the line moves, a button a line that strikes it (the draft's own Skip). The
 * extension's panel draws the same lines itself (`lines`). Likes and follows are not listed: nothing to read in them.
 */
export class OutList {
  readonly #d: OutListDeps;
  readonly #timers = new Map<CustomerId, NodeJS.Timeout>();
  readonly #shown = new Map<CustomerId, string>();

  constructor(deps: OutListDeps) {
    this.#d = deps;
  }

  /** What goes up by itself next, soonest first: words only, on trust, not yet going. */
  async lines(customerId: CustomerId): Promise<{ readonly lines: OutLine[]; readonly more: number }> {
    const waiting = (await this.#d.outbox.waiting(customerId)).filter((i) => i.draftId && i.approved === "trust" && !i.light && i.status !== "sending");
    if (!waiting.length) return { lines: [], more: 0 };
    const drafts = new Map((await this.#d.drafts.recent(customerId, 400)).map((d) => [d.id as string, d]));
    const all = waiting
      .flatMap((i) => {
        const d = drafts.get(i.draftId as string);
        return d && d.status === "open" && d.text.trim() ? [{ id: d.id as string, label: draftLabel(d), words: d.text.replace(/\s+/g, " ").trim().slice(0, 140), at: i.dueAt }] : [];
      })
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    return { lines: all.slice(0, OUT_LINES), more: Math.max(0, all.length - OUT_LINES) };
  }

  /** The line moved (something joined, went, or was struck): drawn once it settles. */
  changed(customerId: CustomerId): void {
    this.#d.news?.(customerId);
    if (this.#timers.has(customerId)) return;
    const t = setTimeout(() => {
      this.#timers.delete(customerId);
      void this.#draw(customerId).catch((e: unknown) => this.#d.log.warn("out_list.failed", { customerId, error: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
    }, SETTLE_MS);
    t.unref();
    this.#timers.set(customerId, t);
  }

  async #draw(customerId: CustomerId): Promise<void> {
    const where = await this.#d.channel(customerId);
    if (!where?.list) return;
    const { lines, more } = await this.lines(customerId);
    const text = outListText(lines, more);
    const key = `${text}|${lines.map((l) => l.id).join(",")}`;
    if (this.#shown.get(customerId) === key) return;
    const [kept, day] = await Promise.all([this.#d.kept.get(customerId).catch(() => null), this.#d.day(customerId)]);
    const today = kept && kept.day === day ? kept.ref : null;
    // Nothing waits and nothing was shown today: no message for an empty line.
    if (!lines.length && !today) return;
    const ref = await where.list.showOutList(where.to, today, text, lines);
    this.#shown.set(customerId, key);
    if (ref && ref !== today) await this.#d.kept.set(customerId, ref, day).catch(() => undefined);
  }
}
