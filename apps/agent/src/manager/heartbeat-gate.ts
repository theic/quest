/**
 * Whether an hourly heartbeat is worth a model's look. Most are not: a task is running (its end wakes
 * the manager anyway), the day's starts are spent, or the customer's Chrome is closed and nothing can
 * start without it. Those are decided here, in code, for nothing; a turn that only had heartbeats and
 * nothing to move cost about $0.009 a time, every hour, for every customer (FACTS.md, 2026-09-28).
 */

/** After a heartbeat turn that moved nothing, the next ones wait this long before another look. */
export const QUIET_HEARTBEAT_BACKOFF_MS = 3 * 3_600_000;

/** What the gate looks at, all of it already loaded for the turn. */
export interface HeartbeatLook {
  /** Tasks waiting to run or running now. */
  readonly active: number;
  /** Tasks the manager may still start on its own today. */
  readonly startsLeft: number;
  /** A teammate could start now: their Chrome is open, or some teammate works without it. */
  readonly canStart: boolean;
  /** Finds saved and not shown yet. */
  readonly findsWaiting: number;
  /** Find cards open in the chat now. */
  readonly cardsOpen: number;
  /** It is their waking hours, or a find waiting goes up by itself: only a card that waits on them holds for the morning. */
  readonly daytime: boolean;
  /** Until when heartbeats rest, after one that moved nothing; null when they don't. */
  readonly restingUntil: Date | null;
  readonly now: Date;
}

/** Why the heartbeat is worth a model's look, or null when there is nothing it could move. */
export function heartbeatWorth(look: HeartbeatLook): string | null {
  if (look.restingUntil && look.restingUntil.getTime() > look.now.getTime()) return null;
  if (look.findsWaiting > 0 && look.cardsOpen === 0 && look.daytime) return "finds wait to be shown";
  if (look.active === 0 && look.startsLeft > 0 && look.canStart) return "nothing running, and work could start";
  return null;
}

/** Why the gate said no, for the log line. */
export function heartbeatIdleReason(look: HeartbeatLook): string {
  if (look.restingUntil && look.restingUntil.getTime() > look.now.getTime()) return "resting after a quiet look";
  if (look.active > 0) return "work is running";
  if (look.startsLeft <= 0) return "the day's starts are spent";
  if (!look.canStart) return "nothing can start without their Chrome";
  return "nothing to move";
}
