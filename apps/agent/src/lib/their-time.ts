/**
 * Time the way a person keeps it for someone they work with: their clock, how long ago, how long
 * something takes, and the times Quest gives them ("give me 5 min", "within the hour", "this
 * afternoon"), read out of what it wrote so a promise made in passing is still kept.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Their wall clock at `t`, as a timestamp whose UTC fields read as their local time. */
export function wall(t: Date, timezone: string | null): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone ?? "UTC",
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }).formatToParts(t);
    const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
    return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  } catch {
    return t.getTime();
  }
}

/** The moment their clock reads `hour:minute`, `days` days after the day `t` falls on for them. */
export function atTheirTime(t: Date, timezone: string | null, hour: number, minute = 0, days = 0): Date {
  const local = new Date(wall(t, timezone));
  const target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days, hour, minute);
  const guess = target - (local.getTime() - t.getTime());
  // Across a clock change the offset moves: read it again at the target.
  return new Date(target - (wall(new Date(guess), timezone) - guess));
}

/** Morning, afternoon, evening or night, by their clock. */
export function partOfDay(t: Date, timezone: string | null): "morning" | "afternoon" | "evening" | "night" {
  const h = new Date(wall(t, timezone)).getUTCHours();
  return h >= 5 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : h >= 17 && h < 22 ? "evening" : "night";
}

/** A length of time in a few words: "40 s", "5 min", "1 h 20 min", "3 h", "2 days". */
export function span(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < MINUTE) return `${Math.max(1, Math.round(abs / 1000))} s`;
  const min = Math.round(abs / MINUTE);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  if (h < 24) return rest && h < 6 ? `${h} h ${rest} min` : `${Math.round(min / 60)} h`;
  const days = Math.round(abs / DAY);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** Their clock at `t`, the way a turn shows it: "14:05 Wed" (with the day only when it is not today). */
export function theirHour(t: Date, now: Date, timezone: string | null, locale = "en-GB"): string {
  const zone = timezone ?? "UTC";
  try {
    const time = t.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", timeZone: zone });
    const sameDay = new Date(wall(t, zone)).toISOString().slice(0, 10) === new Date(wall(now, zone)).toISOString().slice(0, 10);
    return sameDay ? time : `${t.toLocaleDateString(locale, { weekday: "short", timeZone: zone })} ${time}`;
  } catch {
    return theirHour(t, now, null, "en-GB");
  }
}

const NUMBERS: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  "forty five": 45,
  "forty-five": 45,
  "a couple of": 2,
  "a couple": 2,
  couple: 2,
  "a few": 5,
  few: 5,
};

const WORD_AMOUNT = String.raw`a couple(?: of)?|a few|forty[- ]five|an?|one|two|three|four|five|ten|fifteen|twenty|thirty`;
/**
 * "5 min", "in 10-15 minutes", "within an hour", "a couple of hours": an amount and a unit. Not "5 min
 * ago", nor "the last 24 hours" (a span of the past, not a time Quest gives), nor "10 am".
 */
const DURATION = new RegExp(
  String.raw`(?<!\b(?:last|past|previous|every|each|per|over|first|than|the)\s+)(?:\b(?:in|within|about|around|another)\s+)?` +
    String.raw`(?:\b(\d+(?:\.\d+)?(?:\s*(?:-|–|to)\s*\d+)?)\s*|\b(${WORD_AMOUNT})\s+)(?:more\s+)?(minutes?|mins?|hours?|hrs?|h|m)\b(?!\s*ago)`,
  "i",
);

/** Whether a sentence promises something of Quest's own: "give me", "I'll get back", "you'll have it". */
const CUE =
  /\b(give me|get back|back to you|back here|back with|come back|i'?ll (?:have|send|share|bring|tell|let you know|report|ping|update|check|look|confirm|come back|be back|get)|i will (?:have|send|share|bring|tell|let you know|report|ping|update|check|look|confirm|come back|be back|get)|you'?ll (?:have|get|hear)|expect (?:it|them|this|that|the|a|an|my)|need (?:another|a few more|a bit more|more|\d+)|(?:it'?ll|it will|they'?ll|they will) be (?:ready|done|there)|should (?:have it|have them|be done|be ready))\b/i;
/**
 * Work under way with a time on it, which they will expect to hear back about: "I'm running today's
 * search, about 10 min", "Going after the visa asks now, about 10 min", "Today's search is still
 * running, ~7 min", "Back in ~10 min" (each from the real model, 2026-10-07).
 */
const UNDER_WAY =
  /\b(?:i'?m|i am|we'?re|we are|is|are)\s+(?:also\s+|now\s+|still\s+)?[a-z]+ing\b|^(?:also\s+|now\s+)?[a-z]+ing\b|\b(?:back|be back) (?:in|within)\b/i;
/** Said of work done: "Reading your site took 10 min" promises nothing. */
const PAST = /\b(took|was|were|did|had|spent|lasted|ago)\b/i;
/**
 * With only work under way to go on, the time must read as an estimate ("about 10 min", "in ~5 min", "~7 min", or a time
 * that ends the sentence, "Reading your site now, 5 min.": the real model, 2026-10-31), not a rate ("10 replies an hour").
 */
const ESTIMATE = /(?:\b(?:in|within|about|around|another)\s+~?|~\s*)(?:\d|an?\b|a few|a couple|half)|[,:–—-]\s*\d+(?:\s*(?:-|–|to)\s*\d+)?\s*(?:minutes?|mins?|hours?|hrs?)[.!]*$/i;
/** "More in ~10 min", "within the hour": a time from now is a time given, whatever the sentence's verb (the real model, 2026-10-07). */
const FROM_NOW = /\b(?:in|within)\s+~?(?:\d|an?\b|a few|a couple|half|the hour)/i;
const NOT = /\b(can'?t|cannot|won'?t|unable|couldn'?t)\b/i;

function amount(raw: string): number {
  const range = /(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)/.exec(raw);
  if (range) return Number(range[2]);
  if (/^\d/.test(raw)) return Number(raw);
  return NUMBERS[raw.toLowerCase().trim()] ?? 1;
}

const unitMs = (unit: string): number => (/^h/i.test(unit) ? HOUR : MINUTE);

/** A time a sentence gives, as a moment: a duration, or a part of their day. */
function timeIn(sentence: string, now: Date, timezone: string | null): { due: Date; words: string } | null {
  const s = sentence.toLowerCase();
  const at = (hour: number, minute = 0, days = 0): Date => atTheirTime(now, timezone, hour, minute, days);
  const later = (d: Date, min: number): Date => new Date(Math.max(d.getTime(), now.getTime() + min));
  if (/\bhalf an? hour\b/.test(s)) return { due: new Date(now.getTime() + 30 * MINUTE), words: "half an hour" };
  if (/\bwithin the hour\b/.test(s)) return { due: new Date(now.getTime() + HOUR), words: "within the hour" };
  const d = DURATION.exec(sentence);
  if (d) {
    const ms = amount(d[1] ?? d[2]!) * unitMs(d[3]!);
    if (ms >= MINUTE && ms <= 7 * DAY) return { due: new Date(now.getTime() + ms), words: d[0].trim() };
  }
  if (/\bin a (sec|second|moment|minute)\b/.test(s)) return { due: new Date(now.getTime() + 2 * MINUTE), words: "in a minute" };
  if (/\bshortly\b/.test(s)) return { due: new Date(now.getTime() + 15 * MINUTE), words: "shortly" };
  if (/\btomorrow morning\b/.test(s)) return { due: at(10, 0, 1), words: "tomorrow morning" };
  if (/\btomorrow\b/.test(s)) return { due: at(12, 0, 1), words: "tomorrow" };
  if (/\bthis afternoon\b/.test(s)) return { due: later(at(16), HOUR), words: "this afternoon" };
  if (/\b(this evening|tonight)\b/.test(s)) return { due: later(at(19), HOUR), words: /tonight/.test(s) ? "tonight" : "this evening" };
  if (/\b(later today|by (the )?end of (the )?day|by eod|today)\b/.test(s)) return { due: later(at(18), 2 * HOUR), words: "later today" };
  return null;
}

/** A time Quest gave them in something it wrote: what it promised, in its own words, and by when. */
export interface PromisedTime {
  /** The sentence that promised it. */
  readonly sentence: string;
  /** The words that gave the time: "give me 5 min", "within an hour". */
  readonly words: string;
  readonly due: Date;
}

/**
 * The promises with a time in a message Quest wrote: a sentence that commits to something ("give me",
 * "I'll get back to you", "you'll have it"), or tells of work under way ("I'm running the search"),
 * and gives a time. "I can't schedule a message for later" promises nothing, nor does "5 min ago".
 */
export function promisedTimes(text: string, now: Date, timezone: string | null): PromisedTime[] {
  const out: PromisedTime[] = [];
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.trim().replace(/[’‘]/g, "'");
    if (!sentence || NOT.test(sentence)) continue;
    const underWay = (UNDER_WAY.test(sentence) && ESTIMATE.test(sentence)) || FROM_NOW.test(sentence);
    if (!CUE.test(sentence) && !(underWay && !PAST.test(sentence))) continue;
    const t = timeIn(sentence, now, timezone);
    if (!t || t.due.getTime() <= now.getTime()) continue;
    const give = /\bgive me\b/i.test(sentence) ? `give me ${t.words.replace(/^(in|within|about|around)\s+/i, "")}` : t.words;
    out.push({ sentence: sentence.slice(0, 300), words: give, due: t.due });
  }
  return out;
}

/** Asking to hear back: "get back to me", "ping me", "come back", "tell me", "send me", "let me know". */
const ASK_BACK =
  /\b(get back|come back|back to me|ping|text|message|tell|send|update|report back|check back|circle back|remind|let me know|follow up|show me|give me)\b/i;
/** "in 5 min", "in two minutes", "in an hour", "in half an hour": a time from now, not "within" one (a deadline, where sooner is fine). */
const IN_TIME = new RegExp(String.raw`(?<!with)\bin\s+(?:half an? hour|(?:\d+(?:\.\d+)?|${WORD_AMOUNT})\s+(?:minutes?|mins?|hours?|hrs?|h|m))\b`, "i");
/** "at 15:30", "at 3pm", "at 3:30 pm": a time on their clock. */
const AT_TIME = /\bat\s+(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)(?![\w:.])/i;

/**
 * The time a customer asked to hear back at, from their own words: "Get back to me in 5 min with
 * which one I should DM first", "Ping me in 3 min with the first line", "tell me at 15:30". Null
 * for a deadline ("within the hour", "by 3pm": sooner is fine), or without an ask to hear back.
 * Live, 2026-10-07 and 2026-10-08: both asks were answered within seconds.
 */
export function askedFor(text: string, now: Date, timezone: string | null): { due: Date; words: string } | null {
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = raw.trim().replace(/[’‘]/g, "'");
    if (!ASK_BACK.test(sentence)) continue;
    const inTime = IN_TIME.exec(sentence);
    const t = inTime ? timeIn(inTime[0], now, timezone) : null;
    if (t && t.due.getTime() - now.getTime() >= MINUTE) return { due: t.due, words: inTime![0] };
    const at = AT_TIME.exec(sentence);
    const due = at ? whenFrom({ at: at[1]! }, now, timezone) : null;
    if (due && due.getTime() - now.getTime() >= MINUTE && due.getTime() - now.getTime() <= DAY) return { due, words: at![0] };
  }
  return null;
}

/**
 * A time the manager gives a tool: `minutes` from now, or `at` on their clock ("15:30", "tomorrow 10:00",
 * "3pm", "tomorrow"). A time of day already past today means tomorrow. Null when it cannot be read.
 */
export function whenFrom(input: { minutes?: number | undefined; at?: string | undefined }, now: Date, timezone: string | null): Date | null {
  if (input.minutes !== undefined) {
    return input.minutes >= 1 && input.minutes <= 14 * 24 * 60 ? new Date(now.getTime() + Math.round(input.minutes) * MINUTE) : null;
  }
  const raw = input.at?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "tomorrow") return atTheirTime(now, timezone, 10, 0, 1);
  const m = /^(today|tomorrow|tonight)?\s*(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/.exec(raw);
  if (!m) return null;
  let hour = Number(m[2]);
  const minute = Number(m[3] ?? 0);
  if (m[4] === "pm" && hour < 12) hour += 12;
  if (m[4] === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const days = m[1] === "tomorrow" ? 1 : 0;
  const at = atTheirTime(now, timezone, hour, minute, days);
  return !days && at.getTime() <= now.getTime() ? atTheirTime(now, timezone, hour, minute, 1) : at;
}
