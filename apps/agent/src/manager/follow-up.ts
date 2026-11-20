import type { TranscriptEntry } from "@mq/core";
import { CARD_MARK, QUESTION_MARK } from "../conversation/messenger.ts";
import { wall } from "../lib/their-time.ts";

/**
 * Chasing an answer the way a keen hire chases a busy boss: once about an hour after the
 * question, again a few hours later, then once a day in their morning, never in their night,
 * for a week at most. The customer's word, 2026-10-01: "like a real human would ping regularly
 * if it gets ghosted ... prompt to answer back soon and get silent for some hours".
 */
export const FIRST_FOLLOW_UP_MS = 60 * 60_000;
export const SECOND_FOLLOW_UP_MS = 4 * 3_600_000;
/** From the third follow-up on: once a day, at this hour their time. */
export const DAILY_FOLLOW_UP_HOUR = 10;
/** Their waking hours, [from, until): a follow-up that falls outside waits for the morning. */
export const WAKING_FROM = 9;
export const WAKING_UNTIL = 21;
export const CHASE_FOR_MS = 7 * 24 * 3_600_000;

/**
 * A follow-up counts as due this close to its time: the queue's clock is the database's, and a turn
 * that woke a moment early by the agent's own clock would only set the same wake again.
 */
const DUE_SLACK_MS = 60_000;

/** Whether the follow-up is due now. */
export const followUpDue = (w: WaitingOn | null, now: Date): boolean =>
  Boolean(w?.nextAt && w.nextAt.getTime() <= now.getTime() + DUE_SLACK_MS);

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A question the customer has not answered, and when Quest follows it up. */
export interface WaitingOn {
  /** The question as they saw it. */
  readonly text: string;
  readonly askedAt: Date;
  /** Messages Quest sent them since: the follow-ups so far. */
  readonly followUps: number;
  /** When to follow it up next (already past when one is due), or null once it has been chased for a week. */
  readonly nextAt: Date | null;
}

/**
 * Whether a message asks them something: a sentence ending in a question mark, or a question asked
 * again as a statement ("Still need the conference name", live 2026-10-01). A question mark in a link
 * ("?id=") or closing a quote of someone else's words ("asked "anything cheaper?"") is not one.
 */
export const asks = (text: string): boolean => /[?？؟](?=\s|$)/mu.test(text) || /\bstill (need|waiting (on|for))\b/i.test(text);

const isCard = (e: TranscriptEntry): boolean => e.text.startsWith(CARD_MARK);
const isQuestionCard = (e: TranscriptEntry): boolean => e.text.startsWith(QUESTION_MARK);

/**
 * The first question Quest put to them since they last wrote, if they still owe the answer. A question
 * card counts while its question is open (`openCard` gets its text): a tap on its buttons answers it
 * without a word in the chat. Anything they write counts as their answer; Quest asks again in its reply
 * if it still needs it. Entries oldest first.
 */
export function waitingOn(entries: readonly TranscriptEntry[], timezone: string | null, openCard: (text: string) => boolean = () => false): WaitingOn | null {
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.direction === "in") {
      start = i + 1;
      break;
    }
  }
  const since = entries.slice(start);
  const at = since.findIndex(
    (e) => e.direction === "out" && (isQuestionCard(e) ? openCard(e.text.slice(QUESTION_MARK.length)) : !isCard(e) && asks(e.text)),
  );
  if (at < 0) return null;
  const q = since[at]!;
  const after = since.slice(at + 1).filter((e) => e.direction === "out" && !isCard(e) && !isQuestionCard(e));
  const last = (after.at(-1)?.at ?? q.at).getTime();
  const next = awake(
    after.length === 0
      ? new Date(last + FIRST_FOLLOW_UP_MS)
      : after.length === 1
        ? new Date(last + SECOND_FOLLOW_UP_MS)
        : nextLocalHour(new Date(last + 8 * HOUR_MS), timezone, DAILY_FOLLOW_UP_HOUR),
    timezone,
  );
  return {
    text: isQuestionCard(q) ? q.text.slice(QUESTION_MARK.length) : q.text,
    askedAt: q.at,
    followUps: after.length,
    nextAt: next.getTime() - q.at.getTime() > CHASE_FOR_MS ? null : next,
  };
}

/** The first moment at or after `t` when their clock reads `hour`:00. */
export function nextLocalHour(t: Date, timezone: string | null, hour: number): Date {
  const local = new Date(wall(t, timezone));
  let target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour);
  if (target < local.getTime()) target += DAY_MS;
  const guess = target - (local.getTime() - t.getTime());
  // Across a clock change the offset moves: read it again at the target.
  return new Date(target - (wall(new Date(guess), timezone) - guess));
}

/** `t`, or their next morning when `t` falls in their night. */
export function awake(t: Date, timezone: string | null): Date {
  const hour = new Date(wall(t, timezone)).getUTCHours();
  return hour >= WAKING_FROM && hour < WAKING_UNTIL ? t : nextLocalHour(t, timezone, WAKING_FROM);
}
