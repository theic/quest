import type { CustomerId, MemoryRepository } from "@mq/core";

/**
 * What the "What works" run learned is kept by code (the founder, 2026-11-14, on a LinkedIn post that drew more than the
 * others: "have to teach Quest to write down such patterns during reflection phase"). Its report ended in three lessons
 * the manager was to keep, and in five days it kept none: the next post was written knowing nothing of the last.
 * The lessons under the report's "lessons" heading are kept as they stand, and the ones the run before left are retired,
 * so every run's opening carries the latest reading and nothing piles up.
 */

export const WHAT_WORKS = "What works";
const MARK = `${WHAT_WORKS} (`;
const MAX_LESSONS = 4;

/** The numbered lines under the report's last "lessons" heading, each one sentence or two, marks of emphasis gone. */
export function lessonsFrom(report: string): string[] {
  const lines = report.split(/\r?\n/);
  let from = -1;
  lines.forEach((l, i) => {
    if (/lessons?\b/i.test(l) && !/^\s*(\d+[.)]|[-*•])\s/.test(l) && l.trim().length < 120) from = i;
  });
  if (from < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(from + 1)) {
    const m = /^\s*(?:\d+[.)]|[-*•])\s+(.{20,})$/.exec(l);
    if (m) out.push(m[1]!.replace(/\*\*|__|`/g, "").trim().slice(0, 400));
    else if (out.length && l.trim()) break;
  }
  return out.slice(0, MAX_LESSONS);
}

/** Keeps a report's lessons and retires the ones an earlier report left; how many were kept. */
export async function keepLessons(memory: MemoryRepository, customerId: CustomerId, report: string, now: Date = new Date()): Promise<number> {
  const lessons = lessonsFrom(report);
  if (!lessons.length) return 0;
  const before = (await memory.list(customerId, 200)).filter((m) => m.kind === "lesson" && m.text.startsWith(MARK));
  const day = now.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  let kept = 0;
  for (const text of lessons) if ((await memory.add(customerId, { kind: "lesson", source: "system", text: `${MARK}${day}): ${text}` })).added) kept += 1;
  if (kept) for (const m of before) await memory.retire(customerId, m.id);
  return kept;
}
