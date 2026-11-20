/**
 * What Quest keeps from their first day, by key: the takes (Quest writes as them, they say what is off, until it is
 * them; conversation/intake.ts), and where they show up, read from their own words. The one-tap questions about them
 * (goal, stage, who pays, voice habits, the three samples, how hard to push, the where card) are gone (2026-10-29);
 * their old entries stay in the column and are no longer read.
 */
export interface IntakeOption {
  /** Stable, short and lowercase: it rides on the button and is what gets compared. */
  readonly id: string;
  readonly label: string;
  /** What choosing it sounds like, shown on the card beside the label: a take's words as them. */
  readonly sample?: string;
  /** The few words a tap on it is acknowledged with, when they say more than "Got it" ("Locked in"). */
  readonly ack?: string;
}

/** The one part of the warm-up left: the takes. */
export type IntakePart = "takes";

/**
 * What a take answers: someone they will meet (a person asking for what they do, a skeptic under their reply, a lead
 * pushing back on price), and what that person wrote. Written for each customer from their brief.
 */
export interface Scene {
  /** Who they are, as the customer would see them: "Maya, runs a 3-person design studio". */
  readonly who: string;
  /** Where it happens: "r/SaaS, under your reply". */
  readonly where: string;
  /** What they write, the way people type it there. */
  readonly says: string;
  /** A real post the first sweep found (finds/sweep.ts), not someone Quest pictured: its address. */
  readonly url?: string;
  /** That post's find: "That's me" offers its card, with these words to post. */
  readonly findId?: string;
}

/**
 * What Quest took from their answer to a take, looking back at what it wrote: a line to them on what it changes, and
 * how it writes as them from now on, all of it ("lowercase, \"i\" included", "two short sentences at most").
 */
export interface Reflection {
  /** To them, in a line: "Shorter, and I say it's yours in the first line." */
  readonly noted: string;
  /** Every rule of how it writes as them, after this take. */
  readonly rules: readonly string[];
}

export interface IntakeQuestion {
  readonly key: string;
  /** The question as the customer reads it, in Quest's voice. */
  readonly text: string;
  /** What it asks about, in a few words, for the manager's instructions: "take 2 of Quest writing as them". */
  readonly about: string;
  readonly options: readonly IntakeOption[];
  /** Its options are written for this customer when it is asked (a take's words), and kept on their answer. */
  readonly written?: boolean;
  /** A line under the question. */
  readonly help?: string;
  readonly part?: IntakePart;
}

/** What an entry went out with, kept on it. */
export interface AskedWith {
  /** A take's options: its words as them. */
  readonly options?: readonly IntakeOption[];
  /** What a take answers. */
  readonly scene?: Scene;
  /** Where they show up, as Quest read it from their words: platform keys. */
  readonly guess?: readonly string[];
}

/** The fields an entry keeps of what its question went out with. */
export const askedFields = (a: AskedWith): Pick<ProfileEntry, "options" | "scene" | "guess"> => ({
  ...(a.options ? { options: [...a.options] } : {}),
  ...(a.scene ? { scene: a.scene } : {}),
  ...(a.guess?.length ? { guess: [...a.guess] } : {}),
});

/** What `choice` holds when they answered in their own words, or skipped. */
export const OWN_WORDS = "own";
export const SKIPPED = "skip";

/** One entry, once asked: when, on which message, and what came back. */
export interface ProfileEntry {
  readonly askedAt: Date;
  /** The message that asks, so a reply to it answers it. */
  readonly ref: string | null;
  /** When they answered or skipped; null while it waits. */
  readonly answeredAt: Date | null;
  /** The option they tapped (its id), OWN_WORDS or SKIPPED; null while it waits. */
  readonly choice: string | null;
  /** The answer in words: the option's label or what they wrote. Null while it waits, or skipped. */
  readonly answer: string | null;
  /** A take's options, as they were asked. */
  readonly options?: readonly IntakeOption[];
  /** What a take answers, as it was asked. */
  readonly scene?: Scene;
  /** Where they show up, as Quest read it. */
  readonly guess?: readonly string[];
  /** What Quest took from their answer to a take. */
  readonly reflection?: Reflection;
  /** Their answer came as a voice message: its words are theirs, its casing and punctuation the transcriber's. */
  readonly spoken?: boolean;
}

/** Every entry so far, by key. */
export type Profile = Readonly<Record<string, ProfileEntry>>;

export interface ProfileAnswer {
  readonly choice: string;
  readonly answer: string | null;
  readonly at: Date;
  readonly spoken?: boolean;
}
