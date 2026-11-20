import { languageBriefing } from "@mq/i18n";
import {
  draftLabel,
  postsAlone,
  TRUST_AFTER,
  SKIP_REASON_WORDS,
  sourceLabel,
  STAGE_WORDS,
  stageWords,
  summarizeResults,
  type AgentPace,
  type ChromeStatus,
  type Commitment,
  type ResultEntry,
  type Route,
  type Task,
  type Customer,
  type DayFacts,
  type Draft,
  type Find,
  type Memory,
  type Place,
  type QueuedEvent,
  type TranscriptEntry,
} from "@mq/core";
import { aboutThem, pickedPlatforms } from "../conversation/intake.ts";
import { PLATFORMS, platformOf } from "../platforms.ts";
import { CARD_MARK, DONE_MARK, QUESTION_MARK } from "../conversation/messenger.ts";
import { bySource, type FindBoard } from "../finds/find-service.ts";
import { clip } from "../lib/sleeper.ts";
import { partOfDay, span, theirHour } from "../lib/their-time.ts";
import type { BoardCounts } from "../tasks/task-service.ts";
import { isDue } from "./commitments.ts";
import { followUpDue, waitingOn, type WaitingOn } from "./follow-up.ts";
import { overlap, SAME_MEMORY } from "../lib/overlap.ts";
import type { EnergyView } from "../billing/energy.ts";

export interface TurnBriefing {
  readonly now: Date;
  readonly customer: Customer;
  readonly events: readonly QueuedEvent[];
  readonly board: BoardCounts;
  readonly questions: { readonly notAsked: number; readonly asked: number };
  readonly finds: FindBoard;
  readonly places: readonly Place[];
  readonly chrome: ChromeStatus;
  readonly chat: ChatPulse;
  readonly userTurn: boolean;
  /** What Quest keeps for good, newest first. */
  readonly memories: readonly Memory[];
  /** The chat's last messages, oldest first, without the ones this turn's events already carry. */
  readonly recent: readonly TranscriptEntry[];
  /** The day's record, when this turn carries the evening report. */
  readonly day: DayFacts | null;
  /** In a turn where they wrote: the question they owed an answer to before they did. */
  readonly owed?: WaitingOn | null;
  /** What Quest wrote for them to post, newest first. */
  readonly drafts?: readonly Draft[];
  /** What went up from their accounts this week, kind by kind, per platform (warm-up.ts `mixLines`). */
  readonly mix?: readonly string[];
  /** Their ideas for posts and Quest's, and their assets (idea-service.ts `ideaLines`). */
  readonly steering?: readonly string[];
  /** Their profile changes, drafted or done, for where they show up. */
  readonly profiles?: readonly Draft[];
  /** Posts they approved on Reddit (trust.ts). */
  readonly approved?: number;
  readonly globalApproved?: number;
  /** What Quest owes, open (soonest first) and lately settled (newest first). */
  readonly commitments?: { readonly open: readonly Commitment[]; readonly settled: readonly Commitment[] };
  /** What the work came to, newest first. */
  readonly results?: readonly ResultEntry[];
  /** The ways Quest goes after results, most recently tried first. */
  readonly routes?: readonly Route[];
  /** How long each teammate's runs take lately. */
  readonly paces?: readonly AgentPace[];
  /** Tasks queued, running or waiting, newest first. */
  readonly open?: readonly Task[];
  /** Their plan and the day's credits: tired near the end of them, resting once they are spent. */
  readonly energy?: EnergyView | null;
}

/** How the chat has been going: what a person would glance at before texting someone first. */
export interface ChatPulse {
  /** When they last wrote, or did something the chat confirmed (connected their Chrome). */
  readonly lastFromThem: Date | null;
  readonly lastToThem: Date | null;
  /** What Quest said since then, cards, questions and those confirmations aside. */
  readonly unanswered: number;
  /** Of those, the ones said today, their time. */
  readonly unansweredToday: number;
  /** The hours (UTC) they have written in, e.g. "07-09, 19", or null while there are too few messages to tell. */
  readonly theirHours: string | null;
  /** The question they have not answered since they last wrote, if any, and when to follow it up. */
  readonly waitingOn: WaitingOn | null;
}

/** A confirmation of something they did: their move in the chat, though Quest sent it. */
const theirMove = (e: TranscriptEntry): boolean => e.direction === "in" || e.text.startsWith(DONE_MARK);
const said = (e: TranscriptEntry): boolean => e.direction === "out" && !e.text.startsWith(CARD_MARK) && !e.text.startsWith(QUESTION_MARK) && !e.text.startsWith(DONE_MARK);

const hourRanges = (hours: readonly number[]): string => {
  const two = (h: number): string => String(h).padStart(2, "0");
  const ranges: string[] = [];
  for (let i = 0; i < hours.length; i++) {
    let j = i;
    while (j + 1 < hours.length && hours[j + 1] === hours[j]! + 1) j++;
    ranges.push(i === j ? two(hours[i]!) : `${two(hours[i]!)}-${two(hours[j]!)}`);
    i = j;
  }
  return ranges.join(", ");
};

/**
 * Reads the pulse from the transcript, oldest entry first; "today" is their day, in their time zone.
 * `openCard` says whether a question card's question is still waiting on them.
 */
export function chatPulse(entries: readonly TranscriptEntry[], now: Date, timezone: string | null, openCard?: (text: string) => boolean): ChatPulse {
  const theirs = entries.filter((e) => e.direction === "in");
  const lastFromThem = entries.filter(theirMove).at(-1)?.at ?? null;
  const hours = [...new Set(theirs.map((e) => e.at.getUTCHours()))].sort((a, b) => a - b);
  const unanswered = entries.filter((e) => said(e) && (!lastFromThem || e.at > lastFromThem));
  const today = theirClock(now, timezone).day;
  return {
    lastFromThem,
    lastToThem: entries.filter(said).at(-1)?.at ?? null,
    unanswered: unanswered.length,
    unansweredToday: unanswered.filter((e) => theirClock(e.at, timezone).day === today).length,
    theirHours: theirs.length >= 3 ? hourRanges(hours) : null,
    waitingOn: waitingOn(entries, timezone, openCard),
  };
}

function chaseLine(w: WaitingOn, now: Date, timezone: string | null): string {
  const since = w.followUps ? `, and you have written to them ${w.followUps === 1 ? "once" : `${w.followUps} times`} since` : "";
  const asked = ` They still owe you an answer: you asked "${clip(w.text.replace(/\s+/g, " "), 200)}" ${ago(w.askedAt, now)}${since}.`;
  if (!w.nextAt) return `${asked} You have chased it for a week: leave it until they write.`;
  if (followUpDue(w, now)) return `${asked} A follow-up is due now (see WHEN THEY GO QUIET).`;
  return `${asked} Your next follow-up is due ${theirClock(w.nextAt, timezone).time} their time; until then, nothing more about it.`;
}

function owedLine(w: WaitingOn, now: Date): string {
  return (
    `Before they wrote, you were waiting on their answer to "${clip(w.text.replace(/\s+/g, " "), 200)}" (asked ${ago(w.askedAt, now)}). ` +
    "If what they wrote answers it, use the answer. If it does not and you still need it, end your reply by asking it again as a question, in a line and in new words: " +
    "a new request does not make the old question go away."
  );
}

function chatLine(p: ChatPulse, now: Date, timezone: string | null): string {
  const them = p.lastFromThem ? `they last wrote ${ago(p.lastFromThem, now)}` : "they have not written yet";
  const you = p.lastToThem ? `you last wrote ${ago(p.lastToThem, now)}` : "you have not written yet";
  const today = p.unansweredToday === p.unanswered ? "" : `, ${p.unansweredToday} of them today`;
  const waiting = p.unanswered ? ` ${p.unanswered} message${p.unanswered === 1 ? "" : "s"} from you since they last wrote${today}.` : "";
  const hours = p.theirHours ? ` They have written to you at ${p.theirHours} UTC.` : " Too few messages yet to tell when they are usually around.";
  return `The chat: ${them}; ${you}.${waiting}${hours}${p.waitingOn ? chaseLine(p.waitingOn, now, timezone) : ""}`;
}

const decided = (f: Find, now: Date): string => {
  const what = f.sentUrl
    ? "posted with Post it"
    : f.status === "skipped" && f.skipReason
      ? `skipped (${SKIP_REASON_WORDS[f.skipReason].toLowerCase()})`
      : f.status;
  const held = f.postState === "posting" || f.postState === "uncertain" ? `, ${f.postState} [find ${f.id}]: inspect before retrying` : "";
  return `  - ${what}${held} ${f.decidedAt ? ago(f.decidedAt, now) : ""}: ${sourceLabel(f.source, f.url)}, "${clip(f.quote, 90)}"`;
};

function findsLines(b: FindBoard, now: Date): string[] {
  const c = b.counts;
  if (!c.new && !c.shown && !c.kept && !c.skipped && !c.replied) return ["Finds: none yet."];
  return [
    `Finds: ${c.new} waiting to be shown${b.waiting.length ? ` (next: ${bySource(b.waiting)})` : ""}, ${c.shown} on cards in front of the customer; ` +
      `so far ${c.kept} kept, ${c.replied} replied to, ${c.skipped} skipped.`,
    ...(b.recent.length ? ["Their latest decisions:", ...b.recent.map((f) => decided(f, now))] : []),
  ];
}

function placesLine(places: readonly Place[], now: Date): string {
  if (!places.length) return "Places: none on file yet. The explorer finds them and reads their rules.";
  const names = (ps: readonly Place[]): string => ps.slice(0, 6).map((p) => p.name).join(", ") + (ps.length > 6 ? ", …" : "");
  const group = (verdict: Place["verdict"], words: string): string | null => {
    const ps = places.filter((p) => p.verdict === verdict);
    return ps.length ? `${ps.length} ${words} (${names(ps)})` : null;
  };
  const last = new Date(Math.max(...places.map((p) => p.updatedAt.getTime())));
  const groups = [group("search", "to search"), group("avoid", "to avoid"), group("login", "members only")].filter(Boolean);
  return `Places: ${groups.join("; ")}. Last explored ${ago(last, now)}.`;
}

const DRAFT_STATE: Readonly<Record<Draft["status"], string>> = { open: "on its card", posting: "send started; inspect before any retry", uncertain: "send outcome unknown; inspect before any retry", posted: "posted", skipped: "skipped" };

/**
 * Where they show up, as read from their words, and what is known of their profile on each: their account there (a
 * fact kept), the profile check drafted and how it stands. The picture the profile work starts from.
 */
export function presenceLines(c: Customer, profiles: readonly Draft[], memories: readonly Memory[], now: Date): string[] {
  const picked = pickedPlatforms(c);
  if (!picked.length) {
    return c.profile["where"]?.answeredAt
      ? ["Where they show up: not said yet. Before work starts on a platform they have not named, ask once which ones, in a line."]
      : [];
  }
  return [
    "Where they show up (from their words; the work happens there first, and nowhere new without asking):",
    ...picked.map((key) => {
      const p = PLATFORMS.find((x) => x.key === key);
      const account = p ? memories.find((m) => m.kind === "fact" && p.hosts.some((h) => m.text.toLowerCase().includes(h)))?.text : undefined;
      const changes = profiles.filter((d) => platformOf(d.url || d.platform)?.key === key);
      const state = changes.length
        ? `profile check: ${changes.map((d) => `${d.target} ${DRAFT_STATE[d.status]} (${ago(d.createdAt, now)})`).join(", ")}`
        : "no profile check yet";
      return `  - ${p?.name ?? key}: ${account ? `${clip(account, 120)}; ` : ""}${state}`;
    }),
  ];
}

function draftLines(drafts: readonly Draft[], now: Date): string[] {
  if (!drafts.length) return [];
  return [
    "Your drafts (newest first):",
    ...drafts.map(
      (d) =>
        `  - ${draftLabel(d).replace(/^your /, "")}, ${ago(d.createdAt, now)}: ${d.status === "posted" && d.alone ? "posted by you, without a tap" : DRAFT_STATE[d.status]}` +
        `${d.sentUrl ? ` (${d.sentUrl})` : ""}${["open", "posting", "uncertain"].includes(d.status) ? ` [${d.id}]` : ""}`,
    ),
  ];
}

function postingLine(approved: number): string {
  return postsAlone(approved)
    ? `Posting on Reddit: you post by yourself. Drafts, including messages, go up without a tap. Use posting to change this per host or for all platforms.`
    : `Posting on Reddit: you ask first (${approved} of ${TRUST_AFTER} approved). After ${TRUST_AFTER} they tapped Post it on, you post there by yourself.`;
}

/** They switched browsing off: the turn answers them, and starts nothing it would have to wait for. */
function offLine(since: Date, now: Date): string {
  return (
    `BROWSING IS OFF: they switched Quest off ${ago(since, now)}, to use their computer undisturbed. Nothing runs in their Chrome, no task runs and nothing is posted until they switch it back on (the switch pinned in their chat, or on their page). ` +
    "Answer what they wrote from what you already know. Do not open pages, do not promise work or a time for it, and do not ask them to switch it on: say it waits only if they ask for something that needs it. A task you start now only joins the queue."
  );
}

function chromeLine(c: ChromeStatus, now: Date): string {
  const device = c.device ? ` (${c.device})` : "";
  const hidden =
    c.hidden && c.hidden.count >= 3
      ? ` ${c.hidden.count} reads in the last day failed because their Chrome window was minimised or covered (last ${ago(c.hidden.last, now)}). ` +
        "Only they can fix that: unless you already did, ask them once to leave Chrome open, even behind their other apps."
      : "";
  if (c.online) return `Their Chrome${device}: connected and open. Your team can read and search the web.${hidden}`;
  if (c.linked) {
    return (
      `Their Chrome${device}: connected, but silent${c.lastSeenAt ? ` (last heard from ${ago(c.lastSeenAt, now)})` : ""}. Reading and web search wait until it is back. ` +
      "You can't tell why: it may be closed or asleep, or its extension may not reach you. Never tell them it is closed or not installed. " +
      "Mention it at most once a day, in a line, and send connect_chrome only when they say it is open."
    );
  }
  if (c.offeredAt) {
    return (
      `Their Chrome: not connected. You sent the setup ${ago(c.offeredAt, now)} and it is still in their chat; reading and web search wait until it is connected, and you get a note then. ` +
      "Do not send it again or remind them of it: connect_chrome with again only when they ask for a new link or say the code expired."
    );
  }
  return "Their Chrome: not connected. Your team reads and searches the web only there: send the setup with connect_chrome before the first reading task.";
}

const when = (d: Date): string =>
  d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";

const ago = (from: Date, now: Date): string => {
  const min = Math.round((now.getTime() - from.getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

/** A promise as the manager reads it when it falls due, or is about to. */
function promiseDue(c: Commitment, now: Date, timezone: string | null): string {
  const said = c.words ? ` You told them "${c.words}" ${ago(c.createdAt, now)}.` : ` Promised ${ago(c.createdAt, now)}.`;
  if (isDue(c, now)) {
    return (
      `- Your promise #${c.id} is due now${c.onTime ? " (they asked for it at this time)" : ""}: ${c.what}.${said} ` +
      "Deliver it now with message_user and settle it as kept. If it truly is not ready, tell them now, plainly, why and how much longer, and settle it as moved."
    );
  }
  return (
    `- Your promise #${c.id} is due in ${span(c.dueAt.getTime() - now.getTime())}, at ${theirHour(c.dueAt, now, timezone)} their time: ${c.what}.${said} ` +
    "If it is ready, deliver it now and settle it as kept. If it will not be ready in time, tell them now, before the time passes, why and how much longer, " +
    `and settle it as moved. If it is on track, say nothing: you are woken again at ${theirHour(c.dueAt, now, timezone)}.`
  );
}

function commitmentDue(id: string, b: TurnBriefing): string {
  const c = b.commitments?.open.find((x) => x.id === id) ?? b.commitments?.settled.find((x) => x.id === id);
  if (!c) return `- Commitment #${id} fell due, but it is no longer on record: nothing to do for it.`;
  if (c.status !== "open") return `- Commitment #${c.id} fell due, but it is already ${c.status}: nothing to do for it.`;
  if (c.kind === "promise") return promiseDue(c, b.now, b.customer.timezone);
  return (
    `- A next step is due (#${c.id})${c.person ? `, with ${c.person}` : ""}${c.url ? ` (${c.url})` : ""}: ${c.what}. ` +
    "Do it now (look at the conversation, answer, send what they need, or give it to the outreach teammate), then settle it as kept; or move or drop it with a reason."
  );
}

function eventLine(e: QueuedEvent, b: TurnBriefing): string {
  const now = b.now;
  const ev = e.event;
  const at = ago(e.createdAt, now);
  const promised = (taskId: string): string => {
    const c = b.commitments?.open.find((x) => x.taskId === taskId);
    return c ? `\n  This was the work for your promise #${c.id} (${c.what}): deliver it and settle it.` : "";
  };
  switch (ev.kind) {
    case "user_message":
      return `- The customer wrote (${at}): "${ev.text}"`;
    case "task_finished":
      return ev.outcome === "succeeded"
        ? `- The ${ev.agent} finished task ${ev.taskId} (${at}). Report:\n${indent(ev.summary)}${promised(ev.taskId)}`
        : `- The ${ev.agent}'s task ${ev.taskId} ${ev.outcome} (${at}): ${ev.summary}${promised(ev.taskId)}`;
    case "commitment_due":
      return commitmentDue(ev.commitmentId, b);
    case "question_raised":
      return `- The ${ev.agent} (task ${ev.taskId}) asks (${at}), question ${ev.questionId}: "${ev.text}"`;
    case "question_answered":
      return `- The customer answered question ${ev.questionId} (${at}): "${ev.answer}". The teammate who asked has it and carries on.`;
    case "follow_up":
      return `- Time to follow up: they have not answered your question (see the chat below, and WHEN THEY GO QUIET).`;
    case "heartbeat":
      return `- Heartbeat: nothing new came in. Your time to move the work on (see BETWEEN MESSAGES).`;
    case "day_report":
      return `- Their evening (${ev.day}): time for today's report (see THE EVENING REPORT). The day's record is below.`;
    case "system":
      return `- ${ev.topic}: ${ev.text}`;
  }
}

const indent = (s: string): string => clip(s, 1_500).split("\n").map((l) => `    ${l}`).join("\n");

/** Their local time and date, from their time zone (UTC until Quest knows it). */
export function theirClock(now: Date, timezone: string | null): { readonly time: string; readonly day: string } {
  const zone = timezone ?? "UTC";
  try {
    const time = now.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: zone });
    const day = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: zone }).format(now);
    return { time, day };
  } catch {
    return theirClock(now, null);
  }
}

function timeLine(c: Customer, now: Date): string {
  const { time } = theirClock(now, c.timezone);
  const report = `${String(c.reportHour).padStart(2, "0")}:00`;
  return c.timezone
    ? `Their time: ${time}, their ${partOfDay(now, c.timezone)} (${c.timezone}). Their evening report goes out at ${report} their time.`
    : `Their time zone: not known yet. Their evening report goes out at ${report} UTC until you save it with set_timezone.`;
}

/**
 * The day's credits, as the manager works with them: how many are left, tired past most of them, and resting once
 * spent (the code told the customer, and stops the team). Plans and prices are said by code, never by the model,
 * unless the customer asks.
 */
function energyLine(e: EnergyView, now: Date, timezone: string | null): string {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const asks =
    " Never bring up prices or paying yourself. When they ask: Quest is pay as you go, with credit packs of $20 and $100 (their very first top-up comes with a bonus), or free on an invite, or free on their own computer (Quest is open source)" +
    `${e.link ? `; credits from their page ${e.link} (or /plan)` : ""}.`;
  const paying = e.access === "credits"
    ? `they pay as they go: ${usd(e.balance ?? 0)} of credits left`
    : `they're on an invite:Quest is free for them${e.balance ? `, and their ${usd(e.balance)} of credits go first` : ""}`;
  if (e.restUntil && e.resting === "credits") {
    return `Your energy: stopped. Their credits ran out; the code told them and gave them the way to top up, and a top-up starts you again at once. Nothing of theirs runs or starts before then, and what they send waits for it: write only what this turn must.${asks}`;
  }
  if (e.restUntil) {
    return `Your energy: resting. Today's work is done (${usd(e.used)} of the day's ${usd(e.limit)}, the same limit for everyone), until their midnight (${theirHour(e.restUntil, now, timezone)} their time); the code told them. Nothing of theirs runs or starts before then, and what they send waits for it: write only what this turn must.${asks}`;
  }
  const tired = e.tired ? ` You're tired: ${usd(Math.max(0, e.limit - e.used))} of today's work left. Start only what matters most, and nothing long.` : "";
  return `Your energy today: ${usd(e.used)} of ${usd(e.limit)} used (${paying}). At the limit you rest until their midnight: the code tells them and stops your team.${tired}${asks}`;
}

function owedLines(c: { readonly open: readonly Commitment[]; readonly settled: readonly Commitment[] }, now: Date, timezone: string | null): string[] {
  const when = (x: Commitment): string => {
    const left = x.dueAt.getTime() - now.getTime();
    const at = theirHour(x.dueAt, now, timezone);
    return left < -60_000 ? `OVERDUE by ${span(-left)} (was ${at})` : `due ${at} their time (${left > 0 ? `in ${span(left)}` : "now"})`;
  };
  const open = c.open.map(
    (x) =>
      `  - #${x.id} ${x.kind === "promise" ? "promise" : x.person ? `next step with ${x.person}` : "next step"}, ${when(x)}: ${clip(x.what, 160)}` +
      `${x.words ? ` (${x.source === "asked" ? "they asked" : "you said"} "${x.words}" ${ago(x.createdAt, now)})` : ""}${x.moves ? `, moved ${x.moves}x` : ""}${x.url ? ` ${x.url}` : ""}` +
      (x.held ? `. Its answer is written and goes out on its own then: "${clip(x.held, 160)}" (settle it if you answer sooner)` : ""),
  );
  const settled = c.settled.slice(0, 3).map((x) => `  - #${x.id} ${x.status} ${x.closedAt ? ago(x.closedAt, now) : ""}: ${clip(x.what, 100)}${x.note ? ` (${clip(x.note, 100)})` : ""}`);
  return [
    open.length ? "What you owe, soonest first (settle each once done; never let a time pass in silence):" : "What you owe: nothing open.",
    ...open,
    ...(settled.length ? ["Lately settled (done is done: never redo or report these as open):", ...settled] : []),
  ];
}

function resultsLine(entries: readonly ResultEntry[], timezone: string | null): string {
  const day = (t: Date): string => t.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: timezone ?? "UTC" });
  const stages = summarizeResults(entries).map((s) => `${STAGE_WORDS[s.stage]} ${stageWords(s, day)}`);
  return (
    `Results, what counts (record_result with evidence): ${stages.join("; ")}. ` +
    "Unknown is not zero: say \"no idea yet\" when nothing is on record. Places found, searches and posts are activity, not results."
  );
}

function routeLines(routes: readonly Route[]): string[] {
  if (!routes.length) return ["Routes: none logged yet. Name the route each piece of work tries, and log how tries went with log_try."];
  const line = (r: Route): string =>
    `  - "${r.name}": ${r.tries} ${r.tries === 1 ? "try" : "tries"}, ${r.wins} worked${r.misses ? `, last ${r.misses} did not` : ""}${r.lastNote ? ` (${clip(r.lastNote, 120)})` : ""}`;
  const group = (status: Route["status"], title: string): string[] => {
    const rs = routes.filter((r) => r.status === status);
    return rs.length ? [title, ...rs.slice(0, 8).map(line)] : [];
  };
  return [
    "Routes, the ways you go after results:",
    ...group("working", " Working:"),
    ...group("trying", " Trying:"),
    ...group("spent", " Spent (did not work twice in a row: change course, and go back only with new evidence):"),
  ];
}

function paceLines(paces: readonly AgentPace[], open: readonly Task[], now: Date): string[] {
  const pace = (agent: string): AgentPace | undefined => paces.find((p) => p.agent === agent);
  const team = paces.length
    ? `How long your team takes (last 14 days): ${paces.map((p) => `${p.agent} about ${span(p.medianMs)}, 8 in 10 within ${span(p.p80Ms)}`).join("; ")}. Give times from this, never "instantly".`
    : "How long your team takes: not measured yet. Reading a site takes a few minutes, a search run ten or more.";
  const running = open.map((t) => {
    const age = now.getTime() - t.createdAt.getTime();
    const p = pace(t.agent);
    const long = t.status === "running" && p && age > p.p80Ms ? `, longer than 8 in 10 of its runs: running late` : "";
    return `${t.agent} "${clip(t.title, 60)}" ${t.status} for ${span(age)}${long}`;
  });
  return [team, ...(running.length ? [`Open work: ${running.join("; ")}.`] : [])];
}

const KIND_TITLES: Record<Memory["kind"], string> = {
  decision: "What they decided or want",
  voice: "How their words sound (everything that goes out as them follows these)",
  lesson: "Lessons (never repeat the mistake)",
  fact: "Facts about them",
};

const shortDay = (d: Date): string => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function memoryLines(memories: readonly Memory[]): string[] {
  if (!memories.length) return ["What you keep for good: nothing yet. Keep their decisions and your lessons with remember as they come."];
  const lines = ["What you keep for good (remember adds, forget retires what stopped being true):"];
  if (memories.length >= 80) {
    lines.push("It is getting long: this turn, merge related entries (keep one that says it all, forget the ones it replaces).");
  }
  for (const kind of ["decision", "voice", "lesson", "fact"] as const) {
    const ms = memories.filter((m) => m.kind === kind);
    if (!ms.length) continue;
    // Newest first: a memory that a newer one says again is the one to forget.
    const again = (i: number): Memory | undefined => ms.slice(0, i).find((n) => overlap(n.text, ms[i]!.text) >= SAME_MEMORY);
    lines.push(
      `${KIND_TITLES[kind]}:`,
      ...ms.map((m, i) => {
        const newer = again(i);
        return `  - #${m.id} (${shortDay(m.createdAt)}${m.source === "system" ? ", noticed by the system" : ""}): ${m.text}${newer ? ` [newer #${newer.id} says much the same: forget this one, or merge]` : ""}`;
      }),
    );
  }
  return lines;
}

function planLines(plan: string | null): string[] {
  return plan?.trim()
    ? ["Your plan (write_plan rewrites it):", ...plan.trim().split("\n").map((l) => `  ${l}`)]
    : ["Your plan: none written yet. Write it with write_plan once you know where you are going."];
}

const speaker = (e: TranscriptEntry): string =>
  e.direction === "in" ? "They" : e.text.startsWith(CARD_MARK) ? "Card" : e.text.startsWith(QUESTION_MARK) ? "Question card" : "You";

function recentLines(entries: readonly TranscriptEntry[]): string[] {
  if (!entries.length) return [];
  return [
    "The chat's last messages (oldest first):",
    // What they wrote is whole: it is what the work follows. Live, 2026-11-01: cut at 300, a message with fourteen thread
    // links lost all but two by the next turn, and the brief that turn wrote filled them in from memory.
    ...entries.map((e) => `  [${when(e.at).replace(/ UTC$/, "")}] ${speaker(e)}: ${clip(e.text.replace(/\s+/g, " "), e.direction === "in" ? 2_000 : 300)}${e.reaction ? ` [you reacted ${e.reaction}]` : ""}`),
  ];
}

function dayLines(d: DayFacts): string[] {
  const saved = Object.entries(d.saved);
  const total = saved.reduce((n, [, k]) => n + k, 0);
  const tasks = d.tasks.map((t) => `${t.agent} "${clip(t.title, 60)}" (${t.status})`);
  return [
    "The day's record (the last 24 hours):",
    `  Work: ${tasks.length ? tasks.join("; ") : "nothing ran"}.`,
    `  Found: ${total ? `${total} (${saved.map(([s, k]) => `${sourceLabel(s, "")} ${k}`).join(", ")})` : "nobody"}. Shown as cards: ${d.shown}.`,
    `  What they did: kept ${d.kept}, skipped ${d.skipped}, replied to ${d.replied}, posted with Post it ${d.posted}.`,
    `  Posted replies: ${d.answers} answered, ${d.removed} taken down.`,
    `  Places filed: ${d.places.length ? d.places.map((p) => `${p.name} (${p.verdict})`).join(", ") : "none"}.`,
    `  The chat: they wrote ${d.messagesIn} message${d.messagesIn === 1 ? "" : "s"}; ${d.messagesOut} went to them (cards included).`,
  ];
}

/** "How's it going?", "any results?", "what have you achieved?": they want results, not a list of what was done. */
export const ASKS_PROGRESS =
  /\b(how'?s it going|how is it going|how are things|how'?s (?:the )?(?:work|progress)|any (?:news|results?|luck|progress|customers|users|sign-?ups|trials)|what (?:have|did) you (?:achieve|get done|done|accomplish)|what'?s the status|status update|where are we|progress so far)\b/i;

/**
 * Asked how it's going, the real model of 2026-10-07 led with cards shown and searches started, its
 * briefing's results and spent routes unread. The answer's frame, in the turn itself.
 */
function progressLine(b: TurnBriefing): string[] {
  const asked = b.events.some((e) => e.event.kind === "user_message" && ASKS_PROGRESS.test(e.event.text));
  if (!asked) return [];
  const spent = (b.routes ?? []).filter((r) => r.status === "spent");
  const results = summarizeResults(b.results ?? []).filter((s) => s.people.length || s.count);
  return [
    "They are asking how it's going. Answer like a friend who owns the work: lead with results, " +
      (results.length ? "the ones on record above" : "and there are none on record, so say so plainly") +
      `${spent.length ? `; then what did not work (${spent.map((r) => `"${r.name}"`).join(", ")}: spent) and what you are doing instead` : "; then what you are changing"}. ` +
      "Cards shown, places found and searches started are not news.",
  ];
}

/** For the evening report: the results that came in today, the news that leads it. */
function resultsToday(entries: readonly ResultEntry[], since: Date): string[] {
  const today = entries.filter((r) => r.at >= since);
  return [
    today.length
      ? `  Results today: ${today.map((r) => `${r.person ?? `${r.count} ${STAGE_WORDS[r.stage]}`} (${r.stage}): ${clip(r.evidence, 100)}`).join("; ")}.`
      : "  Results today: none on record. Say what the work came to plainly, and what you change because of it.",
  ];
}

/** The message the manager reads at the start of a turn: the time, the customer, what it keeps, what happened, the board. */
export function renderTurn(b: TurnBriefing): string {
  const c = b.customer;
  const { day: today } = theirClock(b.now, c.timezone);
  return [
    `Now: ${when(b.now)}. ${timeLine(c, b.now)}`,
    languageBriefing(c.language),
    `The customer: ${c.displayName ?? "(no name)"}. ` +
      `Their site: ${c.siteUrl ?? "not given yet"}. Stage: ${c.status}.`,
    c.brief
      ? `Their brief:\n${c.brief.split("\n").map((l) => `  ${l}`).join("\n")}`
      : "No brief written yet: write one with save_brief once you understand what they are after.",
    ...aboutThem(c),
    ...presenceLines(c, b.profiles ?? [], b.memories, b.now),
    ...(b.results ? [resultsLine(b.results, c.timezone)] : []),
    "",
    ...memoryLines(b.memories),
    "",
    ...planLines(c.plan),
    "",
    ...recentLines(b.recent),
    "",
    b.userTurn
      ? "This turn: the customer wrote to you. Your final message will be sent to them as your reply."
      : "This turn: nobody wrote. Your final message is private; to reach them, use message_user, show_finds or ask_user.",
    ...(b.userTurn && b.owed ? [owedLine(b.owed, b.now)] : []),
    "What happened since your last turn:",
    ...b.events.map((e) => eventLine(e, b)),
    ...progressLine(b),
    ...(b.day ? dayLines(b.day) : []),
    ...(b.day && b.results ? resultsToday(b.results, b.day.since) : []),
    "",
    ...(b.commitments ? owedLines(b.commitments, b.now, c.timezone) : []),
    `Your board: ${b.board.running} running, ${b.board.queued} queued, ${b.board.waiting} waiting on answers. ` +
      `Questions: ${b.questions.notAsked} not yet asked, ${b.questions.asked} waiting on the customer.`,
    ...(b.energy ? [energyLine(b.energy, b.now, c.timezone)] : []),
    ...(b.paces ? paceLines(b.paces, b.open ?? [], b.now) : []),
    ...findsLines(b.finds, b.now),
    ...draftLines(b.drafts ?? [], b.now),
    ...(b.mix ?? []),
    ...(b.steering ?? []),
    ...(b.approved === undefined ? [] : [postingLine(b.approved)]),
    ...(b.globalApproved === undefined ? [] : [`Across connected workspaces: ${postsAlone(b.globalApproved) ? "they said to go ahead everywhere: publish posts, replies, DMs and emails yourself" : `ask first: each kind of thing on each platform (replies, posts, messages) waits for their tap until ${TRUST_AFTER} of that kind there were approved`}. Specific platform choices override this default.`]),
    ...(b.routes ? routeLines(b.routes) : []),
    placesLine(b.places, b.now),
    ...(c.offAt ? [offLine(c.offAt, b.now)] : []),
    chromeLine(b.chrome, b.now),
    chatLine(b.chat, b.now, c.timezone),
  ].join("\n");
}
