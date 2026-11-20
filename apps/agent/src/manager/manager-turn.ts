import { MemorySaver } from "@langchain/langgraph";
import { customerLocale } from "@mq/i18n";
import { randomUUID } from "node:crypto";
import {
  hasUserMessage,
  type Clock,
  type CustomerId,
  type CustomerRepository,
  type DayLedger,
  type FollowUpSchedule,
  type Logger,
  type MemoryRepository,
  type PlaceRepository,
  type Question,
  type QueuedEvent,
  type Transcript,
  type TranscriptEntry,
  type SpendLog,
  type TrustRepository,
  OPEN_TASK_STATUSES,
  type ChromeStatus,
  type AgentPace,
  type Commitment,
  type ResultRepository,
  type RouteRepository,
  type Find,
} from "@mq/core";
import { isNod, isQuestion, onlyANod, opensWithANod, reactionRefusal } from "../conversation/reactions.ts";
import { overlap, SAME_MEMORY } from "../lib/overlap.ts";
import { askedFor, promisedTimes, theirHour, wall } from "../lib/their-time.ts";
import { isDue, NEXT_STEP_MOVES, type Commitments } from "./commitments.ts";
import { withLinks } from "./ownership-tools.ts";
import { buildAgent, finalText, type ThreadConfig } from "../agents/harness.ts";
import type { ModelProvider } from "../agents/models.ts";
import { noteModelCall } from "../agents/spend.ts";
import type { IntakeService } from "../conversation/intake.ts";
import { LET_IN_TOPIC, type WayIn } from "../conversation/way-in.ts";
import { CARD_MARK, QUESTION_MARK, type Messenger } from "../conversation/messenger.ts";
import type { DraftService } from "../drafts/draft-service.ts";
import { findPlatform, mixLines, productNames } from "../drafts/warm-up.ts";
import { ideaLines, type IdeaService } from "../ideas/idea-service.ts";
import type { FirstSweep } from "../finds/sweep.ts";
import type { FindService } from "../finds/find-service.ts";
import { stockPhrases, voiceNotes, type VoiceCheck } from "../lib/voice.ts";
import type { QuestionService } from "../questions/question-service.ts";
import type { SubagentCatalog } from "../tasks/subagents.ts";
import type { TaskService } from "../tasks/task-service.ts";
import { awake, followUpDue, SECOND_FOLLOW_UP_MS, waitingOn } from "./follow-up.ts";
import { heartbeatIdleReason, heartbeatWorth, QUIET_HEARTBEAT_BACKOFF_MS, type HeartbeatLook } from "./heartbeat-gate.ts";
import { managerPrompt } from "./prompt.ts";
import { managerTools, startedOnItsOwn, TALKING_MS, UNATTENDED_STARTS_A_DAY, type ChromeAccess } from "./tools.ts";
import type { CustomerBrowser } from "../chrome/browser.ts";
import { ASKS_PROGRESS, chatPulse, renderTurn, type ChatPulse } from "./turn-input.ts";
import type { FindBoard } from "../finds/find-service.ts";
import type { BoardCounts } from "../tasks/task-service.ts";
import type { ManagerActivity } from "../tasks/task-board.ts";
import { isRoutine } from "../tasks/rotation.ts";
import type { Energy } from "../billing/energy.ts";

/** A turn stopped because they switched Quest off: no failure, its events wait for them to switch it on. */
export class TurnStopped extends Error {
  constructor() {
    super("they switched Quest off during the turn");
    this.name = "TurnStopped";
  }
}

export interface ManagerTurnDeps {
  readonly browser?: CustomerBrowser;
  readonly customers: CustomerRepository;
  readonly tasks: TaskService;
  readonly questions: QuestionService;
  readonly finds: FindService;
  /** What Quest writes for the customer to post as themselves. */
  readonly drafts?: DraftService;
  /** Posts they approved per platform: whether Quest asks first. */
  readonly trust?: TrustRepository;
  /** Every model call's tokens and cost. */
  readonly spend?: SpendLog;
  readonly places: PlaceRepository;
  readonly memory: MemoryRepository;
  readonly day: DayLedger;
  readonly chrome: ChromeAccess;
  readonly messenger: Messenger;
  readonly transcript: Transcript;
  /** The first-day questions, which start after the turn that set the first work going. */
  readonly intake?: Pick<IntakeService, "afterTurn">;
  /** Wakes the manager when a question the customer has not answered is due a follow-up. */
  readonly followUps?: FollowUpSchedule;
  readonly catalog: SubagentCatalog;
  readonly models: ModelProvider;
  readonly clock: Clock;
  readonly log: Logger;
  /** After the evening report: what needs them and a sample of what went up, written by code (manager/day-sample.ts). */
  readonly afterReport?: (customerId: CustomerId) => Promise<void>;
  /** First pause before retrying a failed model call inside a turn (tests shorten it). */
  readonly modelRetryDelayMs?: number;
  /** The longest a turn may run before it is stopped and retried. */
  readonly turnLimitMs?: number;
  /** What Quest owes, with the wakes that hold it to its times. */
  readonly commitments?: Commitments;
  /** Quest at work in a turn, for the customer's page to show live (task-board.ts). */
  readonly activity?: ManagerActivity;
  /** What the work came to: conversations, trials, active users, paying customers. */
  readonly results?: ResultRepository;
  /** The ways Quest goes after results, and which are spent. */
  readonly routes?: RouteRepository;
  /** Their plan and the day's credits: tired near the end of them, resting once they are spent (billing/energy.ts). */
  readonly energy?: Pick<Energy, "view">;
  /** Their ideas for posts and Quest's, and the assets they share for them (ideas/idea-service.ts). */
  readonly ideas?: IdeaService;
  /** Their first sweep (finds/sweep.ts). */
  readonly sweep?: Pick<FirstSweep, "maybeStart" | "running">;
  /** Tasks it may start on its own in a day (always exploring counts the rotation's runs too); UNATTENDED_STARTS_A_DAY when not said. */
  readonly startsADay?: number;
  /** Always exploring (tasks/rotation.ts): code keeps a run going on their platforms, and the prompt says so. */
  readonly exploring?: boolean;
  /** The welcome for someone let in by hand (conversation/way-in.ts). */
  readonly wayIn?: Pick<WayIn, "welcome">;
}


/** Memories shown in a turn: all of them, in practice; the cap keeps a runaway list from filling the context. */
const MEMORIES_SHOWN = 120;
/** The drafts the briefing lists (the newest), and how far back it looks for their profile changes. */
const DRAFTS_SHOWN = 5;
const DRAFTS_READ = 120;
/** The chat's last messages a turn reads: its sense of the conversation, now that turns start fresh. */
const RECENT_SHOWN = 16;
/** The longest a turn may run. A normal one takes under two minutes, a busy one five. */
const TURN_LIMIT_MS = 10 * 60_000;

const SILENCE_CHECK =
  "Before you finish: the customer wrote to you within the hour, work just came back, and they have not heard from you in this turn. " +
  "Your final message is private, so a summary written there reaches no one. If the report answers what they asked for, or gives them " +
  "new cards to show or a problem only they can decide, tell them with message_user, show_finds or ask_user, in a line or two. " +
  "Anything else waits for the evening report: then reply only with the reason.";

/** How long after they came in a read of their site still gets its line. */
const FIRST_HOURS_MS = 2 * 3_600_000;

const FIRST_BRIEF =
  "Their site was just read for their brief, and they have not heard from you in this turn. Write to them now, as your final message, " +
  "in one or two short lines: one specific thing from their site that only someone who read it would notice (a few of its words in quotes), " +
  "and, when the site disagrees with itself or with what they told you, that as your one question. No praise of the product, nothing they " +
  "told you said back to them, nothing about tasks, searches or cards. It is sent exactly as you write it. Do not call any tools.";

const NO_REPLY = "You wrote nothing back, and the customer is waiting on an answer. Write your reply to them now, as your final message.";

/** What the manager answers when a day truly had nothing in it and the last report already said why. */
const NOTHING = "NOTHING";

const REPORT_NOW =
  "Their evening report is due, and they have not heard from you this turn. Your final message is private, so a report written there reaches no one. " +
  "Write the report now as your final message, following THE EVENING REPORT: it is sent to them exactly as you write it. Do not call any tools. " +
  `If nothing at all happened today and your last report already said why, reply with only ${NOTHING}.`;

const FOLLOW_UP_NOW =
  "They still owe you an answer, a follow-up is due, and you have not written to them this turn. Write the follow-up now as your final message, " +
  "following WHEN THEY GO QUIET: it is sent to them exactly as you write it. Do not call any tools. " +
  `If you no longer need the answer, reply with only ${NOTHING}.`;

const NEWS_NOW =
  "Something they posted was answered or taken down, and they have not heard from you this turn. Your final message is private, so news written there " +
  "reaches no one. Write it now as your final message, following ANSWERS: it is sent to them exactly as you write it. Do not call any tools.";

const nothing = (text: string): boolean => text.replace(/[^a-z]/gi, "").toUpperCase() === NOTHING;

/** What the manager answers when it already delivered a promise this turn and only forgot to settle it. */
const DONE = "DONE";
const done = (text: string): boolean => text.replace(/[^a-z]/gi, "").toUpperCase() === DONE;

const PROMISE_NOW = (c: Commitment): string =>
  `Your promise #${c.id} is due now and still open: ${c.what}.${c.words ? ` You told them "${c.words}".` : ""} ` +
  "If you already gave it to them in this turn, reply with only DONE. Otherwise write it now as your final message: what you promised, " +
  "or, if it truly is not ready, plainly why and the new time you will have it by (\"need another 20 min, the second site is slow\"). " +
  `It is sent to them exactly as you write it. Do not call any tools. If they no longer need it, reply with only ${NOTHING}.`;

const REACTED_ALREADY = (emoji: string): string =>
  `You reacted ${emoji} to their message: that already says you understood and are on it, and a reply that says it back in words says it twice. ` +
  "Write only what is new to them (a question, a time, a cost, a catch) as your final message, or reply with only " +
  `${NOTHING} when there is nothing new. Do not call any tools.`;

/** How far back a turn's estimates look at the team's runs. */
const PACE_WINDOW_MS = 14 * 24 * 3_600_000;
/** An answer is held for the time they asked for only when that time is at least this far off; nearer, it goes now. */
const HELD_AT_LEAST_MS = 30_000;
/** Whether a find waiting to be shown would go up by itself. */
async function goesAlone(trust: TrustRepository | undefined, customerId: CustomerId, finds: readonly Find[]): Promise<boolean> {
  if (!trust) return false;
  for (const platform of new Set(finds.map(findPlatform))) if (await trust.alone(customerId, platform)) return true;
  return false;
}

/** How long a turn trusts the paces it read: they move slowly. */
const PACE_TTL_MS = 15 * 60_000;

/**
 * Whether they have said what they work on: a message of theirs with a link or a few words, not a command or a greeting
 * ("hi"). The quest read from their first words used to say so; Quest serves founders only now (2026-10-29).
 */
export function toldWhatTheyDo(transcript: readonly { direction: string; text: string }[]): boolean {
  return transcript.some((e) => e.direction === "in" && !/^[/(]/.test(e.text) && (/\b[\w-]+\.[a-z]{2,}\b/i.test(e.text) || e.text.trim().split(/\s+/).length >= 3));
}

/** Tools that only look: a heartbeat turn that called nothing else, and told them nothing, moved nothing. */
const LOOKING = new Set(["check_task", "list_tasks", "list_questions", "read_file", "browser_open", "browser_act", "browser_close", "read_visual"]);


/** Whether a question card's question still waits on them: a tap on its buttons answers it with no word in the chat. */
const openCards =
  (open: readonly Question[]) =>
  (text: string): boolean =>
    open.some((q) => q.status === "asked" && q.text === text);

const restate = (notes: readonly string[]): string =>
  `Before this goes out: ${notes.join("; ")}. Write the same message again, fixing that, as your final message. Do not call any tools.`;

/** How far back a message looks for what the customer already read. */
const SAID_WINDOW_MS = 24 * 3_600_000;

/**
 * Runs one of the manager's turns for one customer: read what happened, act, and answer if spoken to.
 *
 * A turn starts fresh: its thread lives only for the turn. What carries over is in the database and
 * shown in the briefing: the brief, the plan, what Quest keeps for good, the chat's last messages,
 * and the board. So a turn costs the same on the hundredth day as on the first, and
 * nothing Quest learned lives only in a model's context.
 */
export class ManagerTurn {
  readonly #d: ManagerTurnDeps;
  /** Customers whose heartbeats rest after one that moved nothing, until when. Anything else that wakes the manager ends the rest. */
  readonly #resting = new Map<CustomerId, Date>();
  #paces: { readonly at: number; readonly value: AgentPace[] } | null = null;

  constructor(deps: ManagerTurnDeps) {
    this.#d = deps;
  }

  /** How long each teammate's runs take lately, read again every quarter hour. */
  async #pace(now: Date): Promise<AgentPace[]> {
    if (this.#paces && now.getTime() - this.#paces.at < PACE_TTL_MS) return this.#paces.value;
    const value = await this.#d.tasks.paces(new Date(now.getTime() - PACE_WINDOW_MS)).catch(() => []);
    this.#paces = { at: now.getTime(), value };
    return value;
  }

  /** `stop`: they switched Quest off mid-turn; the turn ends at once with TurnStopped and says nothing more. */
  async run(customerId: CustomerId, events: readonly QueuedEvent[], stop?: AbortSignal): Promise<void> {
    const d = this.#d;
    // Let in by hand (the trigger mq.let_in): welcomed by code, as an invite is, with no model call.
    const letIn = events.filter((e) => e.event.kind === "system" && e.event.topic === LET_IN_TOPIC);
    if (letIn.length && d.wayIn) {
      await d.wayIn.welcome(customerId);
      if (letIn.length === events.length) return;
    }
    const userTurn = hasUserMessage(events);
    // Woken only by routine runs code started that finished: what they did is on the record, on Your move and in the
    // evening report, so no model looks (live, 2026-11-19: 158 such wakes a day, about 20M tokens, a message in four).
    if (!userTurn && events.length && events.every((e) => e.event.kind === "task_finished")) {
      const titles = await Promise.all(events.map((e) => (e.event.kind === "task_finished" ? d.tasks.find(customerId, e.event.taskId).then((t) => t?.title ?? "", () => "") : "")));
      if (titles.every(isRoutine)) {
        d.log.info("manager.routine_skipped", { customerId, runs: titles.length });
        return;
      }
    }
    const now = d.clock.now();
    const reportDue = events.some((e) => e.event.kind === "day_report");
    const [customer, board, open, finds, places, chrome, transcript, memories, day, drafts, approved, globalApproved] = await Promise.all([
      d.customers.get(customerId),
      d.tasks.counts(customerId),
      d.questions.open(customerId),
      d.finds.board(customerId),
      d.places.listFor(customerId),
      d.chrome.status(customerId),
      d.transcript.recent(customerId, 100),
      d.memory.list(customerId, MEMORIES_SHOWN),
      reportDue ? d.day.day(customerId, new Date(now.getTime() - 24 * 3_600_000)) : Promise.resolve(null),
      d.drafts ? d.drafts.recent(customerId, DRAFTS_READ) : Promise.resolve([]),
      d.trust ? d.trust.approved(customerId, "reddit") : Promise.resolve(undefined),
      d.trust ? d.trust.approved(customerId, "*") : Promise.resolve(undefined),
    ]);
    const [ideas, assets] = await Promise.all([
      d.ideas ? d.ideas.ideas(customerId, 40) : Promise.resolve([]),
      d.ideas ? d.ideas.assets(customerId, 12) : Promise.resolve([]),
    ]);
    const [owedAll, settled, results, routes, paces, openTasks, energy] = await Promise.all([
      d.commitments ? d.commitments.open(customerId) : Promise.resolve(null),
      d.commitments ? d.commitments.settled(customerId, 5) : Promise.resolve([]),
      d.results ? d.results.list(customerId, 300) : Promise.resolve(null),
      d.routes ? d.routes.list(customerId) : Promise.resolve(null),
      this.#pace(now),
      d.tasks.list(customerId, OPEN_TASK_STATUSES),
      d.energy ? d.energy.view(customerId).catch(() => null) : Promise.resolve(null),
    ]);
    // Woken only for commitments already settled (delivered early, moved, dropped): nothing to do, and no model call.
    const dueIds = events.flatMap((e) => (e.event.kind === "commitment_due" ? [e.event.commitmentId] : []));
    const sent = await this.#sendHeld(customerId, dueIds, owedAll ?? []);
    const owed = owedAll ? owedAll.filter((c) => !sent.includes(c.id)) : null;
    if (dueIds.length && dueIds.length === events.length && !dueIds.some((id) => owed?.some((c) => c.id === id))) {
      d.log.info("manager.commitment_skipped", { customerId, ids: dueIds });
      return;
    }
    const chat = chatPulse(transcript, now, customer.timezone, openCards(open));
    const earlier = withoutThisTurn(transcript, events);
    // Their messages this turn that can take a reaction, with the words as they wrote them.
    const theirs = events.flatMap(({ event: ev }) => {
      if (ev.kind !== "user_message" || !ev.ref) return [];
      const ref = ev.ref;
      return [{ ref, text: transcript.find((t) => t.direction === "in" && t.ref === ref)?.text ?? ev.text }];
    });
    // What they owed an answer to before they wrote: their message may not answer it (live, 2026-10-01: a
    // new request after "Which conference is it?", and the conference was never asked about again).
    const owedAnswer = userTurn ? waitingOn(earlier, customer.timezone, openCards(open)) : null;
    // A question they owe an answer to is due a follow-up; a turn woken for it makes sure one goes out.
    const chaseDue = !userTurn && followUpDue(chat.waitingOn, now);
    const followUpTurn = events.some((e) => e.event.kind === "follow_up");
    if (followUpTurn && !chaseDue && events.every((e) => e.event.kind === "follow_up")) {
      // They answered, or another turn followed up first: nothing to do but set the next wake.
      d.log.info("manager.follow_up_skipped", { customerId, waiting: Boolean(chat.waitingOn) });
      await this.#chaseLater(customerId, customer.timezone, false);
      return;
    }
    // Only heartbeats, and nothing a look could move (work running, the day's starts spent, their Chrome
    // closed): decided here, without a model. Anything else that wakes the manager ends a rest.
    const heartbeatOnly = events.length > 0 && events.every((e) => e.event.kind === "heartbeat");
    if (heartbeatOnly) {
      const look = await this.#heartbeatLook(customerId, { board, finds, chrome, chat, timezone: customer.timezone, now });
      const why = heartbeatWorth(look);
      if (!why) {
        d.log.info("manager.heartbeat_skipped", { customerId, why: heartbeatIdleReason(look) });
        return;
      }
      d.log.info("manager.heartbeat_look", { customerId, why });
    } else {
      this.#resting.delete(customerId);
    }
    // They wrote within the hour: still in the conversation, and waiting on what they asked for.
    const talking = Boolean(chat.lastFromThem && now.getTime() - chat.lastFromThem.getTime() < TALKING_MS);
    // What became of a reply they posted always reaches them, like the report itself; so does a promise falling due.
    const postNews = events.some((e) => e.event.kind === "system" && (e.event.topic === "answers" || e.event.topic === "removed"));
    const promiseDue = dueIds.some((id) => owed?.some((c) => c.id === id && c.kind === "promise"));
    const news = reportDue || postNews || promiseDue;
    // They spoke this turn: in words, or by answering a question card. Only then does how Quest posts change.
    const theySpoke = userTurn || events.some((e) => e.event.kind === "question_answered");
    const briefing = renderTurn({
      now,
      customer,
      events,
      board,
      questions: {
        notAsked: open.filter((q) => q.status === "pending").length,
        asked: open.filter((q) => q.status === "asked").length,
      },
      finds,
      places,
      chrome,
      chat,
      userTurn,
      memories,
      recent: earlier.slice(-RECENT_SHOWN),
      owed: owedAnswer,
      drafts: drafts.slice(0, DRAFTS_SHOWN),
      mix: mixLines(drafts, productNames(customer.siteUrl), now),
      steering: ideaLines(ideas, assets),
      profiles: drafts.filter((x) => x.kind === "profile"),
      day,
      ...(approved === undefined ? {} : { approved }),
      ...(globalApproved === undefined ? {} : { globalApproved }),
      ...(owed ? { commitments: { open: owed, settled } } : {}),
      ...(results ? { results } : {}),
      ...(routes ? { routes } : {}),
      paces,
      open: openTasks,
      energy,
    });

    let told = 0;
    const afterReply: (() => Promise<void>)[] = [];
    // The reaction the turn put on their message, if it did (set from a tool, so held in an object).
    const reaction: { emoji: string | null } = { emoji: null };
    const shortlists: string[] = [];
    const used: string[] = [];
    const began = d.clock.now();
    const browserSession = `manager:${randomUUID()}`;
    const threadId = `manager:${customerId}:${events[0]?.id ?? "turn"}`;
    // The turn's calls stay with one provider, whose cache holds the standing prompt and the turn as it grows.
    const run = { session: threadId, customerId };
    const agent = buildAgent(
      {
        name: "manager",
        model: d.models.modelFor("manager", run),
        fallback: d.models.fallbackFor?.("manager", run) ?? null,
        summaryModel: d.models.summarizer?.(run) ?? null,
        systemPrompt: managerPrompt(d.catalog.describe(), { ...(d.startsADay ? { startsADay: d.startsADay } : {}), ...(d.exploring ? { exploring: true } : {}) }),
        images: () => { const screen = d.browser?.screen(customerId, browserSession); return screen ? [screen] : []; },
        tools: managerTools({
          customerId,
          browserSession,
          log: d.log,
          ...(d.browser ? { browser: d.browser } : {}),
          userTurn,
          pulse: chat,
          news,
          tasks: d.tasks,
          questions: d.questions,
          messenger: d.messenger,
          customers: d.customers,
          catalog: d.catalog,
          memory: d.memory,
          finds: d.finds,
          ...(d.drafts ? { drafts: d.drafts } : {}),
          ...(d.ideas ? { ideas: d.ideas } : {}),
          ...(d.sweep ? { sweep: d.sweep } : {}),
          ...(d.startsADay ? { startsADay: d.startsADay } : {}),
          briefing,
          ...(d.trust ? { trust: d.trust } : {}),
          places: d.places,
          chrome: d.chrome,
          now: () => d.clock.now(),
          onTold: () => void told++,
          later: (work) => void afterReply.push(work),
          reportDue,
          said: () => this.#said(customerId),
          theySpoke,
          ...(d.commitments ? { commitments: d.commitments } : {}),
          ...(d.results ? { results: d.results } : {}),
          ...(d.routes ? { routes: d.routes } : {}),
          paces,
          timezone: customer.timezone,
          theirs,
          before: earlier,
          onReacted: (emoji) => {
            reaction.emoji = emoji;
          },
          onShortlist: (list) => void shortlists.push(list),
        }),
        stepBudget: 25,
        scratch: false,
        onTool: (tool, args) => {
          used.push(tool);
          d.log.info("manager.tool", { customerId, tool });
          d.activity?.turnTool(customerId, tool, args);
        },
        onModel: (call) => noteModelCall(d.log, "manager.model", d.spend, { customerId, agent: "manager" }, call),
        onTrimmed: (dropped) => d.log.warn("manager.calls_trimmed", { customerId, dropped }),
        ...(d.modelRetryDelayMs !== undefined ? { retryDelayMs: d.modelRetryDelayMs } : {}),
      },
      // The turn's own thread, kept only while it runs: the follow-up steps below need it, nothing after.
      new MemorySaver(),
    );

    const typing = userTurn ? this.#keepTyping(customerId) : null;
    d.activity?.turnStarted(customerId);
    // A turn that runs on (a model stalling mid-answer) would hold the customer's queue while its
    // lease keeps renewing: it stops at the limit and fails, and the queue runs it again.
    const limit = AbortSignal.timeout(d.turnLimitMs ?? TURN_LIMIT_MS);
    const thread = { configurable: { thread_id: threadId }, signal: stop ? AbortSignal.any([limit, stop]) : limit };
    try {
      const result = await agent.invoke({ messages: [{ role: "user", content: briefing }] }, thread);
      if (stop?.aborted) throw new TurnStopped();
      if (userTurn) {
        // A reply that only says "got it" to a clear instruction is the acknowledgement a reaction makes better:
        // the 👍 goes on their message instead (a rehearsal with the real model, 2026-10-07, wrote "Got it, no
        // Reddit today" where other runs had only reacted). A reply with news in it ("On it, back in 2 min") stays.
        if (!reaction.emoji && onlyANod(finalText(result)) && finalText(result).trim()) reaction.emoji = await this.#nod(customerId, theirs, earlier);
        const progress = events.some((e) => e.event.kind === "user_message" && ASKS_PROGRESS.test(e.event.text));
        let reply = await this.#reply(customerId, agent, thread, finalText(result), reaction.emoji, { shortlists, progress });
        // Cut down when asked to say it shorter, a reply can come out as only a nod: then it is the 👍 it says.
        if (reply && !reaction.emoji && onlyANod(reply)) {
          reaction.emoji = await this.#nod(customerId, theirs, earlier);
          if (reaction.emoji) reply = null;
        }
        const asked = events.findLast((e) => e.event.kind === "user_message");
        const held = reply && asked?.event.kind === "user_message" ? await this.#holdForTheirTime(customerId, { text: asked.event.text, at: asked.createdAt }, reply, began, theirs, earlier, reaction, customer.timezone) : false;
        if (held) {
          told += held === "acknowledged" ? 1 : 0;
        } else if (reply) {
          await d.messenger.say(customerId, reply);
          told++;
        } else {
          d.log.info("manager.reaction_only", { customerId, reaction: reaction.emoji });
        }
      }
      // Work came back while they are in the conversation, and the turn said nothing to them: its final
      // words are private here, and a summary written as the last message reaches no one. One more
      // step to check, rather than leave them waiting on a promise. Out of the conversation, silence is
      // the work going on, and the evening report carries it.
      // Their first brief, or the first read of their site, always gets its line (live, 2026-10-31: the turn saved it
      // and said nothing, and the "5 min" it gave passed in silence; in another run the brief came from their words and
      // the site's read came back to nothing said).
      const siteRead =
        events.some((e) => e.event.kind === "task_finished" && e.event.agent === "researcher" && e.event.outcome === "succeeded") &&
        d.clock.now().getTime() - (customer.activatedAt ?? customer.createdAt).getTime() < FIRST_HOURS_MS;
      if ((siteRead || (!customer.brief && used.includes("save_brief"))) && told === 0) {
        const text = finalText(await agent.invoke({ messages: [{ role: "user", content: FIRST_BRIEF }] }, thread));
        if (text && !nothing(text)) {
          await d.messenger.say(customerId, await this.#plain(customerId, agent, thread, text, { earlier: await this.#said(customerId) }));
          told++;
        }
      }
      const silence =
        !userTurn && talking && told === 0 && events.some((e) => e.event.kind === "task_finished" && e.event.outcome === "succeeded");
      if (silence) {
        await agent.invoke({ messages: [{ role: "user", content: SILENCE_CHECK }] }, thread);
        d.log.info("manager.silence_check", { customerId, told });
      }
      // The evening report is owed once a day, and the queue won't ask for it again: a turn that
      // wrote it as its private last word (live, 2026-09-30) gets one more step, and the words are sent here.
      if (reportDue && (await this.#silent(customerId, began, told))) {
        const report = await this.#report(customerId, agent, thread);
        if (report) {
          await d.messenger.say(customerId, report);
          told++;
        }
      }
      if (reportDue) await d.afterReport?.(customerId).catch((e: unknown) => d.log.warn("manager.after_report_failed", { customerId, error: e instanceof Error ? e.message : String(e) }));
      // What became of something they posted reaches them, like the report (live, 2026-10-04: a post taken
      // down, and the turn only kept the lesson and rewrote its plan).
      if (postNews && (await this.#silent(customerId, began, told))) {
        const text = finalText(await agent.invoke({ messages: [{ role: "user", content: NEWS_NOW }] }, thread));
        if (text && !nothing(text)) {
          await d.messenger.say(customerId, await this.#plain(customerId, agent, thread, text, { earlier: await this.#said(customerId) }));
          told++;
          d.log.info("manager.news_asked", { customerId });
        }
      }
      // Woken to follow up, and the turn wrote nothing: one more step for the follow-up itself, sent here.
      if (followUpTurn && chaseDue && (await this.#silent(customerId, began, told))) {
        const text = await this.#followUp(customerId, agent, thread);
        if (text) {
          await d.messenger.say(customerId, text);
          told++;
        }
      }
      // What it owes and is due: delivered, or moved to a new time it told them, never left to pass in silence.
      told += await this.#keepPromises(customerId, agent, thread, dueIds, owed ?? [], used);
      // A time it gave in passing ("give me 5 min") is a promise like any other: kept on record and woken for.
      await this.#heardPromises(customerId, began, used, customer.timezone);
      // `told` counts every message the customer got this turn, the reply and any message_user.
      d.log.info("manager.turn", { customerId, events: events.length, userTurn, told, ...(reaction.emoji ? { reacted: reaction.emoji } : {}) });
      // A heartbeat look that told them nothing and only looked: the next ones rest a while, unless something else wakes the manager.
      if (heartbeatOnly) {
        if (told === 0 && used.every((t) => LOOKING.has(t))) {
          this.#resting.set(customerId, new Date(d.clock.now().getTime() + QUIET_HEARTBEAT_BACKOFF_MS));
          d.log.info("manager.heartbeat_rests", { customerId, hours: QUIET_HEARTBEAT_BACKOFF_MS / 3_600_000 });
        } else {
          this.#resting.delete(customerId);
        }
      }
      // What waited for the reply (the Chrome setup): sent now, under it.
      for (const work of afterReply) {
        await work().catch((e: unknown) => d.log.warn("manager.after_reply_failed", { customerId, error: e instanceof Error ? e.message : String(e) }));
      }
      // Whatever the model did, someone who has told Quest what they work on gets the setup once, under the reply.
      if (userTurn && told > 0 && toldWhatTheyDo(transcript)) {
        await d.chrome.offerFirst?.(customerId).catch((e: unknown) => d.log.warn("manager.after_reply_failed", { customerId, error: e instanceof Error ? e.message : String(e) }));
      }
      // After the reply, so the first card follows "I'm reading your site now". A card that did not
      // go out waits for the next turn: never worth failing (and so repeating) a turn that answered.
      await d.intake?.afterTurn(customerId, talking, userTurn).catch((e: unknown) => {
        d.log.warn("intake.failed", { customerId, error: e instanceof Error ? e.message : String(e) });
      });
      await this.#chaseLater(customerId, customer.timezone, followUpTurn && chaseDue);
    } catch (e) {
      if (stop?.aborted) throw new TurnStopped();
      if (limit.aborted) throw new Error(`the turn ran past ${Math.round((d.turnLimitMs ?? TURN_LIMIT_MS) / 60_000)} minutes and was stopped`);
      throw e;
    } finally {
      typing?.stop();
      d.activity?.turnEnded(customerId);
      await d.browser?.close(customerId, browserSession).catch(() => undefined);
    }
  }

  /**
   * The reply to what the customer wrote. A model now and then ends a turn with nothing to say,
   * or with a stock phrase: one more step each, on the same thread, so they get a real answer.
   * A turn that still has no reply fails, and the queue runs it again (after the last try, the
   * customer is told something went wrong): silence is the one answer they must never get.
   */
  async #reply(
    customerId: CustomerId,
    agent: ReturnType<typeof buildAgent>,
    thread: ThreadConfig,
    first: string,
    reacted: string | null,
    asked: { readonly shortlists: readonly string[]; readonly progress: boolean },
  ): Promise<string | null> {
    // A reaction can be the whole answer to a clear instruction ("No Reddit today please" 👍): a reply
    // that only says "got it" beside it says the same thing twice.
    if (reacted && (!first || nothing(first) || onlyANod(first))) return null;
    let reply = first;
    // Beside a 👍, a reply that says the instruction back is the nod twice: live on Telegram, 2026-10-08,
    // "No Reddit today please." got 👍 and "Reddit's off the list for today. I'll keep the finds warm…".
    // Asked once whether it has anything new; a question to them always does.
    if (reacted && (opensWithANod(first) || (isNod(reacted) && !isQuestion(first)))) {
      const again = finalText(await agent.invoke({ messages: [{ role: "user", content: REACTED_ALREADY(reacted) }] }, thread));
      this.#d.log.info("manager.reaction_restated", { customerId, reaction: reacted });
      if (!again || nothing(again) || onlyANod(again)) return null;
      reply = again;
    }
    if (!reply) {
      this.#d.log.warn("manager.no_reply", { customerId });
      reply = finalText(await agent.invoke({ messages: [{ role: "user", content: NO_REPLY }] }, thread));
      if (!reply) throw new Error("the manager wrote no reply");
    }
    // People from a shortlist get their links in code: asked once for them, the model wrote the names again bare.
    const { shortlists, progress } = asked;
    const linked = await withLinks(customerId, reply, shortlists, this.#d.finds);
    const check = { earlier: await this.#said(customerId), reply: true, shortlist: shortlists.length > 0, progress };
    return withLinks(customerId, await this.#plain(customerId, agent, thread, linked, check), shortlists, this.#d.finds);
  }

  /** A reaction (👍 unless said) on their last message this turn, unless the rules for reactions say no; the emoji, or null. */
  async #nod(customerId: CustomerId, theirs: readonly { ref: string; text: string }[], before: readonly TranscriptEntry[], emoji = "👍"): Promise<string | null> {
    const last = theirs.at(-1);
    if (!last) return null;
    const had = before.find((x) => x.direction === "in" && x.ref === last.ref);
    if (reactionRefusal(emoji, { text: last.text, reaction: had?.reaction ?? null }, before)) return null;
    if (!(await this.#d.messenger.react(customerId, last.ref, emoji))) return null;
    this.#d.log.info("manager.reaction_for_nod", { customerId, reaction: emoji });
    return emoji;
  }

  /**
   * The answer to "get back to me in 5 min with…", held for that time when the turn wrote it at once: a
   * promise for the time they asked for carries it, and goes out then without another model call (see
   * #sendHeld). They see a 👍 (or 👀 on a question) now; with no reaction allowed, a line with the time.
   * Live on Telegram, 2026-10-08, "Ping me in 3 min with the first line I should send them" was promised
   * for 3 min, then answered and settled ten seconds later; the founder's complaint of 2026-10-07 was the
   * same ("I'd asked you to return in two minutes"). Not held: a question back to them (they must answer
   * it now), an "on it" (the answer is still to come), or a reply that gives a time of its own ("back in
   * 2 min"), which is a promise already.
   * Returns "reacted" or "acknowledged" when held, false when the reply goes out now.
   */
  async #holdForTheirTime(
    customerId: CustomerId,
    message: { readonly text: string; readonly at: Date },
    reply: string,
    began: Date,
    theirs: readonly { ref: string; text: string }[],
    before: readonly TranscriptEntry[],
    reaction: { emoji: string | null },
    timezone: string | null,
  ): Promise<"reacted" | "acknowledged" | false> {
    const d = this.#d;
    if (!d.commitments) return false;
    const now = d.clock.now();
    // Counted from when they wrote: "in 3 min" means three minutes from their message, however long the turn took.
    const asked = askedFor(message.text, message.at, timezone);
    if (!asked || asked.due.getTime() - now.getTime() < HELD_AT_LEAST_MS || isQuestion(reply) || onlyANod(reply) || promisedTimes(reply, now, timezone).length) return false;
    const promise = await d.commitments.add(customerId, {
      kind: "promise",
      what: message.text.trim().slice(0, 300),
      words: asked.words,
      person: null,
      url: null,
      taskId: null,
      dueAt: asked.due,
      onTime: true,
      source: "asked",
      held: reply,
    });
    // A promise of the turn's own for the same thing would wake for it again: this one carries the answer.
    for (const c of await d.commitments.open(customerId)) {
      if (c.id !== promise.id && c.kind === "promise" && c.createdAt.getTime() >= began.getTime()) {
        await d.commitments.settle(customerId, c.id, "kept", `its answer goes out at the time they asked for, with #${promise.id}`);
      }
    }
    d.log.info("manager.held", { customerId, id: promise.id, dueAt: asked.due.toISOString() });
    if (reaction.emoji) return "reacted";
    reaction.emoji = (await this.#nod(customerId, theirs, before)) ?? (await this.#nod(customerId, theirs, before, "👀"));
    if (reaction.emoji) return "reacted";
    await d.messenger.say(customerId, `Will do, back at ${theirHour(asked.due, now, timezone, customerLocale((await d.customers.get(customerId)).language))}.`);
    return "acknowledged";
  }

  /**
   * The held answers due now, sent as they were written and settled as kept, with no model call; the ids
   * sent. A held answer whose promise was settled sooner (they wrote again, and got the answer) is gone
   * with it.
   */
  async #sendHeld(customerId: CustomerId, dueIds: readonly string[], owed: readonly Commitment[]): Promise<string[]> {
    const d = this.#d;
    if (!d.commitments) return [];
    const now = d.clock.now();
    const sent: string[] = [];
    for (const id of new Set(dueIds)) {
      const c = owed.find((x) => x.id === id);
      if (!c?.held || !isDue(c, now)) continue;
      await d.messenger.say(customerId, c.held);
      await d.commitments.settle(customerId, c.id, "kept", "sent at the time they asked for");
      d.log.info("manager.held_sent", { customerId, id: c.id });
      sent.push(c.id);
    }
    return sent;
  }

  /**
   * The evening report from a turn that didn't send one: asked for once more, and sent by the turn.
   * Null only when the manager says the day was empty and the last report already said why.
   * No words at all fail the turn, and the queue runs it again.
   */
  async #report(customerId: CustomerId, agent: ReturnType<typeof buildAgent>, thread: ThreadConfig): Promise<string | null> {
    const report = finalText(await agent.invoke({ messages: [{ role: "user", content: REPORT_NOW }] }, thread));
    if (!report) throw new Error("the manager wrote no evening report");
    if (nothing(report)) {
      this.#d.log.info("manager.no_report", { customerId, reason: "nothing happened" });
      return null;
    }
    this.#d.log.info("manager.report_asked", { customerId });
    return this.#plain(customerId, agent, thread, report, { earlier: await this.#said(customerId), report: true });
  }

  /** The follow-up from a turn woken for one that didn't write it; null when the manager no longer needs the answer. */
  async #followUp(customerId: CustomerId, agent: ReturnType<typeof buildAgent>, thread: ThreadConfig): Promise<string | null> {
    const text = finalText(await agent.invoke({ messages: [{ role: "user", content: FOLLOW_UP_NOW }] }, thread));
    if (!text || nothing(text)) {
      this.#d.log.info("manager.no_follow_up", { customerId, wrote: Boolean(text) });
      return null;
    }
    this.#d.log.info("manager.follow_up_asked", { customerId });
    return this.#plain(customerId, agent, thread, text, { earlier: await this.#said(customerId) });
  }

  /**
   * What the turn was woken to keep, once it has run. A promise due and still open gets one more step to
   * deliver it or say it needs longer, sent here: their time never passes in silence. One woken for early
   * (to warn them in time) that is on track is woken for again at its time. A next step nobody did waits a
   * day, NEXT_STEP_MOVES times, then is dropped. Returns how many messages went out.
   */
  async #keepPromises(
    customerId: CustomerId,
    agent: ReturnType<typeof buildAgent>,
    thread: ThreadConfig,
    dueIds: readonly string[],
    before: readonly Commitment[],
    used: readonly string[],
  ): Promise<number> {
    const d = this.#d;
    if (!d.commitments || !dueIds.length) return 0;
    let sent = 0;
    for (const id of new Set(dueIds)) {
      const c = await d.commitments.get(customerId, id);
      if (!c || c.status !== "open") continue;
      const now = d.clock.now();
      const moved = c.moves !== before.find((b) => b.id === c.id)?.moves;
      if (!isDue(c, now)) {
        if (!moved) await d.commitments.lookAgainAtDue(customerId, c.id);
        continue;
      }
      if (c.kind === "next_step") {
        if (c.moves >= NEXT_STEP_MOVES) await d.commitments.settle(customerId, c.id, "dropped", `not done when due, ${c.moves + 1} times`);
        else await d.commitments.move(customerId, c.id, new Date(now.getTime() + 24 * 3_600_000), null, "not done when it fell due");
        continue;
      }
      if (moved && used.includes("settle")) continue;
      const text = finalText(await agent.invoke({ messages: [{ role: "user", content: PROMISE_NOW(c) }] }, thread));
      if (!text || done(text)) {
        await d.commitments.settle(customerId, c.id, "kept", "delivered in the turn it fell due");
        continue;
      }
      if (nothing(text)) {
        await d.commitments.settle(customerId, c.id, "dropped", "no longer needed when it fell due");
        continue;
      }
      const words = await this.#plain(customerId, agent, thread, text, { earlier: await this.#said(customerId) });
      await d.messenger.say(customerId, words);
      sent++;
      // Delivered, or a new time given: whichever the words say.
      const later = promisedTimes(words, d.clock.now(), (await d.customers.get(customerId)).timezone)[0];
      if (later) await d.commitments.move(customerId, c.id, later.due, later.words, "needed longer; told them when it fell due");
      else await d.commitments.settle(customerId, c.id, "kept", "delivered when it fell due");
      d.log.info("manager.promise_kept", { customerId, id: c.id, moved: Boolean(later) });
    }
    return sent;
  }

  /**
   * Times Quest gave them in this turn's own words ("give me 5 min", "I'll get back to you within the hour")
   * that no tool put on record: kept as promises, so they are woken for like any other. A new time for a
   * promise already woken for moves that one instead.
   */
  async #heardPromises(customerId: CustomerId, since: Date, used: readonly string[], timezone: string | null): Promise<void> {
    const d = this.#d;
    if (!d.commitments || used.includes("promise") || used.includes("settle")) return;
    const said = (await d.transcript.recent(customerId, 20)).filter(
      (e) => e.direction === "out" && e.at.getTime() >= since.getTime() && !e.text.startsWith(CARD_MARK) && !e.text.startsWith(QUESTION_MARK),
    );
    const now = d.clock.now();
    // The work behind a time given in passing: the one task this turn started, when it started one.
    const started = (await d.tasks.list(customerId)).filter((t) => t.createdAt.getTime() >= since.getTime());
    const taskId = started.length === 1 ? started[0]!.id : null;
    for (const e of said) {
      for (const p of promisedTimes(e.text, now, timezone)) {
        const open = await d.commitments.open(customerId);
        // Kept already: the same sentence, the time a due promise was just moved to, or the same work said again in
        // other words ("give me 10 min" and "the search is running, about 10 min", the real model, 2026-10-07).
        if (open.some((c) => c.what === p.sentence || (c.words === p.words && Math.abs(c.dueAt.getTime() - p.due.getTime()) < 120_000))) continue;
        const same = open.find((c) => c.kind === "promise" && (overlap(c.what, p.sentence) >= SAME_MEMORY || (taskId !== null && c.taskId === taskId)));
        if (same) {
          if (p.due.getTime() > same.dueAt.getTime() + 120_000) await d.commitments.move(customerId, same.id, p.due, p.words, "a later time given in the chat");
          continue;
        }
        const woken = open.find((c) => c.kind === "promise" && c.checkAt.getTime() <= now.getTime());
        if (woken) await d.commitments.move(customerId, woken.id, p.due, p.words, "a new time given in the chat");
        else await d.commitments.add(customerId, { kind: "promise", what: p.sentence, words: p.words, person: null, url: null, taskId, dueAt: p.due, onTime: false, source: "said" });
      }
    }
  }

  /**
   * Sets when the manager is woken next to follow up the question they owe an answer to, from the chat as
   * this turn left it; clears it when there is none. Still due after a turn that tried (it no longer needed
   * the answer, or wrote nothing): another try later, not at once, or the queue would run it straight back.
   * Still due after any other turn: at once, so a turn woken for it makes sure it goes out.
   */
  async #chaseLater(customerId: CustomerId, timezone: string | null, tried: boolean): Promise<void> {
    const d = this.#d;
    if (!d.followUps) return;
    const [transcript, open] = await Promise.all([d.transcript.recent(customerId, 100), d.questions.open(customerId)]);
    const now = d.clock.now().getTime();
    const next = waitingOn(transcript, timezone, openCards(open))?.nextAt?.getTime() ?? null;
    const at = next === null ? null : next > now ? next : tried ? now + SECOND_FOLLOW_UP_MS : now;
    await d.followUps.followUpAt(customerId, at === null ? null : new Date(at));
    if (at !== null) d.log.info("manager.follow_up_set", { customerId, at: new Date(at).toISOString() });
  }

  /** Words for the customer, asked for once more when they read like a bot's or a form's, or say again what was said. */
  async #plain(customerId: CustomerId, agent: ReturnType<typeof buildAgent>, thread: ThreadConfig, text: string, check: VoiceCheck): Promise<string> {
    check = { ...check, language: customerLocale((await this.#d.customers.get(customerId)).language) };
    const stock = stockPhrases(text);
    const notes = [...(stock.length ? [`it says "${stock.join('", "')}", which is how a bot writes, not a colleague`] : []), ...voiceNotes(text, check)];
    if (!notes.length) return text;
    this.#d.log.info("manager.restated", { customerId, stock, notes: notes.map((n) => n.slice(0, 120)) });
    const again = finalText(await agent.invoke({ messages: [{ role: "user", content: restate(notes) }] }, thread));
    return again || text;
  }

  /**
   * Whether the customer has heard nothing from this turn: by the count, and by the chat itself. Live, 2026-10-04,
   * the evening report went out twice: sent with message_user, then again by the step for a report not sent.
   */
  async #silent(customerId: CustomerId, since: Date, told: number): Promise<boolean> {
    const out = (await this.#d.transcript.recent(customerId, 20)).filter((e) => e.direction === "out" && e.at.getTime() >= since.getTime()).length;
    if (out && !told) this.#d.log.warn("manager.told_mismatch", { customerId, out, told });
    return !told && !out;
  }

  /**
   * What the customer heard from Quest in the last day, newest last. All of it: a count would let
   * a burst of setup messages push the report of an hour ago out of sight (live, 2026-09-30).
   */
  async #said(customerId: CustomerId): Promise<string[]> {
    const since = this.#d.clock.now().getTime() - SAID_WINDOW_MS;
    const recent = await this.#d.transcript.recent(customerId, 60);
    return recent
      .filter((e) => e.direction === "out" && e.at.getTime() >= since && !e.text.startsWith(CARD_MARK) && !e.text.startsWith(QUESTION_MARK))
      .map((e) => e.text);
  }

  /** What the heartbeat gate weighs, from what the turn already loaded, plus the day's starts. */
  async #heartbeatLook(
    customerId: CustomerId,
    x: {
      board: BoardCounts;
      finds: FindBoard;
      chrome: ChromeStatus;
      chat: ChatPulse;
      timezone: string | null;
      now: Date;
    },
  ): Promise<HeartbeatLook> {
    const d = this.#d;
    const started = startedOnItsOwn(await d.tasks.list(customerId), x.now, x.chat.lastFromThem);
    const withoutChrome = d.catalog.names().some((name) => d.catalog.get(name)?.needsChrome !== true);
    return {
      active: x.board.queued + x.board.running,
      startsLeft: (d.startsADay ?? UNATTENDED_STARTS_A_DAY) - started,
      canStart: x.chrome.online || withoutChrome,
      findsWaiting: x.finds.waiting.length,
      cardsOpen: x.finds.counts.shown,
      // What they trusted Quest with goes up day and night (the founder, 2026-11-05: "I'd like the bot to work at nights as
      // well doing the actions I approved"): the replies of finds on a platform where it goes alone need no one awake.
      daytime: awake(x.now, x.timezone).getTime() === x.now.getTime() || (await goesAlone(d.trust, customerId, x.finds.waiting)),
      restingUntil: this.#resting.get(customerId) ?? null,
      now: x.now,
    };
  }

  /** Telegram's "typing…" fades after five seconds; keep it up while the turn thinks. */
  #keepTyping(customerId: CustomerId): { stop(): void } {
    void this.#d.messenger.showTyping(customerId);
    const timer = setInterval(() => void this.#d.messenger.showTyping(customerId), 4_500);
    return { stop: () => clearInterval(timer) };
  }
}

/** Nothing from Quest yet today by their clock: its first message of the day says hello. Entries oldest first. */
export function firstOfTheirDay(entries: readonly TranscriptEntry[], now: Date, timezone: string | null): boolean {
  const last = entries.findLast((e) => e.direction === "out");
  const day = (t: Date): number => Math.floor(wall(t, timezone) / 86_400_000);
  return !last || day(last.at) !== day(now);
}

/** The transcript without the customer's messages this turn's events already carry, so none is read twice. */
function withoutThisTurn(entries: readonly TranscriptEntry[], events: readonly QueuedEvent[]): TranscriptEntry[] {
  const pending = events.flatMap((e) => (e.event.kind === "user_message" ? [e.event.text] : []));
  const out = [...entries];
  for (const text of pending) {
    for (let i = out.length - 1; i >= 0; i--) {
      // A reply to a card reaches the manager with a note on the card after their words.
      if (out[i]!.direction === "in" && (out[i]!.text === text || text.startsWith(`${out[i]!.text}\n`))) {
        out.splice(i, 1);
        break;
      }
    }
  }
  return out;
}
