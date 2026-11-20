import type { CustomerId, DraftId, FindId } from "./ids.ts";

/**
 * One line for everything that goes out as the customer (a reply, a post, a message, a like, a follow, a profile
 * change), from a draft or from a find's card. It waits there while their Chrome is closed or busy, and goes when it
 * is back, under every rule that holds for a post; it survives a restart or a deploy (the founder, 2026-10-23: "a
 * single common outbound queue for when chrome is inactive or something else is happening, it picks it up when it
 * gets back to work").
 */

/** Who said it goes: their tap, Quest on trust it earned there, or their own words in a turn ("post it"). */
export type OutboxApproval = "tap" | "trust" | "words";

/** Waiting, going up now, finished (it went up, or may have), or taken out without going up. */
export type OutboxStatus = "queued" | "sending" | "done" | "dropped";

export interface OutboxItem {
  readonly id: string;
  readonly customerId: CustomerId;
  readonly draftId: DraftId | null;
  readonly findId: FindId | null;
  /** What a find's reply goes under (a Reddit comment's id, or the post's address). */
  readonly target: string | null;
  /** Where it goes up: "reddit", or the site's host. */
  readonly site: string;
  readonly approved: OutboxApproval;
  /** A like or a follow: it keeps a shorter gap than words, and words are not paced from it. */
  readonly light: boolean;
  readonly status: OutboxStatus;
  /** It goes no sooner than this. */
  readonly dueAt: Date;
  /** Sends that did not go through for a reason of its own (a refusal); a closed Chrome is no try. */
  readonly tries: number;
  /** Why it waits, or how it ended. */
  readonly reason: string | null;
  readonly createdAt: Date;
  /** When it last changed: when it was taken to be sent, for one that is sending or done. */
  readonly updatedAt: Date;
}

export type OutboxRef = { readonly draftId: DraftId } | { readonly findId: FindId };

export interface NewOutboxItem {
  readonly customerId: CustomerId;
  readonly ref: OutboxRef;
  readonly target?: string | null;
  readonly site: string;
  readonly approved: OutboxApproval;
  readonly light?: boolean;
  readonly dueAt?: Date;
}

export interface OutboxRepository {
  /** Puts it in line; null when its draft or find is already in line or going up. */
  add(item: NewOutboxItem): Promise<OutboxItem | null>;
  /** The draft's or find's line while it waits or goes up; null otherwise. */
  of(ref: OutboxRef): Promise<OutboxItem | null>;
  /** What waits and is due, oldest first, in this agent's lane. */
  due(now: Date, limit: number): Promise<OutboxItem[]>;
  /** Everything of theirs waiting or going up, for their page. */
  active(customerId: CustomerId): Promise<OutboxItem[]>;
  /** What was taken to send since then, by site and whether it was light, on a tap or not: what paces the next one. */
  sentSince(customerId: CustomerId, since: Date): Promise<{ readonly site: string; readonly light: boolean; readonly at: Date }[]>;
  /** Takes a waiting one to send; false when it no longer waits. */
  claim(id: string): Promise<boolean>;
  /** Back in line until `dueAt`: Chrome closed, its site's turn, or a tap that made it go now. */
  wait(id: string, dueAt: Date, reason: string, approved?: OutboxApproval): Promise<void>;
  /** Finished: it went up or may have ("done"), or it is not going ("dropped"). */
  settle(id: string, status: "done" | "dropped", reason: string): Promise<void>;
  /** Takes a waiting one out (an edit, a skip); true when it was waiting. */
  drop(ref: OutboxRef, reason: string): Promise<boolean>;
  /** At start: the ones a stopped machine left sending. */
  leftSending(): Promise<OutboxItem[]>;
}
