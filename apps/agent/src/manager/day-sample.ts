import { platformName } from "../drafts/autopilot.ts";
import type { SentLine } from "../infra/pg-draft-marks.ts";

/** How many messages are drawn at random for the day's sample. */
export const SAMPLE = 5;

const KINDS: Readonly<Record<string, string>> = { reply: "reply", message: "message", post: "post" };

const line = (s: SentLine): string => {
  const to = s.kind === "post" ? "" : s.author ? ` to ${s.author}` : "";
  return `${platformName(s.platform)} ${KINDS[s.kind] ?? s.kind}${to}: "${s.text.replace(/\s+/g, " ").trim().slice(0, 180)}"`;
};

/**
 * Staying in control at volume (the founder, 2026-11-18: "A daily sample, not the full list. Five random messages from
 * today plus the outliers: the longest, any that mention your product, any the checks sent back for a rewrite. Reading
 * ten tells you about the rest"). Drawn by code from what went up today: nobody picks what they see.
 */
export function daySample(sent: readonly SentLine[], promotes: (text: string) => boolean, roll: () => number = Math.random): string | null {
  if (!sent.length) return null;
  const pool = [...sent];
  const drawn: SentLine[] = [];
  while (drawn.length < SAMPLE && pool.length) drawn.push(pool.splice(Math.floor(roll() * pool.length), 1)[0]!);
  const shown = new Set(drawn.map((d) => d.id));
  const fresh = (xs: readonly SentLine[], n: number): SentLine[] => xs.filter((x) => !shown.has(x.id) && shown.add(x.id)).slice(0, n);
  const longest = fresh([...sent].sort((a, b) => b.text.length - a.text.length), 1);
  const named = sent.filter((s) => promotes(s.text));
  const back = sent.filter((s) => s.sentBack);
  const namedShown = fresh(named, 2);
  const backShown = fresh(back, 2);
  const outliers = [
    ...longest.map((s) => `- the longest: ${line(s)}`),
    ...namedShown.map((s) => `- names your product (${named.length} today): ${line(s)}`),
    ...backShown.map((s) => `- rewritten after a check (${back.length} today): ${line(s)}`),
  ];
  return [
    sent.length <= SAMPLE ? `All ${sent.length} that went up today:` : `A sample of today: ${drawn.length} of the ${sent.length} that went up, drawn at random.`,
    ...drawn.map((s, i) => `${i + 1}. ${line(s)}`),
    ...(outliers.length ? ["Worth a look:", ...outliers] : []),
  ].join("\n");
}

/** What waits on them, in a line, by what kind of thing it is; null when nothing does. */
export function needsYou(waiting: { readonly total: number; readonly product: number; readonly messages: number; readonly profile: number; readonly people: number }): string | null {
  if (!waiting.total) return null;
  const parts = [
    waiting.people ? `${waiting.people} from people waiting on you` : null,
    waiting.product ? `${waiting.product} that name your product` : null,
    waiting.messages ? `${waiting.messages} private ${waiting.messages === 1 ? "message" : "messages"}` : null,
    waiting.profile ? `${waiting.profile} profile ${waiting.profile === 1 ? "change" : "changes"}` : null,
  ].filter(Boolean);
  return `Needs you: ${waiting.total} waiting for your ok${parts.length ? ` (${parts.join(", ")})` : ""}.`;
}
