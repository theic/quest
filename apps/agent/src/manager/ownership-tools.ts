import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  RESULT_STAGES,
  ROUTE_RESULTS,
  sourceLabel,
  STAGE_WORDS,
  stageWords,
  summarizeResults,
  type AgentPace,
  type CustomerId,
  type Find,
  type ResultRepository,
  type RouteRepository,
  type TranscriptEntry,
} from "@mq/core";
import { tool } from "langchain";
import { z } from "zod";
import type { Messenger } from "../conversation/messenger.ts";
import { reactionEmoji, reactionRefusal, REACTIONS } from "../conversation/reactions.ts";
import type { FindService } from "../finds/find-service.ts";
import { overlap, SAME_MEMORY } from "../lib/overlap.ts";
import { clip } from "../lib/sleeper.ts";
import { span, theirHour, whenFrom } from "../lib/their-time.ts";
import type { TaskService } from "../tasks/task-service.ts";
import type { Commitments } from "./commitments.ts";

export interface OwnershipToolDeps {
  readonly customerId: CustomerId;
  readonly timezone: string | null;
  readonly now: () => Date;
  readonly commitments?: Commitments;
  readonly results?: ResultRepository;
  readonly routes?: RouteRepository;
  readonly finds: Pick<FindService, "best">;
  readonly tasks: Pick<TaskService, "find">;
  /** How long each teammate's runs take: a promise on a task's work is held to it. */
  readonly paces?: readonly AgentPace[];
  readonly messenger: Pick<Messenger, "react">;
  /** Their messages this turn that can take a reaction, oldest first. Empty outside a turn where they wrote. */
  readonly theirs?: readonly { readonly ref: string; readonly text: string }[];
  /** The chat before this turn, oldest first: their earlier messages and the reactions on them. */
  readonly before?: readonly TranscriptEntry[];
  readonly onReacted?: (emoji: string) => void;
  /** Each shortlist best_people gave: the reply that names those people gets their links from it. */
  readonly onShortlist?: (shortlist: string) => void;
  /** What the turn has read: a shortlist is read too, so a draft may quote it. */
  readonly read: string[];
}

const timeFields = {
  in_minutes: z.number().int().min(1).max(20_160).optional().describe("Minutes from now. Use this or at."),
  at: z.string().max(40).optional().describe('A time on their clock: "15:30", "3pm", "tomorrow 10:00". Use this or in_minutes.'),
};

const ago = (from: Date, now: Date): string => `${span(now.getTime() - from.getTime())} ago`;

/** How best_people's answer opens: a message after it that names people owes each one's link. */
export const BEST_PEOPLE = "The best people found so far";

/** How a find's person is named: "u/name" on Reddit, the author elsewhere, null when nobody signed it. */
const whoOf = (f: Find): string | null => (f.author ? (f.source.startsWith("reddit") ? `u/${f.author.replace(/^u\//, "")}` : f.author) : null);

/** A find as a shortlist line: who, where, how fresh, their words, why they fit, and the link. */
function personLine(f: Find, now: Date): string {
  const who = whoOf(f) ?? "someone";
  const status = f.sentAt ? "you replied" : f.status === "replied" ? "they replied" : f.status === "kept" ? "they kept it" : f.status === "shown" ? "on a card" : "not shown yet";
  const fresh = f.postedAt ? `posted ${ago(f.postedAt, now)}` : `found ${ago(f.createdAt, now)}`;
  return `- ${who} in ${sourceLabel(f.source, f.url)} (${fresh}, ${f.strength}, ${status}): "${clip(f.quote.replace(/\s+/g, " "), 180)}" Why: ${clip(f.why, 160)} ${f.url} [find ${f.id}]`;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A person Quest found, and the link to what they wrote. */
export interface Person {
  readonly who: string;
  readonly url: string;
}

/** The people in best_people's answers, in its order. */
export function shortlistPeople(shortlists: readonly string[]): Person[] {
  return shortlists.flatMap((s) => s.split("\n")).flatMap((line) => {
    const m = /^- (.+?) in .* (https?:\/\/[^\s)]+) \[find [^\]]+\]$/.exec(line);
    return m && m[1] !== "someone" ? [{ who: m[1]!, url: m[2]! }] : [];
  });
}

/** The people behind these finds. */
export const findPeople = (finds: readonly Find[]): Person[] =>
  finds.flatMap((f) => {
    const who = whoOf(f);
    return who && !f.url.includes(")") ? [{ who, url: f.url }] : [];
  });

/**
 * A name that can stand without its "u/" and still be the person: one no ordinary word looks like
 * ("Quiet-Lake-1234", "teal_kite"). "Grace" or "mom" alone is never linked.
 */
const distinctive = (name: string): boolean => /[\d_.-]/.test(name) || /\s/.test(name.trim());

/**
 * The names a message may mean as people, without any "u/": every "u/name", and every word that could
 * only be a handle. Live, 2026-10-08: "Quiet-Lake-1234 replied 6 days ago", with no "u/" before it.
 */
export const namedIn = (text: string): string[] => {
  const handles = [...text.matchAll(/(?<![\w/])u\/([\w-]{3,})/g)].map((m) => m[1]!);
  const bare = [...text.matchAll(/(?<![\w/.-])[A-Za-z][\w-]{2,}(?![\w-])/g)].map((m) => m[0]).filter((w) => distinctive(w) && !handles.includes(w));
  return [...new Set([...handles, ...bare])];
};

/** What shows a link is in a message already, however the model shortened it: a Reddit thread's id, or the address without its scheme. */
const linkKey = (url: string): string => /\/comments\/(\w+)/.exec(url)?.[0].slice(1) ?? url.replace(/^https?:\/\/(www\.)?/, "");

/**
 * A message that names people Quest found, with each one's link on their name (the first time it
 * appears) unless the message already carries that link; the first link for a person wins. Live on
 * Telegram, 2026-10-08, "Who should we try next?" got three u/ names and no links, the rewrite asked
 * for them came back the same, and "Can you send me their links?" named one from the chat before,
 * not from the shortlist, and left it bare.
 */
export function linkPeople(text: string, people: readonly Person[]): string {
  let out = text;
  const done = new Set<string>();
  for (const { who, url } of people) {
    if (done.has(who)) continue;
    done.add(who);
    if (out.includes(linkKey(url))) continue;
    // "u/name", or the bare name when no ordinary word looks like it; never inside a link already, or inside a longer name.
    const bare = who.startsWith("u/") ? who.slice(2) : who;
    const names = [...(who.startsWith("u/") ? [who] : []), ...(distinctive(bare) ? [bare] : [])];
    for (const name of names) {
      const at = new RegExp(`(?<![\\[\\w/-])${escapeRegExp(name)}(?![\\w-])`).exec(out);
      if (!at) continue;
      out = `${out.slice(0, at.index)}[${name}](${url})${out.slice(at.index + name.length)}`;
      break;
    }
  }
  return out;
}

/** A message with the people it names linked: from the turn's shortlists first, then from the finds by the u/ names it mentions. */
export async function withLinks(
  customerId: CustomerId,
  text: string,
  shortlists: readonly string[],
  finds: Pick<FindService, "byAuthors">,
): Promise<string> {
  const names = namedIn(text);
  const found = names.length ? findPeople(await finds.byAuthors(customerId, names)) : [];
  return linkPeople(text, [...shortlistPeople(shortlists), ...found]);
}

/**
 * The tools that make Quest own the work: keep its word on time (promise, next_step, settle), know what
 * the work came to (record_result), change course when a way of working stops working (log_try), bring
 * back the best people with their links (best_people), and react to a message like a person (react).
 */
export function ownershipTools(d: OwnershipToolDeps): StructuredToolInterface[] {
  const { customerId } = d;
  const tz = d.timezone;
  const hour = (t: Date): string => theirHour(t, d.now(), tz);
  const tools: StructuredToolInterface[] = [];

  if (d.commitments) {
    const commitments = d.commitments;
    const due = (input: { in_minutes?: number | undefined; at?: string | undefined }): Date | string => {
      if ((input.in_minutes === undefined) === (input.at === undefined)) return "give the time as in_minutes or as at (their clock), one of them";
      return whenFrom({ minutes: input.in_minutes, at: input.at }, d.now(), tz) ?? `"${input.at}" is not a time I can read: use in_minutes, or at like "15:30" or "tomorrow 10:00"`;
    };

    tools.push(
      tool(
        async ({ what, words, on_time, task_id, ...when }) => {
          const at = due(when);
          if (typeof at === "string") return `Not kept: ${at}.`;
          const now = d.now();
          // The same thing owed twice is one promise with a new time (the real model, 2026-10-07, moved #1 and kept it again as #2).
          const twin = (await commitments.open(customerId)).find((c) => c.kind === "promise" && overlap(c.what, what) >= SAME_MEMORY);
          if (twin) {
            return `Not kept: you already owe this as promise #${twin.id} ("${clip(twin.what, 100)}", due ${hour(twin.dueAt)}). To give it a new time, settle it as moved.`;
          }
          const task = task_id ? await d.tasks.find(customerId, task_id) : null;
          if (task_id && !task) return `Not kept: no task ${task_id} on your board.`;
          const pace = task ? d.paces?.find((p) => p.agent === task.agent) : undefined;
          if (task && pace && !on_time) {
            const left = pace.medianMs - (now.getTime() - task.createdAt.getTime());
            if (at.getTime() - now.getTime() < left) {
              return (
                `Not kept: the ${task.agent}'s runs take about ${span(pace.medianMs)} (8 in 10 within ${span(pace.p80Ms)}), and this one started ` +
                `${ago(task.createdAt, now)}. Promise a time you can keep, and tell them that one.`
              );
            }
          }
          const c = await commitments.add(customerId, {
            kind: "promise",
            what,
            words: words ?? null,
            person: null,
            url: null,
            taskId: task?.id ?? null,
            dueAt: at,
            onTime: on_time ?? false,
            source: "manager",
          });
          return (
            `Kept as promise #${c.id}: due ${hour(at)} their time, in ${span(at.getTime() - now.getTime())}. ` +
            (c.onTime
              ? "You are woken then: it goes out then, not before."
              : `You are woken at ${hour(c.checkAt)} to deliver it, or to tell them it needs longer while there is still time.`) +
            " Once delivered, settle it as kept."
          );
        },
        {
          name: "promise",
          description:
            "Keep a promise with a time on it: what you told them you'd bring and when (\"give me 5 min\", \"within the hour\", \"this afternoon\"), or what they asked you " +
            "to bring back at a time (\"come back in two minutes with…\"). You are woken before the time passes to deliver it, or to say plainly that it needs longer and give a new time. " +
            "Give the same time you tell them. on_time: they asked for it at that time, so it goes out then and not before. task_id: the task doing the work.",
          schema: z.object({
            what: z.string().min(5).max(300).describe("What you owe them, specific enough to check: \"the 3 best people found so far, with links and why\"."),
            words: z.string().max(120).optional().describe('How you put the time to them: "give me 5 min".'),
            on_time: z.boolean().optional(),
            task_id: z.string().optional(),
            ...timeFields,
          }),
        },
      ),
      tool(
        async ({ person, what, url, ...when }) => {
          const at = due(when);
          if (typeof at === "string") return `Not planned: ${at}.`;
          const c = await commitments.add(customerId, { kind: "next_step", what, words: null, person, url: url ?? null, taskId: null, dueAt: at, onTime: false, source: "manager" });
          return `Next step #${c.id} with ${person}: ${hour(at)} their time. You are woken then to do it.`;
        },
        {
          name: "next_step",
          description:
            "Plan the next step in a conversation with a person you found or wrote to: answer them, send the link they asked for, check whether they tried it, " +
            "ask how it went. You are woken when it is due. A conversation that matters always has one until it ends or turns into a customer.",
          schema: z.object({
            person: z.string().min(2).max(120).describe("Who: u/name, their name, their address."),
            what: z.string().min(5).max(300).describe("The step, specific: \"check whether she signed up, and if not, send the setup link\"."),
            url: z.string().max(2000).optional().describe("Where the conversation is."),
            ...timeFields,
          }),
        },
      ),
      tool(
        async ({ id, outcome, note, words, ...when }) => {
          const key = id.replace(/^#/, "");
          if (outcome === "moved") {
            const at = due(when);
            if (typeof at === "string") return `Not moved: ${at}.`;
            const c = await commitments.move(customerId, key, at, words ?? null, note);
            if (!c) return `Nothing open as #${key}.`;
            return c.kind === "promise"
              ? `Moved #${c.id} to ${hour(at)} their time. Tell them now, in a line, before the old time passes: why, and the new time.`
              : `Moved #${c.id} to ${hour(at)} their time.`;
          }
          const c = await commitments.settle(customerId, key, outcome, note);
          return c ? `#${c.id} settled as ${outcome}.` : `Nothing open as #${key}.`;
        },
        {
          name: "settle",
          description:
            "Close or move something you owe (a promise or a next step), by its #id: kept once it is done and they have it; dropped when it no longer matters or " +
            "newer evidence made it moot (say why); moved to a new time when it needs longer (a promise moved is told to them before its old time passes).",
          schema: z.object({
            id: z.string().min(1).max(20),
            outcome: z.enum(["kept", "dropped", "moved"]),
            note: z.string().min(3).max(300).describe("In a line: what was delivered, why it was dropped, or why it needs longer."),
            words: z.string().max(120).optional().describe("moved: how you put the new time to them."),
            ...timeFields,
          }),
        },
      ),
    );
  }

  if (d.results) {
    const results = d.results;
    tools.push(
      tool(
        async ({ stage, person, count, url, evidence, source }) => {
          if ((person === undefined) === (count === undefined)) return "Not recorded: give a person, or a count, one of them.";
          const out = await results.record(customerId, { stage, person: person ?? null, count: count ?? 1, url: url ?? null, evidence, source });
          const all = summarizeResults(await results.list(customerId, 300));
          const day = (t: Date): string => t.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: tz ?? "UTC" });
          return (
            `${out.added ? "On record" : "Already on record"}: ${person ?? `${count} ${STAGE_WORDS[stage]}`}. ` +
            `Results now: ${all.map((s) => `${STAGE_WORDS[s.stage]} ${stageWords(s, day)}`).join("; ")}.`
          );
        },
        {
          name: "record_result",
          description:
            "Put a result on record, only with evidence: someone talking with them (answered a reply, wrote back to a message), trying what they sell, " +
            "using it, paying. A person (u/name, a name) once per stage; or a count they or a source gave you (\"3 trials this week\", \"no paying users yet\" is 0). " +
            "seen: you read it yourself; told: they told you. Activity (places found, posts up) is never a result.",
          schema: z.object({
            stage: z.enum(RESULT_STAGES),
            person: z.string().min(2).max(120).optional(),
            count: z.number().int().min(0).max(1_000_000).optional(),
            url: z.string().max(2000).optional(),
            evidence: z.string().min(5).max(300).describe("What shows it, in a line: their words, or what the customer told you."),
            source: z.enum(["seen", "told"]),
          }),
        },
      ),
    );
  }

  if (d.routes) {
    const routes = d.routes;
    tools.push(
      tool(
        async ({ route, result, note }) => {
          const r = await routes.log(customerId, route, result, note);
          if (r.status === "spent") {
            return (
              `"${r.name}" has not worked ${r.misses} times in a row: it is spent. Change course now, without waiting to be told: pick another route, ` +
              "rewrite your plan, and tell them plainly in a line that it didn't get anywhere and what you are doing instead. Go back to it only with new evidence."
            );
          }
          return `"${r.name}": ${r.tries} ${r.tries === 1 ? "try" : "tries"}, ${r.wins} worked${r.misses ? `, the last ${r.misses} did not` : ""}.`;
        },
        {
          name: "log_try",
          description:
            "Log how a try on one of your routes went (a route is a way you go after results: \"Reddit replies\", \"caregiver communities\", \"DMs to people who asked\"). " +
            "worked: it got people talking, trying or keeping finds; thin: it ran but brought little; failed: it got nothing or was taken down. " +
            "Use the same name as on your board. Two in a row that do not work spend the route.",
          schema: z.object({
            route: z.string().min(3).max(120),
            result: z.enum(ROUTE_RESULTS),
            note: z.string().min(3).max(300).describe("What happened, with the numbers."),
          }),
        },
      ),
    );
  }

  tools.push(
    tool(
      async ({ count }) => {
        const now = d.now();
        const people = await d.finds.best(customerId, count ?? 5);
        if (!people.length) return "Nobody found yet.";
        const out = [`${BEST_PEOPLE} (${people.length}), best first:`, ...people.map((f) => personLine(f, now))].join("\n");
        d.read.push(out);
        d.onShortlist?.(out);
        return out;
      },
      {
        name: "best_people",
        description:
          "The best people found so far, with their words, why they fit, how fresh, where they stand, and the link: for a shortlist, a next step or a check. " +
          "Kept and replied ones first, then strong ones.",
        schema: z.object({ count: z.number().int().min(1).max(10).optional() }),
      },
    ),
  );

  const theirs = d.theirs ?? [];
  if (theirs.length) {
    let reacted = false;
    tools.push(
      tool(
        async ({ emoji, to }) => {
          if (reacted) return "One reaction a turn.";
          const e = reactionEmoji(emoji);
          if (!e) return `Not one to use: pick from ${REACTIONS.join(" ")}.`;
          const words = to?.trim().toLowerCase();
          const message = (words ? theirs.filter((m) => m.text.toLowerCase().includes(words)) : theirs).at(-1);
          if (!message) return "None of their messages this turn has those words.";
          const had = (d.before ?? []).find((x) => x.direction === "in" && x.ref === message.ref);
          const refusal = reactionRefusal(e, { text: message.text, reaction: had?.reaction ?? null }, d.before ?? []);
          if (refusal) return `No reaction: ${refusal}.`;
          if (!(await d.messenger.react(customerId, message.ref, e))) return "No reaction: there is no chat to put it in.";
          reacted = true;
          d.onReacted?.(e);
          return "Reacted. If your reply would only say you understood, leave it out: end with nothing, the reaction says it.";
        },
        {
          name: "react",
          description:
            "Put one emoji reaction on their message, the way a friend would: 👍 for a clear instruction (instead of replying \"got it\"), 🎉 or 🔥 for a win, " +
            "❤ or 🙏 for something kind, 😁 for a joke, 😢 for bad news. Only when it adds something, chosen from what the message means: not on every message, " +
            "not on routine questions, never as well as a reply that says the same. When they sent several, `to` is a few of the words of the one you react to.",
          schema: z.object({ emoji: z.string().min(1).max(16), to: z.string().max(80).optional() }),
        },
      ),
    );
  }
  return tools;
}
