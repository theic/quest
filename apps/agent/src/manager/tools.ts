import { customerLocale, LANGUAGES, LOCALES, supportedLocale } from "@mq/i18n";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
 
  MEMORY_KINDS,
  questionId,
  type AgentPace,
  type ChromeStatus,
  type ResultRepository,
  type RouteRepository,
  type TranscriptEntry,
  type CustomerId,
  type CustomerRepository,
  type MemoryRepository,
  type PlaceRepository,
  placeKey,
  draftId,
  findId,
  type Question,
  type Task,
  DRAFT_KINDS,
  TRUST_AFTER,
  trustKey,
  type TrustRepository,
} from "@mq/core";
import { stockPhrases, voiceNotes } from "../lib/voice.ts";
import type { OfferOutcome } from "../chrome/link-service.ts";
import { tool } from "langchain";
import { z } from "zod";
import { siteOf, SOURCE_SITES } from "../tasks/site-pin.ts";
import type { Messenger } from "../conversation/messenger.ts";
import { doneWords, type DraftRequest, type DraftService } from "../drafts/draft-service.ts";
import type { FindService } from "../finds/find-service.ts";
import { clip } from "../lib/sleeper.ts";
import type { QuestionService } from "../questions/question-service.ts";
import type { SubagentCatalog } from "../tasks/subagents.ts";
import { UnknownAgentError, type TaskService } from "../tasks/task-service.ts";
import { overlap, REPLACES_OVERLAP, SAME_MEMORY } from "../lib/overlap.ts";
import { span, theirHour, whenFrom } from "../lib/their-time.ts";
import { asks, followUpDue } from "./follow-up.ts";
import type { ChatPulse } from "./turn-input.ts";
import { browserTools, type CustomerBrowser } from "../chrome/browser.ts";
import { platformFor, WORDLESS, type BrowserView, type Logger } from "@mq/core";
import type { Commitments } from "./commitments.ts";
import { BEST_PEOPLE, ownershipTools, withLinks } from "./ownership-tools.ts";
import { ownWordsRefusal } from "../drafts/own-words.ts";
import { mayGoAlone } from "../drafts/autopilot.ts";
import { PLATFORMS as SITES, platformOf } from "../platforms.ts";
import type { IdeaService } from "../ideas/idea-service.ts";
import type { FirstSweep } from "../finds/sweep.ts";

/** A quote's words: case, curly quotes, punctuation and spacing aside. */
const quoteWords = (s: string): string =>
  s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}']+/gu, " ").trim();

/**
 * Whether a quote is in what Quest read: each part of it (a quote may skip words with "…") appears in
 * the texts, word for word. A draft quotes a person, so the words must be theirs, not a model's memory.
 */
export function wasRead(quote: string, read: readonly string[]): boolean {
  const pool = quoteWords(read.join("\n"));
  const parts = quote.split(/…|\.\.\./).map(quoteWords).filter((p) => p.length >= 3);
  return parts.length > 0 && parts.every((p) => pool.includes(p));
}

/** Whether a Reddit thread was in what Quest read: its post id appears there. Not a thread on Reddit: left to the draft's own checks. */
export function threadRead(url: string, read: readonly string[]): boolean {
  const id = /\/comments\/([a-z0-9]+)/i.exec(url)?.[1]?.toLowerCase();
  return !id || read.some((t) => t.toLowerCase().includes(`/comments/${id}`));
}

/** The customer's Chrome, as far as the manager goes: how it stands, and sending the setup. */
export interface ChromeAccess {
  status(customerId: CustomerId): Promise<ChromeStatus>;
  offer(customerId: CustomerId, opts?: { force?: boolean }): Promise<OfferOutcome>;
  /** The setup if it never went out to them; nothing after that, and nothing to a Chrome that is connected. */
  offerFirst?(customerId: CustomerId): Promise<OfferOutcome>;
  /** A task was held back for it: say so when it comes back online. */
  awaitOnline(customerId: CustomerId): void;
}

/** The teammates who read sites for people: they wait for the first sweep, which reads those sites first. */
const SWEEP_FIRST: ReadonlySet<string> = new Set(["scout", "explorer", "outreach"]);

export interface ManagerToolDeps {
  readonly browser?: CustomerBrowser;
  readonly browserSession?: string;
  readonly customerId: CustomerId;
  readonly userTurn: boolean;
  /** How the chat stands: whether Quest may write first, and since when it has worked unasked. */
  readonly pulse?: ChatPulse;
  /** The turn carries news that always goes out: the evening report, or what became of a reply they posted. */
  readonly news?: boolean;
  readonly tasks: TaskService;
  readonly questions: QuestionService;
  readonly messenger: Messenger;
  readonly customers: CustomerRepository;
  readonly catalog: SubagentCatalog;
  readonly memory: MemoryRepository;
  readonly finds: Pick<FindService, "show" | "dropWaitingFrom" | "revise" | "dropAbout" | "verifySent" | "best" | "byAuthors">;
  readonly places: PlaceRepository;
  readonly chrome: ChromeAccess;
  readonly now: () => Date;
  /** Called each time a tool sends the customer a message. */
  readonly onTold?: () => void;
  /** Work for after the turn's reply has gone out: the Chrome setup goes under the words that say why it is needed. */
  readonly later?: (work: () => Promise<void>) => void;
  /** The evening report is due in this turn: a message then has a length to keep to. */
  readonly reportDue?: boolean;
  /** What the customer heard from Quest in the last day, newest last: a message shouldn't say it again. */
  readonly said?: () => Promise<readonly string[]>;
  /** Drafts the customer posts as themselves, each on a card with a Post button. */
  readonly drafts?: Pick<DraftService, "offer" | "revise" | "verifySent" | "publish">;
  /** What the turn showed the manager: a draft quotes only words in it, or in a report read this turn. */
  readonly briefing?: string;
  /** Posts they approved per platform: "ask me first" sets it back. */
  readonly trust?: TrustRepository;
  /**
   * The customer spoke in this turn (wrote, or answered a question card): only then does how Quest posts change.
   * Live, 2026-10-07: told to keep "exactly the posting permissions that existed before", a turn reset them anyway.
   */
  readonly theySpoke?: boolean;
  /** What Quest owes, with times; what the work came to; the ways it goes after results. */
  readonly commitments?: Commitments;
  readonly results?: ResultRepository;
  readonly routes?: RouteRepository;
  readonly paces?: readonly AgentPace[];
  readonly timezone?: string | null;
  /** Their messages this turn that can take a reaction, and the chat before it. */
  readonly theirs?: readonly { readonly ref: string; readonly text: string }[];
  readonly before?: readonly TranscriptEntry[];
  readonly onReacted?: (emoji: string) => void;
  /** Each shortlist best_people gave this turn, for the reply that names those people. */
  readonly onShortlist?: (shortlist: string) => void;
  /** For what a tool refused: the reason, never the words. */
  readonly log?: Logger;
  /** Their ideas for posts and Quest's, and the assets they share for them (ideas/idea-service.ts). */
  readonly ideas?: Pick<IdeaService, "theirs" | "decide" | "keepLink" | "dropAsset" | "attachable">;
  /** Their first sweep (finds/sweep.ts): a brief starts it, and the teammates who read for people wait for it. */
  readonly sweep?: Pick<FirstSweep, "maybeStart" | "running">;
  /** Tasks it may start on its own in a day; UNATTENDED_STARTS_A_DAY when not said. */
  readonly startsADay?: number;
}

/**
 * Tasks the manager may start on its own in a day, counted from when the customer last wrote.
 * The work goes on without them, at a pace their Chrome's daily reading can carry: thirty
 * searches in one morning spent it before noon (live, 2026-10-01).
 */
export const UNATTENDED_STARTS_A_DAY = 8;

/** Tasks started in the last day since the customer last wrote: what counts against UNATTENDED_STARTS_A_DAY. */
export function startedOnItsOwn(tasks: readonly { readonly createdAt: Date }[], now: Date, lastFromThem: Date | null): number {
  const since = Math.max(now.getTime() - DAY_MS, lastFromThem?.getTime() ?? 0);
  return tasks.filter((t) => t.createdAt.getTime() > since).length;
}

/**
 * When Quest may write first, the way a good hire writes to a busy manager. While they are in the
 * conversation (they wrote within TALKING_MS), it follows up, but not a third time without a word
 * back. Otherwise it writes first at most FIRST_WORDS_A_DAY times a day, FIRST_WORD_GAP_MS apart,
 * and the rest waits for the evening report. Live, 2026-10-01: thirty updates in one morning, none
 * answered, and the customer's word: "I hired the agent to do the work, not micro manage it."
 */
export const UNANSWERED_NUDGES = 2;
export const FIRST_WORDS_A_DAY = 2;
export const FIRST_WORD_GAP_MS = 3 * 3_600_000;
export const TALKING_MS = 60 * 60_000;

const DAY_MS = 24 * 3_600_000;

const age = (d: Date, now: Date): string => {
  const min = Math.round((now.getTime() - d.getTime()) / 60_000);
  if (min < 1) return "just now";
  return min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
};

/**
 * Why a message Quest would send first has to wait, or null when it may go. A follow-up on a question
 * they owe an answer to goes out when it falls due (follow-up.ts keeps its pace), once a turn.
 */
export function holdBack(p: ChatPulse, sentThisTurn: number, now: Date): string | null {
  if (!sentThisTurn && followUpDue(p.waitingOn, now)) return null;
  const unanswered = p.unanswered + sentThisTurn;
  if (p.lastFromThem && now.getTime() - p.lastFromThem.getTime() < TALKING_MS) {
    return unanswered >= UNANSWERED_NUDGES ? `they have not answered your last ${unanswered} messages` : null;
  }
  if (sentThisTurn) return "you already wrote to them in this turn";
  if (p.unansweredToday >= FIRST_WORDS_A_DAY) return `you already wrote to them ${p.unansweredToday} times today without a word back`;
  if (p.lastToThem && now.getTime() - p.lastToThem.getTime() < FIRST_WORD_GAP_MS) return `you wrote to them ${age(p.lastToThem, now)}`;
  return null;
}

const taskLine = (t: Task, now: Date): string =>
  `- ${t.id} ${t.agent} "${t.title}": ${t.status}, started ${age(t.createdAt, now)}` +
  (t.status === "failed" && t.error ? ` (${clip(t.error, 120)})` : "");

const questionLine = (q: Question, now: Date): string =>
  `- ${q.id} from the ${q.agent} (task ${q.taskId}), ${q.status === "asked" ? "sent to the customer, waiting" : "not asked yet"}, ${age(q.createdAt, now)}: "${q.text}"` +
  (q.options.length ? ` Options: ${q.options.join(" | ")}.` : "") +
  (q.why ? ` Why: ${q.why}` : "");

/** Memories a turn may retire one by one with forget; more go through remember with replaces, as a merge. */
export const FORGETS_A_TURN = 4;

/** Screenshots a turn may send to their chat with show_screenshot. */
export const PICTURES_A_TURN = 2;

/** Refused drafts a turn may ask for before the tool stops drafting for the rest of it. */
export const DRAFT_REFUSALS = 3;

const draftSchema = z.object({
  kind: z.enum(["reply", "post", "message", "like", "follow", "profile"]),
  // Required, even for a like or a follow (""): DeepSeek V4.1 Flash, reasoning off, left an optional text out of every post it drafted (live, 2026-10-16).
  text: z.string().max(10_000).describe("The words that go up, in their voice, the way they would write it: a post's whole body (its title goes in title), a reply, a message, a profile field's new words. like and follow: an empty string."),
  url: z
    .string()
    .optional()
    .describe(
      "The exact workspace/thread URL on any platform. reply: the post or comment's own address, never a list it showed in (notifications, a search, a feed). For a messenger/email, this opens its destination workspace. " +
        "like: the post's own address. follow: the person's profile. profile: their own profile's edit page, or their profile with its Edit button.",
    ),
  quote: z.string().max(400).optional().describe("reply: the words it answers, short, exactly as you read them. like: the liked post's words, the same. message: optional, the same."),
  author: z.string().optional().describe("reply or like: whose words they are, as their site writes it: u/name on Reddit, @handle on X, their name elsewhere."),
  community: z.string().optional().describe("post: the community, as r/name."),
  to: z.string().optional().describe("message: exact person/chat name or full email address. Reddit can use u/name. Never put the workspace host here."),
  title: z.string().max(300).optional().describe("post: its title. message: its subject."),
  rules_read: z.union([z.boolean(), z.enum(["true", "false"])]).optional().describe("post: true only after this tool showed you the community's rules and they allow this post."),
  target: z
    .string()
    .optional()
    .describe("Other platforms: exact community/thread/recipient in the destination workspace. For email, the full recipient address. follow: their @handle or name. profile: the field (bio, headline, name, location, website)."),
  limit: z.number().int().min(1).max(100_000).optional().describe("Other platforms: the limit its field shows, when it has one (a profile bio's 160). The words are kept within it."),
  assets: z.array(z.string().uuid()).max(4).optional().describe("post or reply: their pictures or videos to put up with it, by the asset ids on your board."),
});
type DraftArgs = z.infer<typeof draftSchema>;

/** Normalises what a customer types ("acme.com", "www.acme.com/") into an address. */
export function normaliseSite(input: string): string | null {
  const raw = input.trim().replace(/[)\].,;]+$/, "");
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes(".")) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** The manager's tools for one turn, bound to the customer it is serving. */
export function managerTools(d: ManagerToolDeps): StructuredToolInterface[] {
  const { customerId } = d;

  const unattendedRefusal = async (): Promise<string | null> => {
    const started = startedOnItsOwn(await d.tasks.list(customerId), d.now(), d.pulse?.lastFromThem ?? null);
    if (started < (d.startsADay ?? UNATTENDED_STARTS_A_DAY)) return null;
    return (
      `Not started: you have started ${started} tasks on your own in the last day, and their Chrome reads only so many pages a day. ` +
      "Leave the rest for tomorrow and make the next ones count; what came of today goes in the evening report."
    );
  };

  /** Reading and searching happen in the customer's Chrome: a task that needs it does not start without it. */
  const chromeRefusal = async (agent: string): Promise<string | null> => {
    if (!d.catalog.get(agent)?.needsChrome) return null;
    const chrome = await d.chrome.status(customerId);
    if (chrome.online) return null;
    if (!chrome.linked) {
      return (
        "Not started: your team reads and searches the web in the customer's own Chrome, and they have not connected it yet. " +
        (chrome.offeredAt
          ? `You sent them the setup ${age(chrome.offeredAt, d.now())}: do not send it again. `
          : "Send them the setup with connect_chrome and say in a line why it is needed. ") +
        "You get a note when it is connected: start the task then."
      );
    }
    d.chrome.awaitOnline(customerId);
    return (
      `Not started: the customer's Chrome${chrome.device ? ` (${chrome.device})` : ""} is connected, but silent` +
      `${chrome.lastSeenAt ? ` (last heard from ${age(chrome.lastSeenAt, d.now())})` : ""}. ` +
      "You get a note when it is back: start the task then. If they asked for this work and are waiting on it, tell them in a line when you last heard from it; " +
      "send connect_chrome only if they say it is open (its link reconnects the extension)."
    );
  };

  /**
   * A spent route (routes.ts) does not take more work until there is new evidence for it: then it is
   * reopened, and one more miss spends it again.
   */
  const spentRefusal = async (route: string | undefined, retryBecause: string | undefined): Promise<string | null> => {
    if (!route || !d.routes) return null;
    const r = await d.routes.get(customerId, route);
    if (r?.status !== "spent") return null;
    if (retryBecause) {
      await d.routes.reopen(customerId, route, retryBecause);
      return null;
    }
    return (
      `Not started: "${r.name}" is spent (${r.misses} tries in a row did not work${r.lastNote ? `; the last: ${clip(r.lastNote, 160)}` : ""}). ` +
      "Take another route. Go back to this one only with new evidence that it works now, and give that evidence as retry_because."
    );
  };

  // What this turn started, by teammate and site: one ask is one task (live, 2026-10-14: asked once for people on X,
  // the manager started a scout and an experiment for the same people, side by side). Taken before anything is awaited:
  // calls of one step run at once, and both of those were in one step.
  const startedThisTurn = new Map<string, { readonly title: string; id: string | null }>();

  /** Starts a task, or says why not: every way the manager starts work goes through here. */
  const startWork = async (agent: string, title: string, instructions: string, route?: string, retryBecause?: string, named?: string): Promise<Task | string> => {
    const site = named?.trim() ? siteOf(named) : null;
    if (named?.trim() && !site) return `Not started: "${named}" is not a site. Give its address, like x.com or linkedin.com, or leave site out.`;
    // The scout searches through search_posts' sources; a site none of them reads is the outreach teammate's.
    if (site && agent === "scout" && !Object.values(SOURCE_SITES).includes(site)) {
      return `Not started: the scout's search does not reach ${site}. Give it to outreach, with site ${site}: it works on any site in their Chrome.`;
    }
    const key = `${agent}|${site ?? ""}`;
    const twin = startedThisTurn.get(key);
    if (twin) {
      return `Not started: you already started the ${agent}${site ? ` on ${site}` : ""} this turn (${twin.id ? `task ${twin.id}, ` : ""}"${twin.title}"). One ask is one task: steer it with update_task if it needs more.`;
    }
    const mine = { title, id: null as string | null };
    startedThisTurn.set(key, mine);
    const t = await startChecked(agent, title, instructions, site, route, retryBecause);
    if (typeof t === "string") startedThisTurn.delete(key);
    else mine.id = t.id;
    return t;
  };

  const startChecked = async (agent: string, title: string, instructions: string, site: string | null, route?: string, retryBecause?: string): Promise<Task | string> => {
    const madeUp = unreadRefusal(instructions);
    if (madeUp) return madeUp;
    const spent = await spentRefusal(route, retryBecause);
    if (spent) return spent;
    if (!d.userTurn) {
      const refusal = await unattendedRefusal();
      if (refusal) return refusal;
    }
    const first = await sweepRefusal(agent);
    if (first) return first;
    const noChrome = await chromeRefusal(agent);
    if (noChrome) return noChrome;
    try {
      return await d.tasks.start(customerId, agent, title, instructions, site);
    } catch (e) {
      if (e instanceof UnknownAgentError) return e.message;
      throw e;
    }
  };

  /**
   * Until their first sweep ends, the teammates who read for people wait: it reads those sites first, by code, and two
   * readers on one site would only slow each other down.
   */
  const sweepRefusal = async (agent: string): Promise<string | null> => {
    if (!d.sweep || !SWEEP_FIRST.has(agent)) return null;
    const c = await d.customers.get(customerId);
    if (c.sweptAt) return null;
    // Whatever was missed (an on, a Chrome back), a refused start tries the sweep once more: one that never starts
    // holds the whole team back.
    const when = d.sweep.running(customerId) || (await d.sweep.maybeStart(customerId))
      ? "their first sweep is reading the sites where their people ask right now, by code"
      : "their first sweep comes first: it reads the sites where their people ask, by code, as soon as their brief is written and their Chrome is connected";
    return `Not started: ${when}. You will hear when it ends (first_sweep): start the ${agent} then. Anything they asked you for on a site meanwhile, do yourself with browser_open.`;
  };

  /** How long the teammate usually takes, so a time given to the customer is one Quest can keep. */
  const paceLine = (agent: string): string => {
    const p = d.paces?.find((x) => x.agent === agent);
    return p ? ` The ${agent}'s runs take about ${span(p.medianMs)}; 8 in 10 are done within ${span(p.p80Ms)}.` : "";
  };

  const siteField = z
    .string()
    .max(100)
    .optional()
    .describe(
      'Only when the customer named where the work happens ("on X", "on LinkedIn", "in r/SaaS"): that site, as its address (x.com, linkedin.com, reddit.com). ' +
        "The task then works there and nowhere else; its tools refuse every other site.",
    );

  const routeFields = {
    route: z.string().min(3).max(120).optional().describe("The route this work tries, as named on your board (a new name starts a new route)."),
    retry_because: z.string().min(10).max(300).optional().describe("Only for a spent route: the new evidence that it works now."),
  };

  const startTask = tool(
    async ({ agent, title, instructions, site, route, retry_because }) => {
      const t = await startWork(agent, title, instructions, route, retry_because, site);
      if (typeof t === "string") return t;
      return `Started task ${t.id} for the ${t.agent}${t.site ? `, on ${t.site} only` : ""}. It runs in the background; its report or its questions will arrive as new events.${paceLine(t.agent)}`;
    },
    {
      name: "start_task",
      description: `Give work to someone on your team. Returns at once; the work runs in the background.\nYour team:\n${d.catalog.describe()}`,
      schema: z.object({
        agent: z.string().describe(`Who does it: ${d.catalog.names().join(" or ")}.`),
        title: z.string().min(3).max(120).describe("A short name for the task, a few words in their language: they see it on their Quest page while it runs."),
        instructions: z
          .string()
          .min(10)
          .describe(
            "Everything they need: what to find out, where to look, what to hand back. They never see the chat: copy in every address, handle and word of theirs the work needs, never \"the links he sent\".",
          ),
        site: siteField,
        ...routeFields,
      }),
    },
  );

  // What the manager has read this turn: the briefing, and every report it opened. A draft's quote comes from here.
  const read: string[] = [d.briefing ?? ""];
  let browserView: BrowserView | null = null;
  // The pages themselves, for whose words a quote is.
  const views: BrowserView[] = [];

  /**
   * Why a brief may not go out: an address in it that nothing this turn showed. A teammate opens what it is given, and a
   * made-up thread id opens someone else's thread. Live, 2026-11-01: rewriting a stalled run's brief, the manager gave four
   * founders one post's address and seven ask threads nobody had sent. A search page is the manager's own to make.
   */
  const unreadRefusal = (instructions: string): string | null => {
    if (d.briefing === undefined) return null;
    const missing = [...new Set(instructions.match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? [])]
      .map((u) => u.replace(/[.,;:!?]+$/, ""))
      .filter((u) => !/[?&](q|query|search_query|keywords)=|\/(search|results)\b/i.test(u))
      // They write "acme.test" and the brief says https://acme.test: the address is the same without its scheme.
      .filter((u) => !read.some((s) => s.toLowerCase().includes(u.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "").toLowerCase())));
    if (!missing.length) return null;
    return (
      `Not sent: ${missing.slice(0, 5).join(" ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""} ${missing.length === 1 ? "is" : "are"} in nothing you read this turn. ` +
      "Copy every address exactly as their message, a report (check_task) or a page showed it, or leave it out: never write one from memory."
    );
  };

  const checkTask = tool(
    async ({ task_id }) => {
      const t = await d.tasks.find(customerId, task_id);
      if (!t) return `No task ${task_id} on your board.`;
      const open = (await d.questions.open(customerId)).filter((q) => q.taskId === t.id);
      const out = [
        `Task ${t.id} (${t.agent}) "${t.title}": ${t.status}.`,
        `Instructions: ${clip(t.instructions, 600)}`,
        t.result ? `Report:\n${t.result}` : "",
        t.error ? `Error: ${t.error}` : "",
        open.length ? `Open questions:\n${open.map((q) => questionLine(q, d.now())).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      read.push(out);
      return out;
    },
    {
      name: "check_task",
      description: "Read one task in full: its status, its whole report if it finished, and any questions it is waiting on.",
      schema: z.object({ task_id: z.string().describe("The task's id.") }),
    },
  );

  const updateTask = tool(
    async ({ task_id, instructions }) => {
      const madeUp = unreadRefusal(instructions);
      if (madeUp) return madeUp;
      const out = await d.tasks.steer(customerId, task_id, instructions);
      switch (out.kind) {
        case "unknown":
          return `No task ${task_id} on your board.`;
        case "finished":
          return `Task ${task_id} already ${out.task.status}. Start a new task instead.`;
        case "queued":
          return `Task ${task_id} had not started yet; it will start with your new instructions.`;
        case "interrupting":
          return `Task ${task_id} is stopping and will carry on with your new instructions.`;
        case "answered":
          return `Task ${task_id} was waiting on ${out.questions} question(s); your instructions went to it as the answer and it carries on.`;
      }
    },
    {
      name: "update_task",
      description: "Send new instructions to a task that is queued, running or waiting. It keeps what it has done and follows the new instructions.",
      schema: z.object({ task_id: z.string(), instructions: z.string().min(5).describe("As for start_task: every address it needs, copied in.") }),
    },
  );

  const cancelTask = tool(
    async ({ task_id }) => {
      const t = await d.tasks.cancel(customerId, task_id);
      if (!t) return `No open task ${task_id} on your board.`;
      return t.status === "cancelled" ? `Task ${task_id} is cancelled.` : `Task ${task_id} is stopping.`;
    },
    {
      name: "cancel_task",
      description: "Stop a task that is no longer needed. Its open questions are closed too.",
      schema: z.object({ task_id: z.string() }),
    },
  );

  const listTasks = tool(
    async ({ include_finished }) => {
      const now = d.now();
      const all = await d.tasks.list(customerId);
      const open = all.filter((t) => ["queued", "running", "waiting"].includes(t.status));
      const finished = include_finished ? all.filter((t) => !open.includes(t)).slice(0, 10) : [];
      if (!open.length && !finished.length) return "Your board is empty.";
      return [
        open.length ? `Open:\n${open.map((t) => taskLine(t, now)).join("\n")}` : "Nothing open.",
        finished.length ? `Recently finished:\n${finished.map((t) => taskLine(t, now)).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
    {
      name: "list_tasks",
      description: "Your board: the tasks that are queued, running or waiting, and optionally the recent finished ones.",
      schema: z.object({ include_finished: z.boolean().optional() }),
    },
  );

  const listQuestions = tool(
    async () => {
      const open = await d.questions.open(customerId);
      return open.length ? `Open questions (${open.length}):\n${open.map((q) => questionLine(q, d.now())).join("\n")}` : "No open questions.";
    },
    {
      name: "list_questions",
      description: "Every question your team is waiting on: the ones you have not asked the customer yet, and the ones they have not answered.",
      schema: z.object({}),
    },
  );

  const askUser = tool(
    async ({ question_ids }) => {
      const out = await d.questions.ask(customerId, question_ids);
      return [
        out.sent.length ? `In front of the customer now: ${out.sent.join(", ")}.` : "",
        out.held.length ? `Held back, because they already have enough open questions: ${out.held.join(", ")}. Ask again after they answer.` : "",
        out.unknown.length ? `Not open questions: ${out.unknown.join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join(" ");
    },
    {
      name: "ask_user",
      description: "Send your team's questions to the customer as cards with answer buttons. Their answers go straight back to the teammate who asked.",
      schema: z.object({ question_ids: z.array(z.string()).min(1).max(5) }),
    },
  );

  const answerQuestion = tool(
    async ({ question_id, answer }) => {
      const q = await d.questions.answer(questionId(question_id), answer, "manager");
      return q ? `Answered; the ${q.agent} carries on.` : `Question ${question_id} is not open.`;
    },
    {
      name: "answer_question",
      description: "Answer a teammate's question yourself, when you already know the answer from the customer or your notes.",
      schema: z.object({ question_id: z.string(), answer: z.string().min(1) }),
    },
  );

  const dismissQuestion = tool(
    async ({ question_id, note }) => {
      const q = await d.questions.dismiss(questionId(question_id), note);
      return q ? `Closed; the ${q.agent} was told: ${note}` : `Question ${question_id} is not open.`;
    },
    {
      name: "dismiss_question",
      description: "Close a question that no longer matters. The note tells the teammate what to do instead.",
      schema: z.object({ question_id: z.string(), note: z.string().min(3).max(300) }),
    },
  );

  const saveSite = tool(
    async ({ url }) => {
      const site = normaliseSite(url);
      if (!site) return `"${url}" is not a web address I can use. Ask the customer to check it.`;
      await d.customers.update(customerId, { siteUrl: site, status: "active" });
      return `Saved their site: ${site}`;
    },
    {
      name: "save_site",
      description: "Remember the customer's website address.",
      schema: z.object({ url: z.string() }),
    },
  );

  const saveBrief = tool(
    async ({ brief }) => {
      // A brief is the point where work can start: from here the heartbeat keeps it moving.
      await d.customers.update(customerId, { brief: brief.trim(), status: "active" });
      const c = d.sweep ? await d.customers.get(customerId) : null;
      if (!c || c.sweptAt) return "Brief saved. Every teammate reads it from now on.";
      if (d.sweep!.running(customerId) || (await d.sweep!.maybeStart(customerId))) {
        return "Brief saved. Every teammate reads it from now on. Their first sweep is reading the sites where their people ask now, by code, and a line in their chat shows how far it is: say nothing about it. Start no scout, explorer or outreach until it ends (you will hear: first_sweep).";
      }
      return "Brief saved. Every teammate reads it from now on. Their first sweep starts by itself once their Chrome is connected: it reads the sites where their people ask, by code, and a line in their chat shows how far it is. Start no scout, explorer or outreach until it ends (you will hear: first_sweep).";
    },
    {
      name: "save_brief",
      description:
        "Write the customer's brief, replacing the old one. Your team reads it before every task, and the scout writes messages from it, " +
        "so keep to facts from what they sent (their site, a deck, a doc) and their own words: what they offer and for whom, " +
        "in the words the people they want would use, what sets them apart, what they want and do not want, and how messages " +
        "should name them (e.g. \"I'm the founder of X\", \"I built X\").",
      schema: z.object({ brief: z.string().min(40).max(3000) }),
    },
  );

  const showFinds = tool(
    async ({ count }) => {
      const out = await d.finds.show(customerId, count);
      if (!out.shown) {
        return out.open
          ? `Nothing new shown: ${out.open} cards are already in front of the customer; the rest wait their turn.`
          : "No finds are waiting to be shown.";
      }
      d.onTold?.();
      return (
        `Showed ${out.shown} as cards: ${out.sources}.${out.alone ? ` ${out.alone} strong ${out.alone === 1 ? "one's reply goes" : "ones' replies go"} up by itself, a few minutes apart.` : ""} ` +
        `${out.open} cards are open now; ${out.waiting} more wait their turn.`
      );
    },
    {
      name: "show_finds",
      description:
        "Send the best waiting finds to the customer as cards (the post, why it fits, a reply they could post, and Keep / Skip / I replied buttons). " +
        "Only a few are open at a time; the rest wait their turn. Never paste finds into a message yourself.",
      schema: z.object({ count: z.number().int().min(1).max(5).optional() }),
    },
  );

  const connectChrome = tool(
    async ({ again }) => {
      const status = await d.chrome.status(customerId);
      if (!again && status.linked && status.online) return "Their Chrome is connected and open; there is nothing to set up.";
      if (!again && status.offeredAt) {
        return (
          `Not sent: it went out ${age(status.offeredAt, d.now())} and is still in their chat. Do not send it again, or remind them of it, ` +
          "unless they ask for a new link or say the code expired (again: true)."
        );
      }
      // After this turn's reply, never before it (live, 2026-10-24: the setup was the first thing they read, and the
      // question it should have followed came after it).
      const send = async (): Promise<void> => void (await d.chrome.offer(customerId, { force: Boolean(again) }));
      if (d.later) d.later(send);
      else await send();
      d.onTold?.();
      return (
        "Queued: the steps to install the extension, a Connect link and a code go out right under your reply, with the reason, so your reply does not mention them. " +
        "You get a note when their Chrome is connected. Now write your reply: a line or two, like a person texting, on what you understood and what you do next."
      );
    },
    {
      name: "connect_chrome",
      description:
        "Send the customer the steps to connect their Chrome: install the Messaging Quest extension, then open a Connect link (or type a code). " +
        "Your team reads pages and searches Reddit and the web only there, so do this before the first reading task. " +
        "It goes out once: set again only when they ask for a new link or say the code expired.",
      schema: z.object({ again: z.boolean().optional() }),
    },
  );

  const remember = tool(
    async ({ kind, text, replaces }) => {
      const out = await d.memory.add(customerId, { kind, text, source: "manager" });
      // Newer evidence replaces what it contradicts or repeats, in the same step: live, 2026-10-07, eleven
      // lessons about the same searches stayed kept side by side, each calling the last one's plan exhausted.
      // Only what the new memory is about: a wrong id must not retire an unrelated one (the real model, 2026-10-07,
      // retired "Saved Messages test is done; never send those notes again" to keep "No Reddit today").
      const retired: string[] = [];
      const kept: string[] = [];
      const live = await d.memory.list(customerId, 200);
      for (const raw of replaces ?? []) {
        const id = raw.replace(/^#/, "");
        const old = live.find((m) => m.id === id);
        if (!old || id === out.memory.id) continue;
        if (old.kind !== kind || overlap(old.text, text) < REPLACES_OVERLAP) {
          kept.push(`#${id} ("${clip(old.text, 100)}")`);
          continue;
        }
        if (await d.memory.retire(customerId, id)) retired.push(`#${id}`);
      }
      const notReplaced = kept.length
        ? ` Not retired, as it says something else: ${kept.join(", ")}. If it is no longer true, forget it on its own.`
        : "";
      const others = (await d.memory.list(customerId, 200)).filter((m) => m.id !== out.memory.id && m.kind === kind && overlap(m.text, text) >= SAME_MEMORY);
      const similar = others.length
        ? ` Still kept and saying much the same: ${others.slice(0, 4).map((m) => `#${m.id} "${clip(m.text, 90)}"`).join("; ")}. If the new one replaces them, forget them now.`
        : "";
      if (!out.added) return `Already kept as #${out.memory.id}.${retired.length ? ` Retired ${retired.join(", ")}.` : ""}${notReplaced}${similar}`;
      // A task reads what is kept when it starts; one already running hears a new decision now,
      // so "I'll keep pricing out of replies" holds for the search going on as well.
      const running = kind === "decision" ? (await d.tasks.list(customerId)).filter((t) => t.status === "running") : [];
      for (const t of running) {
        await d.tasks.steer(customerId, t.id, `The customer just decided: ${text} Follow it from now on, in everything you save or draft.`);
      }
      return (
        `Kept for good as #${out.memory.id}.${retired.length ? ` It replaces ${retired.join(", ")}, now retired.` : ""}` +
        `${running.length ? ` Passed on to ${running.length} running ${running.length === 1 ? "task" : "tasks"}.` : ""}${notReplaced}${similar}`
      );
    },
    {
      name: "remember",
      description:
        "Keep something for good: it shows at the start of every turn from now on, and your team reads decisions, voice and lessons before every task. " +
        "decision: what the customer decided, wants or does not want, in their words where you can. " +
        "voice: how their words should sound or what they never say, from their word or their edit to a card (\"short, like 'keep it up'\", \"never say founder\"): the writer follows every one. " +
        "lesson: what went wrong or worked, and what to do differently. " +
        "fact: about them, beyond the brief (where they are, a deadline, a constraint). One thing per memory, one sentence. " +
        "replaces: the #ids of memories this one makes untrue or repeats (newer evidence wins); they are retired in the same step.",
      schema: z.object({
        kind: z.enum(MEMORY_KINDS),
        text: z.string().min(8).max(400),
        replaces: z.array(z.string().max(20)).max(10).optional(),
      }),
    },
  );

  const setPlace = tool(
    async ({ place, verdict, reason, until }) => {
      // A hold they put a time on ends then: its lifting is a next step, woken for like any other.
      const ends = until ? whenFrom({ at: until }, d.now(), d.timezone ?? null) : null;
      if (until && !ends) return `Not changed: "${until}" is not a time I can read. Use one like "tomorrow 09:00".`;
      const raw = place.trim();
      const url = /^\/?r\/[A-Za-z0-9_]+\/?$/i.test(raw)
        ? `https://www.reddit.com/${raw.replace(/^\/|\/$/g, "")}/`
        : /^reddit(\.com)?$/i.test(raw)
          ? "https://www.reddit.com/"
          : /^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(raw)
            ? `https://${raw}`
            : raw;
      const key = placeKey(url);
      if (!key) return `"${place}" is not a place I can file: give its address, a Reddit community as r/NAME, or reddit.com for all of Reddit.`;
      const had = (await d.places.listFor(customerId)).find((p) => p.key === key);
      // A place closed by its own rules reopens only on the customer's word, or when the explorer reads the rules again.
      const byItsRules = had?.verdict === "avoid" && !had.rules?.startsWith("The customer's call");
      if (byItsRules && verdict === "search" && !d.userTurn) {
        return (
          `Not changed: ${had.name} was filed as avoid from its own rules${had.rules ? ` (${had.rules})` : ""}. ` +
          "If you think the rules allow a reply like theirs, have the explorer read them again; otherwise only the customer can overrule it."
        );
      }
      await d.places.save({
        customerId,
        key,
        name: had?.name ?? raw.replace(/^\/|\/$/g, ""),
        url: had?.url ?? url,
        verdict,
        rules: verdict === "avoid" ? `The customer's call: ${reason}` : (had?.rules ?? null),
        why: had?.why ?? reason,
      });
      const dropped = verdict === "avoid" ? await d.finds.dropWaitingFrom(customerId, key) : 0;
      const name = had?.name ?? raw;
      const lifted =
        ends && verdict === "avoid" && d.commitments
          ? await d.commitments.add(customerId, {
              kind: "next_step",
              what: `Lift the hold on ${name} they put a time on ("${clip(reason, 120)}"): set_place it back to search, unless they extended it.`,
              words: null,
              person: null,
              url: had?.url ?? url,
              taskId: null,
              dueAt: ends,
              onTime: true,
              source: "manager",
            })
          : null;
      const timed = !ends && verdict === "avoid" && /\b(today|tonight|this (week|weekend|morning|afternoon|evening)|for now|for a while|until)\b/i.test(reason);
      return (
        `${name} is now "${verdict}" on their list.` +
        (verdict === "avoid" ? " The scout will not save finds from it." : " The scout searches it first.") +
        (dropped ? ` ${dropped} waiting ${dropped === 1 ? "find" : "finds"} from there will not be shown.` : "") +
        (lifted ? ` The hold lifts at ${theirHour(lifted.dueAt, d.now(), d.timezone ?? null)} their time (next step #${lifted.id}).` : "") +
        (timed ? " They put a time on it: set it again with until, so the hold lifts on time instead of lasting for good." : "")
      );
    },
    {
      name: "set_place",
      description:
        "Put a place on the customer's list because they said so: avoid (\"stay out of r/X\") or search (\"try r/Y\"). " +
        "Unlike a memory, this is enforced: the scout cannot save a find from an avoided place, and waiting finds from it are dropped.",
      schema: z.object({
        place: z.string().min(3).max(200).describe("The place's address, a Reddit community as r/NAME, or reddit.com for all of Reddit (\"no Reddit today\")."),
        verdict: z.enum(["search", "avoid"]),
        reason: z.string().min(5).max(200).describe("Why, in their words where you can."),
        until: z
          .string()
          .max(40)
          .optional()
          .describe('avoid: when a hold they put a time on ends, on their clock ("no Reddit today" → "tomorrow 09:00"). It goes back to search then.'),
      }),
    },
  );

  // A turn retires a few memories one by one at most: more is a merge, and a merge keeps what they taught
  // (the real model, 2026-10-07, forgot twelve lessons in a turn about "No Reddit today", and wrote none in their place).
  let forgotten = 0;
  const forget = tool(
    async ({ memory_id }) => {
      if (forgotten >= FORGETS_A_TURN) {
        return (
          `Not retired: you have forgotten ${FORGETS_A_TURN} this turn. To retire more, write the one memory that says what they taught, ` +
          "with remember, and list them in replaces."
        );
      }
      const m = await d.memory.retire(customerId, memory_id.replace(/^#/, ""));
      if (m) forgotten++;
      return m ? `Retired #${m.id}: "${clip(m.text, 120)}".` : `No memory #${memory_id} is kept.`;
    },
    {
      name: "forget",
      description: "Retire a memory that stopped being true (they changed their mind, a lesson turned out wrong). Keep the new truth with remember.",
      schema: z.object({ memory_id: z.string().describe("The memory's number, e.g. 12.") }),
    },
  );

  const writePlan = tool(
    async ({ plan }) => {
      await d.customers.update(customerId, { plan: plan.trim() });
      return "Plan saved. It shows at the start of every turn.";
    },
    {
      name: "write_plan",
      description:
        "Rewrite your plan: where things stand, what you are trying next and why, what you are waiting for. " +
        "It replaces the old one and shows at the start of every turn. A few short lines, not a diary.",
      schema: z.object({ plan: z.string().min(10).max(1500) }),
    },
  );

  const setTimezone = tool(
    async ({ timezone, report_hour }) => {
      try {
        new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
      } catch {
        return `"${timezone}" is not a time zone name. Use one like Europe/Kyiv or America/New_York.`;
      }
      try {
        await d.customers.update(customerId, { timezone, ...(report_hour !== undefined ? { reportHour: report_hour } : {}) });
      } catch {
        return `"${timezone}" is not a time zone the database knows. Use the main city's name for that zone.`;
      }
      const c = await d.customers.get(customerId);
      const time = d.now().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timezone });
      return `Saved: it is ${time} for them now (${timezone}); their evening report goes out at ${String(c.reportHour).padStart(2, "0")}:00 their time.`;
    },
    {
      name: "set_timezone",
      description:
        "Save where the customer is, as a time zone (e.g. Europe/Kyiv), when they tell you or it is plain from what they said. " +
        "Their evening report then goes out in their evening, and you know when it is night for them. " +
        "report_hour moves the report when they ask for another time.",
      schema: z.object({ timezone: z.string().min(3).max(64), report_hour: z.number().int().min(0).max(23).optional() }),
    },
  );

  // Live, 2026-10-14: "English please" from a phone set to Portuguese got two more answers in Portuguese, the
  // language briefing pointing them to /language. Now the ask is enough.
  const setLanguage = tool(
    async ({ language }) => {
      const locale = supportedLocale(language);
      if (!locale) return `Quest speaks ${LOCALES.map((l) => `${LANGUAGES[l]} (${l})`).join(", ")}. Tell them which of these you can use.`;
      await d.customers.update(customerId, { language: `manual:${locale}` });
      return `Saved: ${LANGUAGES[locale]} from now on, whatever their phone is set to. Write this turn's message in it too.`;
    },
    {
      name: "set_language",
      description:
        'Save the language to write to the customer in, when they ask for one ("English please", "пиши українською") or keep writing to you in another one. ' +
        "It holds on every device until they ask again. Use a code: en, uk, ru, pt, es, fr, de, zh, hi, ar.",
      schema: z.object({ language: z.string().min(2).max(12) }),
    },
  );

  // Live, 2026-10-04: refused drafts asked for again, word for word, six times in one turn. After a few, the turn stops drafting.
  let refused = 0;
  const draft = tool(
    async (args: DraftArgs) => {
      if (refused >= DRAFT_REFUSALS) return `Not drafted: ${DRAFT_REFUSALS} drafts were refused this turn, so no more until your next one. Tell them only what is on a card.`;
      const said = await drafting(args);
      if (!said.startsWith("Not drafted")) return said;
      refused++;
      // The manager's turn is not kept, so what stopped a draft is otherwise lost (live, 2026-10-16: "the card tool keeps refusing it").
      d.log?.info("manager.draft_refused", { customerId: d.customerId, kind: args.kind, reason: said.slice(0, 200) });
      // Live, 2026-10-14: refused for an unread destination, DeepSeek told the founder "Post's written" and later that it waited on a card.
      return `${said} Nothing was written and no card exists: never tell them it is written or waiting.`;
    },
    {
      name: "draft",
      description:
        "Write a reply, community post, DM or email on any platform accessible in their browser, or like a post, follow a person, or change a field of " +
        "their own profile (kind profile: target the field, text its new words, limit the field's characters as the page showed them). Use the exact workspace/thread url and target " +
        "(community or recipient); title is optional for chat. Reddit retains community/to fields. Read the destination and quote replies and liked posts exactly. " +
        "The card records it and its verified outcome; done autonomously where authorized, otherwise waits for a tap. Read community rules before posting.",
      schema: draftSchema,
    },
  );

  async function drafting({ kind, text: given, url, quote, author, community: named, to: whom, title, rules_read, target, limit, assets }: DraftArgs): Promise<string> {
    // A Reddit community or person given as the destination works as well (live, 2026-10-16: DeepSeek put "r/buildinpublic" in target, and the
    // post was refused as having no community, three times).
    const community = named ?? (target && /^\/?r\/\w+$/i.test(target.trim()) ? target.trim() : undefined);
    const to = whom ?? (target && /^\/?u\/[\w-]+$/i.test(target.trim()) ? target.trim() : undefined);
    if (!d.drafts) return "Drafts are not available here.";
    const wordless = kind === "like" || kind === "follow";
    const text = wordless ? "" : (given ?? "").trim();
    if (!wordless && !text) return `Not drafted: a ${kind} needs its words in text${kind === "post" ? " (the body; the title goes in title)" : ""}. Call draft again with text written out.`;
    const stock = stockPhrases(text);
    if (stock.length) return `Not drafted: "${stock.join('", "')}" is how a bot writes. They post this as themselves: write it the way they would.`;
    if (assets?.length) {
      if (kind !== "post" && kind !== "reply") return "Not drafted: only a post or a reply goes up with their pictures.";
      const checked = d.ideas ? await d.ideas.attachable(customerId, assets) : { ok: [], refused: ["their assets are not available here"] };
      if (checked.refused.length) return `Not drafted: ${checked.refused.join("; ")}.`;
    }
    if (quote && !wasRead(quote, read)) {
      return (
        "Not drafted: that quote is not in anything you read this turn. Quote their words exactly as they appear above " +
        "(check_task shows a report in full), or leave the quote out of a message."
      );
    }
    let req: DraftRequest;
    // Likes, follows and profile edits go through the page on every site, Reddit's too.
    const browserKind = kind === "like" || kind === "follow" || kind === "profile";
    if (url && URL.canParse(url) && (platformFor(url) !== "reddit" || browserKind)) {
      // Words they dictated go on as they wrote them, not through the writer (live, 2026-10-15: a bio given word for word
      // came out with "and translator" added). Their words of the last day count too: a post they gave to go up later ("the
      // second in 2 hours") is drafted in a turn the promise woke, where they said nothing (live, 2026-11-13).
      const exact = quoteWords(text);
      const day = Date.now() - 24 * 3_600_000;
      const said = [...(d.theirs ?? []), ...(d.before ?? []).filter((e) => e.direction === "in" && e.at.getTime() > day)];
      const theirs = exact.length >= 12 && said.some((m) => quoteWords(m.text).includes(exact));
      // A post of their own words on a site Quest knows goes to their own feed, whose rules Quest holds: no page to read
      // first (live, 2026-11-13: the destination and rules checks ran a turn out of steps on five sites, twice).
      const ownPost = kind === "post" && theirs && Boolean(platformOf(url));
      if (!ownPost && !read.some((s) => s.includes(url))) return "Not drafted: read the destination first with browser_open or a task report.";
      if (kind === "reply" && !quote) return "Not drafted: a reply needs a short quote of the words it answers.";
      if (kind === "like" && !quote) return "Not drafted: a like needs a short quote of the post it likes, exactly as you read it.";
      const destination = target ?? to ?? community ?? (kind === "reply" || kind === "like" ? url : null);
      if (!destination) return kind === "profile" ? "Not drafted: name the field in target (bio, headline, name, location, website)." : "Not drafted: give the exact destination or recipient.";
      if (kind === "reply" || kind === "message") {
        const own = ownWordsRefusal(quote, views, (await d.customers.get(customerId)).displayName, author ?? destination);
        if (own) return `Not drafted: ${own}`;
      }
      req = { platform: "browser", kind, url, target: destination, text, title: title ?? null, quote: quote ?? null, author: author ?? null, rulesRead: rules_read === true || rules_read === "true" || ownPost, limit: limit ?? null, theirs, ...(assets?.length ? { assets } : {}) };
    } else if (browserKind) {
      return "Not drafted: give the url of the page it happens on (the post, their profile, or their profile's edit page), read this turn.";
    } else {
      switch (kind) {
        case "reply":
          if (!url || !quote) return "Not drafted: a reply needs the address of the post or comment it answers, and a short quote of their words.";
          // Live, 2026-10-04: asked for comments, the manager wrote eight replies to threads it made up, one post id in three communities.
          if (!threadRead(url, read)) return "Not drafted: that thread is not in anything you read this turn. Reply only to a post you read; for people the scout found, use show_finds.";
          req = { kind, url, quote, author: author ?? null, text };
          break;
        case "post":
          if (!community || !title) return "Not drafted: a post needs the community (r/name) and a title.";
          req = { kind, community, title, text, rulesRead: rules_read === true || rules_read === "true", ...(assets?.length ? { assets } : {}) };
          break;
        case "message":
          if (!to || !title) return "Not drafted: a message needs who it is for (u/name) and a subject.";
          req = { kind, to, subject: title, text, url: url ?? null, quote: quote ?? null };
          break;
      }
    }
    const out = await d.drafts.offer(customerId, req);
    if (typeof out === "string") return `Not drafted: ${out}`;
    d.onTold?.();
    // Live, 2026-10-15: told "Publishing", the turn wrote "followed @ari, bio set" minutes before either was done.
    if (out.alone)
      return `Publishing on ${out.draft.platform} (draft ${out.draft.id}), not done yet: what Quest does by itself goes in turn, minutes apart, and its card shows when it is done. Say it is on its way, never that it is done.`;
    const button = doneWords(out.draft.kind, out.draft.platform).button;
    return (
      `Waiting for their OK in the chat, with ${button}${WORDLESS.has(out.draft.kind) ? "" : ", Edit"} and Skip (draft ${out.draft.id}). It happens on their tap, ` +
      "and the card shows when it has. When their message this turn asked you to do exactly this, send_draft it now with their_words. The card speaks for itself: do not repeat the draft in a message."
    );
  }

  const editCard = tool(
    async ({ id, text, title }) => {
      // Their own words, from what they wrote this turn, go on as they wrote them; anything else is put in their voice.
      const words = quoteWords(text);
      const theirs = words.length > 0 && (d.theirs ?? []).some((m) => quoteWords(m.text).includes(words));
      const stock = theirs ? [] : stockPhrases(text);
      if (stock.length) return `Not changed: "${stock.join('", "')}" is how a bot writes. They post this as themselves: write it the way they would.`;
      const asDraft = d.drafts ? await d.drafts.revise(customerId, draftId(id), text, title ?? null, theirs) : "there is no such draft";
      const out = asDraft === "there is no such draft" ? await d.finds.revise(customerId, findId(id), text, theirs) : asDraft;
      if (typeof out === "string") return `Not changed: ${out}.`;
      d.onTold?.();
      return "Changed: the card shows the new words, and Post it posts them. Do not repeat them in a message.";
    },
    {
      name: "edit_card",
      description:
        "Change the words on one of their open cards (a draft of yours, or a find's reply) when they ask for a change. Their own words go in " +
        "exactly as they wrote them, and stay as they are; a note (\"shorter\", \"no price\") you apply yourself, and the writer puts it in their voice. The card updates in place.",
      schema: z.object({
        id: z.string().uuid().describe("The card's draft or find id, from their reply's note or your board."),
        text: z.string().min(1).max(10_000),
        title: z.string().max(300).optional().describe("A post's title or a message's subject, when that changes too."),
      }),
    },
  );

  const dropFinds = tool(
    async ({ about }) => {
      const out = await d.finds.dropAbout(customerId, about);
      return `Dropped ${out.dropped} waiting ${out.dropped === 1 ? "find" : "finds"} that name "${about}", and closed ${out.closed} open ${out.closed === 1 ? "card" : "cards"}.`;
    },
    {
      name: "drop_finds",
      description:
        "When they rule something out (a product they dropped, a kind of person), drop the finds about it in the same turn: the waiting ones go " +
        "and their open cards close. `about` is a word every one of them has and no other find does, e.g. the dropped product's name.",
      schema: z.object({ about: z.string().min(3).max(60) }),
    },
  );

  const posting = tool(
    async ({ ask_first, platform, kinds: only }) => {
      if (!d.trust) return "Not available here.";
      if (d.theySpoke === false) return "Not changed: how you post changes only on their word, in a turn where they said so. Their settings stay as they are.";
      const raw = platform?.trim().toLowerCase() ?? "*";
      const where = raw === "*" || raw === "reddit" ? raw : platformFor(URL.canParse(raw) ? raw : `https://${raw}`);
      // Some kinds only ("likes and follows by yourself, ask me for the rest"): each platform's own row for each, so the
      // rest keeps its setting. Live, 2026-11-05: with no way to say it, "*" went on and then back to asking for all.
      if (only?.length) {
        const hosts = where === "*" ? [...new Set(SITES.flatMap((p) => (p.key === "reddit" ? ["reddit"] : p.hosts)))] : [where];
        const kinds = ask_first ? only : only.filter((k) => mayGoAlone(trustKey("x", k)));
        // Everywhere, a kind is one row ("* likes"), which a site with no name here reads too; replies have no such row
        // ("*" is everything), so they go site by site.
        for (const kind of kinds) {
          if (where === "*" && kind !== "reply") await d.trust.set(customerId, trustKey("*", kind), ask_first ? 0 : TRUST_AFTER, true);
          else for (const host of hosts) await d.trust.set(customerId, trustKey(host, kind), ask_first ? 0 : TRUST_AFTER, true);
        }
        const names = kinds.map((k) => `${k}s`).join(", ") || "nothing";
        const on = where === "*" ? "every platform" : where;
        return ask_first ? `Done: ${names} on ${on} wait for their tap; everything else is as it was.` : `Done: ${names} on ${on} go up by themselves now; everything else is as it was${kinds.length < only.length ? " (private messages always wait for their tap)" : ""}.`;
      }
      // A platform's trust is kept per kind ("x.com likes"): its replies alone were all a "go ahead on X" set until
      // 2026-11-03. Its private messages still wait for a tap; "ask me first" there covers every kind.
      const kinds = where === "*" ? (["reply"] as const) : ask_first ? DRAFT_KINDS : (["reply", "post", "like", "follow"] as const);
      for (const kind of kinds) await d.trust.set(customerId, trustKey(where, kind), ask_first ? 0 : TRUST_AFTER, true);
      return ask_first
        ? `Done: outgoing drafts on ${where === "*" ? "all platforms" : where} wait for their tap.`
        : where === "*"
          ? "Done: publish replies, posts, DMs and emails on all connected platforms yourself, in pursuit of their goal."
          : `Done: replies, posts, likes and follows on ${where} go up by themselves now; private messages there still wait for their tap.`;
    },
    {
      name: "posting",
      description:
        "Only when they say how they want outgoing messages to go: ask_first true when they want to check each draft (\"ask me first\"), " +
        "false when they tell you to stop asking and post yourself. Never on your own judgement, and never to put things \"back\": what they set stays set. " +
        "When they name kinds, pass only those in `kinds` and call it once: \"do likes and follows yourself everywhere, ask me for the rest\" is ask_first false, platform *, kinds like and follow; " +
        "the kinds not named keep their setting, so never call it again with ask_first true for them.",
      schema: z.object({
        ask_first: z.boolean(),
        platform: z.string().optional().describe("Platform host, reddit, or * for all workspaces (default)."),
        kinds: z.array(z.enum(["reply", "post", "message", "like", "follow"])).optional().describe("Only these kinds of things change; leave it out for all of them."),
      }),
    },
  );

  // A screenshot reaches the model only; they see one when this sends it. Live, 2026-10-13: asked to
  // show the picture, the manager wrote "Here's the Google shot" and nothing arrived.
  let pictures = 0;
  const showScreenshot = tool(
    async ({ caption }) => {
      const screen = d.browser && d.browserSession ? d.browser.screen(customerId, d.browserSession) : undefined;
      if (!screen) return 'Not sent: no screenshot is open this turn. Open the page with browser_open, take one with browser_act {"kind":"screenshot"}, then call this again.';
      if (pictures >= PICTURES_A_TURN) return `Not sent: ${PICTURES_A_TURN} pictures this turn is enough.`;
      const jpeg = Buffer.from(screen.image.replace(/^data:image\/\w+;base64,/, ""), "base64");
      const where = browserView ? (URL.canParse(browserView.url) ? new URL(browserView.url).host : browserView.url) : "the page";
      const ref = await d.messenger.showPicture(customerId, jpeg, caption ?? null, `a screenshot of ${where}`);
      if (!ref) return "Not sent: their chat can't be reached.";
      pictures++;
      return "Sent: the picture is in their chat now.";
    },
    {
      name: "show_screenshot",
      description:
        "Send the customer the screenshot you took this turn (browser_act screenshot), as a picture in their chat, when they ask to see a page or a picture would show them what words can't. " +
        "They see a picture only when this says Sent: never say you sent or showed one otherwise.",
      schema: z.object({ caption: z.string().max(200).optional().describe("A few words under the picture, in their language. Optional.") }),
    },
  );

  const tools: StructuredToolInterface[] = [
    ...browserTools(d.browser, customerId, (view) => { browserView = view; views.push(view); read.push(JSON.stringify(view)); }, d.browserSession),
    showScreenshot,
    tool(async ({ id }) => {
      if (!d.drafts || !browserView) return "Inspect the destination with browser_open first.";
      const result = await d.drafts.verifySent(customerId, draftId(id), browserView);
      return typeof result === "string" ? result : `Verified the held send at ${result.sentUrl}. It was not sent again.`;
    }, { name: "verify_sent_draft", description: "After inspecting a held/unknown send's destination, record success only if its exact body is visible outside the composer. Never resends. When it wasn't sent, the customer can use the card's checked-not-sent retry button.", schema: z.object({ id: z.string().uuid() }) }),
    tool(async ({ id, their_words }) => {
      if (!d.drafts) return "Drafts are unavailable.";
      // Their own words in this turn ("Try again", "post it") are a tap on its card: live, 2026-10-13, after a failed post
      // the customer wrote "Try again" and the turn could only point them back to the card.
      const asked = their_words ? quoteWords(their_words) : "";
      if (asked && !(d.theirs ?? []).some((m) => quoteWords(m.text).includes(asked))) return `Not sent: "${their_words}" is not in what they wrote this turn. Quote their message exactly, or leave it on its card.`;
      return d.drafts.publish(customerId, draftId(id), { asked: Boolean(asked) });
    }, {
      name: "send_draft",
      description:
        "Publish an existing open draft: after the customer authorizes autonomous sending on its platform, or when their message in this turn tells you to post or send that draft, " +
        "or to do what it does (\"update my bio on X\", \"like his post\", \"follow her\", or to try it again after it failed): then give their_words, quoted exactly from that message " +
        '("Try again", "update my X bio"), and it goes as if they tapped its button. ' +
        "Reuses its record rather than creating a duplicate. Never use for a posted or unknown send.",
      schema: z.object({ id: z.string().uuid(), their_words: z.string().max(300).optional() }),
    }),
    tool(async ({ id }) => {
      if (!browserView) return "Inspect the destination with browser_open first.";
      const result = await d.finds.verifySent(customerId, findId(id), browserView);
      return typeof result === "string" ? result : `Verified the held reply at ${result.sentUrl}. It was not sent again.`;
    }, { name: "verify_sent_find", description: "Verify a held find-card reply from its actual destination, never by sending it again.", schema: z.object({ id: z.string().uuid() }) }),
    draft,
    ...ideaTools(d.ideas, customerId),
    editCard,
    dropFinds,
    posting,
    remember,
    setPlace,
    forget,
    writePlan,
    setTimezone,
    setLanguage,
    connectChrome,
    saveBrief,
    showFinds,
    startTask,
    checkTask,
    updateTask,
    cancelTask,
    listTasks,
    listQuestions,
    askUser,
    answerQuestion,
    dismissQuestion,
    saveSite,
    ...ownershipTools({
      customerId,
      timezone: d.timezone ?? null,
      now: d.now,
      ...(d.commitments ? { commitments: d.commitments } : {}),
      ...(d.results ? { results: d.results } : {}),
      ...(d.routes ? { routes: d.routes } : {}),
      finds: d.finds,
      tasks: d.tasks,
      ...(d.paces ? { paces: d.paces } : {}),
      messenger: d.messenger,
      ...(d.userTurn && d.theirs ? { theirs: d.theirs } : {}),
      ...(d.before ? { before: d.before } : {}),
      ...(d.onReacted ? { onReacted: d.onReacted } : {}),
      ...(d.onShortlist ? { onShortlist: d.onShortlist } : {}),
      read,
    }),
  ];

  // In a turn where the customer wrote, the reply is the final message; speaking
  // separately as well would only say things twice.
  if (!d.userTurn) {
    let sent = 0;
    let noted = false;
    tools.push(
      tool(
        async ({ text: written }) => {
          const stock = stockPhrases(written);
          if (stock.length) {
            return `Not sent: "${stock.join('", "')}" is how a bot writes, not a colleague. Say the same thing plainly and send it again.`;
          }
          const lists = read.filter((r) => r.startsWith(BEST_PEOPLE));
          const text = await withLinks(customerId, written, lists, d.finds);
          const wait = d.news || !d.pulse ? null : holdBack(d.pulse, sent, d.now());
          if (wait) {
            return (
              `Not sent: ${wait}. They hired you so they don't have to follow the work: this waits for the evening report, or for when they write. ` +
              "Do not try again this turn. Keep working; finds still reach them as cards."
            );
          }
          // Asked once per turn: these are judgements, and the second try goes out as written.
          if (!noted) {
            const notes = voiceNotes(text, { language: customerLocale((await d.customers.get(customerId)).language), earlier: (await d.said?.()) ?? [], report: d.reportDue ?? false, shortlist: lists.length > 0 });
            if (notes.length) {
              noted = true;
              return `Not sent: ${notes.join("; ")}. Write it again that way and send it.`;
            }
          }
          // Writing first to ask them something: Quest waits on them, and its sticker says so.
          await d.messenger.say(customerId, text);
          sent++;
          d.onTold?.();
          return "Sent.";
        },
        {
          name: "message_user",
          description:
            "Send the customer a message now, only for what is worth their time today: a person worth answering now, news about a reply they posted, " +
            "something only they can decide or do, a follow-up on a question they owe you when one is due, what you promised them when it is ready " +
            "(or that it needs longer, before its time passes), or the evening report. " +
            "Progress and plans wait for the report. Never an empty check-in.",
          schema: z.object({ text: z.string().min(1).max(3000) }),
        },
      ),
    );
  }
  return tools;
}

/**
 * The customer steers (ideas/idea-service.ts): their ideas for posts kept as theirs to do, and the links they share for
 * posts kept with their pictures..
 */
function ideaTools(ideas: ManagerToolDeps["ideas"], customerId: CustomerId): StructuredToolInterface[] {
  if (!ideas) return [];
  const idea = tool(
    async ({ text, platform, assets }) => {
      if (assets?.length) {
        const checked = await ideas.attachable(customerId, assets);
        if (checked.refused.length) return `Not kept: ${checked.refused.join("; ")}.`;
      }
      const kept = await ideas.theirs(customerId, text, platform ?? null, assets ?? []);
      return `Kept as their idea ${kept.id}: it is on your board to do. Draft it when it fits (their words lead), then idea_status done with the draft's id.`;
    },
    {
      name: "idea",
      description:
        'Keep their idea for a post, what they want posted ("post about our first paying user", "a thread on why we left Typeform"), as theirs to do. ' +
        "platform when it is for one site; assets for their pictures it uses.",
      schema: z.object({
        text: z.string().min(5).max(1_000).describe("The idea in a sentence or two, in their language: what the post says and why now."),
        platform: z.string().max(60).optional().describe("x.com, linkedin.com, reddit, ... when it is for one site."),
        assets: z.array(z.string().uuid()).max(4).optional(),
      }),
    },
  );
  const status = tool(
    async ({ id, status: to, draft_id }) => {
      const out = await ideas.decide(customerId, id, to, draft_id ?? null);
      return out ? `Idea ${id} is ${to} now.` : `No idea ${id} of theirs.`;
    },
    {
      name: "idea_status",
      description: "Move an idea on: done once you drafted it (with the draft's id), no when they passed on it in words. A tap on its card does this by itself.",
      schema: z.object({ id: z.string().uuid(), status: z.enum(["done", "no"]), draft_id: z.string().uuid().optional() }),
    },
  );
  const keepAsset = tool(
    async ({ url, about }) => {
      if (!URL.canParse(url)) return "Not kept: give the full address.";
      const a = await ideas.keepLink(customerId, url, about);
      return `Kept as their asset ${a.id}: a link for their posts. It goes in a post's words, not attached.`;
    },
    {
      name: "keep_asset",
      description: "Keep a link they shared for their posts (a demo video, a launch page, a case study), with what it is. Pictures and videos they send in the chat are kept by themselves.",
      schema: z.object({ url: z.string().max(2_000), about: z.string().min(3).max(600).describe("What it is and what it is good for, in a line.") }),
    },
  );
  const dropAsset = tool(
    async ({ id }) => ((await ideas.dropAsset(customerId, id)) ? `Asset ${id} is off their list.` : `No asset ${id} of theirs.`),
    {
      name: "drop_asset",
      description: "Take an asset off their list: a picture they sent that is not for posts (a screenshot of a problem), or one they no longer want used.",
      schema: z.object({ id: z.string().uuid() }),
    },
  );
  return [idea, status, keepAsset, dropAsset];
}
