import type { CustomerId } from "./ids.ts";

/**
 * What the work came to, in the terms that count for a business: people talking with the customer,
 * trying what they sell, using it, paying for it. Communities found, searches run and replies posted
 * are activity, not results (the customer's word, 2026-10-07: "communities found and removed posts are
 * activity, not customers").
 *
 * Each result is a person on record with its evidence (an answer Quest read, a sign-up the customer
 * told it about), or a count the customer or a source gave. A stage with neither is unknown, never
 * zero: Quest says "no idea yet" rather than "none".
 */
export const RESULT_STAGES = ["conversation", "trial", "active", "paying"] as const;
export type ResultStage = (typeof RESULT_STAGES)[number];

export const STAGE_WORDS: Readonly<Record<ResultStage, string>> = {
  conversation: "conversations",
  trial: "trials",
  active: "active users",
  paying: "paying customers",
};

/** Where a result's evidence came from: Quest saw it, the customer told it, or the code noticed it (an answer to a posted reply). */
export type ResultSource = "seen" | "told" | "system";

export interface ResultEntry {
  readonly id: string;
  readonly customerId: CustomerId;
  readonly stage: ResultStage;
  /** Who: "u/dana", "dana@acme.test". Null for a count. */
  readonly person: string | null;
  /** 1 for a person; for a count, the number as given (0 is a real zero). */
  readonly count: number;
  readonly url: string | null;
  /** In a line: what shows it ("answered the reply in r/nocode: 'how much is it?'"). */
  readonly evidence: string;
  readonly source: ResultSource;
  readonly at: Date;
}

export interface NewResult {
  readonly stage: ResultStage;
  readonly person: string | null;
  readonly count: number;
  readonly url: string | null;
  readonly evidence: string;
  readonly source: ResultSource;
}

/** One stage as the record has it. */
export interface StageSummary {
  readonly stage: ResultStage;
  /** People on record at this stage, newest first. */
  readonly people: readonly ResultEntry[];
  /** The latest count given, if any. */
  readonly count: ResultEntry | null;
}

/** Each stage from the record, entries in any order. */
export function summarizeResults(entries: readonly ResultEntry[]): StageSummary[] {
  const newest = [...entries].sort((a, b) => b.at.getTime() - a.at.getTime());
  return RESULT_STAGES.map((stage) => ({
    stage,
    people: newest.filter((e) => e.stage === stage && e.person),
    count: newest.find((e) => e.stage === stage && !e.person) ?? null,
  }));
}

/**
 * A stage in a few words: "unknown", "0 (they told you, 7 Oct)", "at least 2 (u/dana, u/lee)".
 * People recorded after the last count add to it; without a count they are a floor, not a total.
 */
export function stageWords(s: StageSummary, day: (d: Date) => string): string {
  const after = s.count ? s.people.filter((p) => p.at > s.count!.at) : s.people;
  const names = (ps: readonly ResultEntry[]): string =>
    ps.slice(0, 4).map((p) => p.person).join(", ") + (ps.length > 4 ? `, +${ps.length - 4}` : "");
  if (s.count) {
    const total = s.count.count + after.length;
    const said = s.count.source === "told" ? "they told you" : "on record";
    return `${total} (${said} ${s.count.count} on ${day(s.count.at)}${after.length ? `, then ${names(after)}` : ""})`;
  }
  if (s.people.length) return `at least ${s.people.length} (${names(s.people)})`;
  return "unknown";
}
