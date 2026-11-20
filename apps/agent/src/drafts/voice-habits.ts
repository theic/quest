import { SKIPPED, type Profile, type Reflection, type Scene } from "@mq/core";

/** The keys the takes were kept under, take_1 to take_10 (retired 2026-11-05; what they left is still read). */
const TAKE_KEYS = Array.from({ length: 10 }, (_, i) => `take_${i + 1}`);

/**
 * How Quest writes as them, from their takes on their first day: what each take answered, what they said of it, and
 * the rules Quest took from it. The voice cards asked before the takes (habits, three samples, how hard to push) are
 * gone (2026-10-29), and their answers are no longer read.
 */

/** One take as it went: what it answered, what Quest wrote as them, and what they said of it. */
export interface Take {
  readonly key: string;
  readonly number: number;
  readonly scene: Scene;
  /** Quest's words, as them. */
  readonly wrote: string;
  /** "me", a fix's id, their own words (OWN_WORDS) or SKIPPED; null while it waits. */
  readonly choice: string | null;
  /** What they said of it: a fix's label or their words; null while it waits, or skipped. */
  readonly answer: string | null;
  readonly spoken: boolean;
  readonly reflection: Reflection | null;
}

/** The takes asked so far, in order. */
export function takesOf(profile: Profile): Take[] {
  return TAKE_KEYS.flatMap((key, i) => {
    const e = profile[key];
    const wrote = e?.options?.find((o) => o.id === "me")?.sample;
    if (!e?.scene || !wrote) return [];
    return [{ key, number: i + 1, scene: e.scene, wrote, choice: e.choice, answer: e.answer, spoken: Boolean(e.spoken), reflection: e.reflection ?? null }];
  });
}

/** A take they said something of: a fix or their own words, which Quest learns from. */
export const corrected = (t: Take): boolean => Boolean(t.choice && t.choice !== "me" && t.choice !== SKIPPED && t.answer);

/** The take they said is them; null before. */
export const approvedTake = (profile: Profile): Take | null => takesOf(profile).find((t) => t.choice === "me") ?? null;

/**
 * How Quest writes as them after the takes: the rules of its last look back, then each note of theirs it has not
 * looked back at yet (the look failed), as they said it.
 */
export function tunedRules(profile: Profile): string[] {
  const takes = takesOf(profile);
  const last = takes.findLastIndex((t) => t.reflection);
  const rules = last >= 0 ? [...takes[last]!.reflection!.rules] : [];
  const unread = takes.slice(last + 1).filter(corrected);
  return [...rules, ...unread.map((t) => `Their note on a message written as them: "${t.answer}"`)];
}
