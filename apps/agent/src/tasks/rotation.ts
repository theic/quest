import { WORDLESS, type Customer, type CustomerId, type Draft, type Logger, type ResultEntry, type Task } from "@mq/core";
import { contactSite } from "../contacts/handles.ts";
import { pickedPlatforms } from "../conversation/intake.ts";
import { draftPlatform } from "../drafts/day-limits.ts";
import type { Loop } from "../lifecycle/idle-sleeper.ts";
import { isModelLimit } from "../lib/model-rest.ts";
import { pauseFor } from "../lib/pause.ts";
import { limitKind, PLATFORMS, type Platform } from "../platforms.ts";

/**
 * Always exploring (the founder, 2026-11-04: "I want the bot to be much more active than it is, exploring all the time.
 * All socials, except Reddit for now"). While their Chrome is open and fewer of their runs are at work than they may
 * have, code starts the next one, with no model deciding it: the outreach teammate, kept to the platform of theirs
 * worked least lately. The manager's own starts still go to what it means to try; this keeps the gaps between them
 * full. Overnight, a heartbeat look that chose to wait rested three hours, and nothing ran from 00:38 to 07:23.
 *
 * A platform is passed over while a run is at work there, for a rest after its last run started (`SITE_REST_MS`), while the
 * likes and follows of its day are spent, while `CARDS_WAITING` cards of it wait on their tap, for `WALL_REST_MS` after
 * a run there met a sign-in wall or two failed, for `EMPTY_REST_MS` after two that found nobody or three that put nothing
 * up, and when they ruled it out (a place filed as avoid).
 */

/** How often it looks for a free slot. */
export const ROTATION_EVERY_MS = 30_000;
/** The rest between two runs started on one platform: drawn between these, from the run it follows. */
export const SITE_REST_MS: readonly [number, number] = [8 * 60_000, 25 * 60_000];
/**
 * After any run of theirs started or ended, the next waits a breather drawn from it, as a person between two things:
 * their slots are never refilled on the tick a run ended. Live, 2026-11-06: at 2 to 12 minutes, after runs of 2 or 3,
 * Quest was at work 30% of the day (the founder: "It should be working every minute between the organic pauses").
 */
export const BREATHER_MS: readonly [number, number] = [10_000, 60_000];
/** Cards of one platform waiting on their tap past which another run there only adds to the pile. */
export const CARDS_WAITING = 6;
/**
 * The manager's day of starts while always exploring: the rotation's runs count in it too (every task since they last
 * wrote does), about ten an hour round the clock, with room for the manager's own beside them.
 */
export const EXPLORING_STARTS_A_DAY = 400;
const DAY_MS = 86_400_000;
/** A platform whose last run met a sign-in wall, or whose last two failed, rests this long: only they can sign in. */
export const WALL_REST_MS = 12 * 3_600_000;
/** A platform whose last two runs found nobody rests this long (2026-11-04: TikTok's fresh posts were creators'). */
export const EMPTY_REST_MS = 3 * 3_600_000;
/** How many of their runs the rotation looks back over: enough for a day and more. Live, 2026-11-07: it looked at the
 * last 30, about 3 hours of runs, so a sign-in wall's 12 hours fell out of view and Discord ran into it every 3 hours. */
export const LOOK_BACK = 400;
/** With nothing to start, their lists are read again this much later, not at every look (the database's egress). */
export const IDLE_LOOK_MS = 90_000;
/** How a run says it found nobody, and that it met a sign-in wall (live, 2026-11-04: Telegram's "I reached nobody this
 * run", Discord's "isn't signed in to discord.com. It redirects to the login page"; 2026-11-07: "Discord is asking for a
 * sign-in", "showed its sign-in page", "the session has expired"). */
const NOBODY = /\b(nobody|no one)\b[^.\n]{0,40}\bfits?\b|engaged (nobody|no one)|didn't engage anyone|(found|reached) (nobody|no one)|(nobody|no one) (was|were) reached|saved nothing/i;
const SIGNED_OUT = /(not|n't) (signed|logged) in|signed out|logged out|sign-in wall|login wall|log in to (see|continue)|asks? (them )?to sign in|redirects to the (login|log-in|sign-in) page|ask(s|ed|ing)? for a sign-in|(showed|shows) (its|the|a) (login|log-in|sign-in) page|session (has )?expired/i;
const ACTIVE = new Set(["queued", "running", "waiting"]);
/** How a platform's own run is titled, and how long a busy line may keep one from starting. */
const NEEDS = ": people who need what they built";
const STARVED_MS = 45 * 60_000;

export interface RotationDeps {
  /** Customers whose Chrome is open now. */
  readonly online: () => readonly CustomerId[];
  readonly customers: { get(id: CustomerId): Promise<Customer> };
  readonly tasks: {
    list(customerId: CustomerId): Promise<Task[]>;
    /** How many of their runs are at work, asked before the whole list is read: most looks end here. */
    atWork?(customerId: CustomerId): Promise<number>;
    start(customerId: CustomerId, agent: string, title: string, instructions: string, site: string | null, priority?: number): Promise<Task>;
  };
  readonly drafts: { recent(customerId: CustomerId, limit: number): Promise<Draft[]> };
  /** What came of it (mq.results): where people answered, the work goes more often. */
  readonly results?: { list(customerId: CustomerId, limit: number): Promise<ResultEntry[]> };
  readonly places: { listFor(customerId: CustomerId): Promise<readonly { readonly key: string; readonly verdict: string }[]> };
  /** The people on a site to come back to, a line each (contacts/acquaintances.ts): a run starts with them. */
  readonly people?: { comeBack(customerId: CustomerId, site: string): Promise<string[]> };
  /** Until when they rest (the day's limit, credits), or null. */
  readonly restingUntil: (customerId: CustomerId) => Promise<Date | null>;
  /** Until when the models take no calls (lib/model-rest.ts), or null: nothing is started to fail on it. */
  readonly modelsRest?: () => Date | null;
  /** Figures of their last week, counted from the records, a line each: what a post of their own may brag with. */
  readonly numbers?: (customerId: CustomerId) => Promise<string | null>;
  /** Whether something of theirs is going up now or is due (the outbox): it goes first, then the next run. */
  readonly sending?: (customerId: CustomerId) => Promise<boolean>;
  /** Runs of theirs that may be at work at once. */
  readonly perCustomer: number;
  /** Only the runs that answer people (config ANSWER_ONLY): no platform's outreach, posts or other extras. */
  readonly answerOnly?: boolean;
  readonly now: () => Date;
  readonly log: Logger;
}

/** The site a platform's runs are kept to: the address start_task's `site` takes. */
export const siteFor = (p: Platform): string => p.hosts[0]!;

/** Why a platform is passed over now, or null when a run may start there. */
export function passedOver(p: Platform, x: { tasks: readonly Task[]; drafts: readonly Draft[]; avoided: ReadonlySet<string>; now: Date; results?: readonly ResultEntry[] }): string | null {
  if (p.hosts.some((h) => x.avoided.has(h)) || x.avoided.has(p.key)) return "they ruled it out";
  const here = x.tasks.filter((t) => t.site && PLATFORMS.find((q) => q.hosts.some((h) => t.site === h || t.site!.endsWith(`.${h}`)))?.key === p.key);
  if (here.some((t) => ACTIVE.has(t.status))) return "a run is at work there";
  const last = here.reduce<Task | null>((a, t) => (!a || t.createdAt > a.createdAt ? t : a), null);
  if (last && x.now.getTime() - last.createdAt.getTime() < pauseFor(last.id, ...SITE_REST_MS)) return "a run started there lately";
  // A run the models' own limit ended says nothing about the site (live, 2026-11-10: it rested every site 12 hours).
  const ended = here.filter((t) => t.finishedAt && !(t.status === "failed" && isModelLimit(t.error)) && x.now.getTime() - t.finishedAt.getTime() < WALL_REST_MS).sort((a, b) => b.finishedAt!.getTime() - a.finishedAt!.getTime());
  if (ended[0]?.result && SIGNED_OUT.test(ended[0].result)) return "their last run there met a sign-in wall";
  if (ended.slice(0, 2).length === 2 && ended.slice(0, 2).every((t) => t.status === "failed")) return "its last two runs failed";
  const lately = ended.filter((t) => x.now.getTime() - t.finishedAt!.getTime() < EMPTY_REST_MS).slice(0, 2);
  if (lately.length === 2 && lately.every((t) => t.result && NOBODY.test(t.result))) return "its last two runs found nobody";
  // Live, 2026-11-06: 21 runs in a day on Telegram and Discord put nothing up, each said so in other words. Where people
  // answered this week it never rests so: X went three hours without a run, the very site likes were widened for.
  const last3 = ended.slice(0, 3);
  if (last3.length === 3 && x.now.getTime() - last3[0]!.finishedAt!.getTime() < EMPTY_REST_MS && !last3.some((t) => x.drafts.some((d) => draftPlatform(d).key === p.key && d.createdAt >= t.createdAt && d.createdAt <= t.finishedAt!)) && !howItWent(p, { drafts: x.drafts, results: x.results ?? [], now: x.now }).answered) return "its last three runs put nothing up";
  const mine = x.drafts.filter((d) => draftPlatform(d).key === p.key);
  const day = x.now.getTime() - DAY_MS;
  const acted = mine.filter((d) => limitKind(d.kind) === "actions" && d.status === "posted" && (d.sentAt?.getTime() ?? 0) > day).length;
  if (p.limits.actions > 0 && acted >= p.limits.actions) return "the day's likes and follows there are spent";
  if (mine.filter((d) => d.status === "open").length >= CARDS_WAITING) return "its cards wait on their tap";
  return null;
}

/** Whether the last run of theirs to start or end did so too lately for the next to start: a breather drawn from it. */
export function catchingBreath(tasks: readonly Task[], now: Date): boolean {
  const moved = (t: Task): number => Math.max(t.createdAt.getTime(), t.finishedAt?.getTime() ?? 0);
  const last = tasks.reduce<Task | null>((a, t) => (!a || moved(t) > moved(a) ? t : a), null);
  return Boolean(last && now.getTime() - moved(last) < pauseFor(`${last.id}|${moved(last)}`, ...BREATHER_MS));
}

/** How far back how a platform went is counted, and how many words up there with nobody answering make it quiet. */
export const HOW_IT_WENT_MS = 7 * DAY_MS;
export const QUIET_AFTER = 5;
/**
 * How much sooner a platform where people answered comes round again, and how much later one that stays quiet: the
 * time since its last run counts this many times over. Live, 2026-11-04: 13 people answered on X and nobody on
 * Threads, Instagram, TikTok or LinkedIn, and the rotation still gave each its equal turn.
 */
export const ANSWERED_WEIGHT = 3;
export const QUIET_WEIGHT = 0.5;
/**
 * Platforms being warmed up get turns twice as often, quiet or not (the founder, 2026-11-14: "We also need to warm up
 * Telegram, You Tube").
 */
export const WARMING: ReadonlySet<string> = new Set(["telegram", "youtube"]);
export const WARMING_WEIGHT = 2;
export const TELEGRAM_WEIGHT = 4;

/** How a platform went this week: the words of theirs that went up there (replies, messages, posts), and who answered. */
export interface HowItWent {
  readonly sent: number;
  readonly answered: number;
}

const onPlatform = (p: Platform, url: string | null | undefined): boolean => {
  try {
    const host = new URL(url ?? "").hostname.replace(/^www\./, "");
    return p.hosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
};

export function howItWent(p: Platform, x: { drafts: readonly Draft[]; results: readonly ResultEntry[]; now: Date }): HowItWent {
  const since = x.now.getTime() - HOW_IT_WENT_MS;
  const sent = x.drafts.filter((d) => draftPlatform(d).key === p.key && !WORDLESS.has(d.kind) && d.kind !== "profile" && d.status === "posted" && (d.sentAt?.getTime() ?? 0) > since).length;
  const answered = new Set(x.results.filter((r) => r.stage === "conversation" && r.at.getTime() > since && onPlatform(p, r.url)).map((r) => r.evidence.toLowerCase())).size;
  return { sent, answered };
}

/** How it went, in a line for the run's opening, so it does more of what got answers there; null with nothing to say. */
export function wentLine(p: Platform, w: HowItWent): string | null {
  if (w.answered) return `How ${p.name} went this week: ${w.sent} of their words went up and ${w.answered} ${w.answered === 1 ? "person" : "people"} answered. People answer here: do more of what got them talking (the people your opening names first, then the same kind of people and the same kind of word).`;
  if (w.sent >= QUIET_AFTER) return `How ${p.name} went this week: ${w.sent} of their words went up and nobody answered. Change something this time: other people (fresher posts, fewer replies under them), or another kind of word (a reaction to what they made rather than advice).`;
  return null;
}

/**
 * The platform of theirs to work next: the one longest without a run (never worked first, in the order they gave),
 * that time counted `ANSWERED_WEIGHT` times over where people answered this week and `QUIET_WEIGHT` where they stayed
 * quiet, so the work goes where it gets answers and the rest still get their turn.
 */
export function nextPlatform(
  picked: readonly Platform[],
  x: { tasks: readonly Task[]; drafts: readonly Draft[]; avoided: ReadonlySet<string>; now: Date; results?: readonly ResultEntry[] },
): Platform | null {
  const lastRun = (p: Platform): number =>
    Math.max(0, ...x.tasks.filter((t) => t.site && p.hosts.some((h) => t.site === h || t.site!.endsWith(`.${h}`))).map((t) => t.createdAt.getTime()));
  const weight = (p: Platform): number => {
    const w = howItWent(p, { drafts: x.drafts, results: x.results ?? [], now: x.now });
    // Telegram's groups get the most turns (the founder, 2026-11-14: "more focus on Telegram groups, we had a message
    // successfully sent that is a good start").
    if (p.key === "telegram") return TELEGRAM_WEIGHT;
    if (WARMING.has(p.key)) return Math.max(WARMING_WEIGHT, w.answered ? ANSWERED_WEIGHT : 0);
    return w.answered ? ANSWERED_WEIGHT : w.sent >= QUIET_AFTER ? QUIET_WEIGHT : 1;
  };
  const due = (p: Platform): number => (lastRun(p) ? (x.now.getTime() - lastRun(p)) * weight(p) : Number.POSITIVE_INFINITY);
  const open = picked.filter((p) => !passedOver(p, x));
  return open.map((p, i) => ({ p, i, due: due(p) })).sort((a, b) => b.due - a.due || a.i - b.i)[0]?.p ?? null;
}

/**
 * Telegram has no search across people's posts and shows a group only to its members (live, 2026-11-11: 51 runs in a
 * week reached nobody: "find_people doesn't cover Telegram", the one builders' group not joined, their Russian-language
 * founders' chat passed over as not English). So: the chats they are in, searched by the chat's own search; public
 * channels and their comments; and groups worth joining, named for them.
 */
/** Joining a group or a server: Quest's when they said so, else theirs. */
const JOINING =
  "Joining: when what they decided says Quest may join groups itself, join the ones that fit (a public group or server where people who build things talk in their own words: founders, a tool's users, developers, investors; not a channel of announcements), up to 5 a run: open it and press its Join button, read its pinned rules, and work it in this same run. A group whose last screens are only \"joined the group\" notices, or that says sending messages is not allowed, is dead: leave it at once and go to the next (live, 2026-11-13: the first one Quest joined was such). After Join the page may look the same for a moment: look again once, and \"You joined the group\" means it is done. Say in your report which you joined. With no such decision, press nothing: end your report with up to 3 worth joining, each with its link, its size and one line on who talks there.";
/** Who gets a word in a group chat, which is wider than a feed: anyone building something who can be helped today. */
const IN_A_GROUP =
  "In a group, A is wider: any builder who asks anything you can help with today (how to get users, feedback on what they made, which tool, why nobody signs up), or shares what they built and gets no answer. Answer in the group, as a member would: the help itself in a line or two, never a pitch, no link unless they ask. Up to 6 replies a run, in different chats or to different people, never two in a row in one chat. They need no like first and no note before the word; keep the ones who fit with note_person after, with the plan.";
const TELEGRAM_STEPS: readonly string[] = [
  "1. The groups they are in (web.telegram.org/a/, the chat list): every one where founders, builders or the product's people talk, in any language their own chats are in, never only English. Open a chat by clicking its row; if the page stays as it was, open its address instead (web.telegram.org/a/#<the id in the row's link>, or #@<name>). Read its last two days and use the chat's own search (the magnifier at its top) for the words such people use (first users, no signups, how do you get, feedback, any tool for; in that chat's language). Their message is their post: draft a reply to it in the group (outreach_draft kind reply, the chat's address, the person as target, their words as the quote).",
  IN_A_GROUP,
  "1b. New places, every run, since most of the chats they are in are channels where only the owner writes (live, 2026-11-13: a web search kept to t.me found no group at all). Telegram's own search is the way: type into the search box at the top of the chat list, one at a time, at least eight, and other ones than the last run's searches: founders, startup chat, indie hackers, solo founders, SaaS, build in public, no-code, makers, side project, product launch, стартап, фаундери, and the customer's niche; and wider than founders, people who build with a tool and big communities where builders or investors hang out: Lovable, Bolt, Cursor, Claude, ChatGPT, vibe coding, вайбкодинг, AI agents, n8n, automation, Replit, Supabase, Next.js, indie dev, web dev chat, product managers, growth, marketing chat, angels, investors, VC, web3 builders, hackathon, нейросети чат, разработчики чат. A big chat of a tool's users counts: people there ship things and ask how to get users. Its results list public groups and channels with their size under \"Global search\": open the ones that are groups (members, not subscribers) with people writing this week. And Google, which knows far more groups than Telegram shows: browser_open https://www.google.com/search?q=<words> (telegram group for startup founders, indie hackers telegram chat, SaaS founders t.me, build in public telegram, фаундери чат телеграм), two or three searches, then open each t.me link it gives. And the catalogues of Telegram chats, which list groups by topic with their size and how much is written there: browser_open https://tgstat.com/en/search?q=<word> or https://combot.org/top/telegram/groups (also telemetr.io, tdirectory.me), and open the t.me link of each group with people writing this week. Also the archived chats (the Archived row at the top of the list), and t.me/solofounders if it is still there. A public channel's posts are read with no sign-in at t.me/s/<name>; where a channel has comments, open a fresh post's comments: its readers talk there, and a comment is a reply like any other.",
  `1c. ${JOINING}`,
  "The one or two who fit best and whose profile takes messages: a private message after the reply in the group, giving something and asking for nothing.",
];
/** Discord is read by hand: its search covers one server, and people talk in channels. */
const DISCORD_STEPS: readonly string[] = [
  "1. The servers they are in (discord.com/channels/@me, the list on the left): in each, the channels where people write in their own words (general, help, feedback, showcase, launches, introductions, marketing, growth; never a read-only feed of a bot's summaries). Read the last two days of each and use the server's search for the words such people use (first users, no signups, feedback, how do you get). Their message is their post: draft a reply to it in the channel (outreach_draft kind reply, the channel's address, the person as target, their words as the quote). A channel in slow mode takes one message, so make it the best one.",
  IN_A_GROUP,
  "1b. New servers: discord.com/servers and Google: browser_open https://www.google.com/search?q=<words> (discord server for indie hackers, SaaS founders discord, build in public discord; and the servers of the tools people build with: Lovable, Bolt, Cursor, Claude, Replit, Supabase, n8n, vibe coding), two or three searches, and disboard.org/servers/tag/<word>, then open the discord.gg or discord.com/invite links it gives.",
  `1c. ${JOINING} A server that asks for a phone, a payment or a captcha to get in is left alone.`,
];

/**
 * What the run is asked: first the people it met there before and should come back to (connected a day ago, or spoken
 * to and not yet helped), then new ones the playbook finds, on that platform, met the way a founder makes friends with
 * other founders: connect, warm up, then help (the founder, 2026-11-04: "get to know them slowly").
 */
export function rotationBrief(p: Platform, comeBack: readonly string[] = [], went: string | null = null): { title: string; instructions: string } {
  return {
    title: `${p.name}${NEEDS}`,
    instructions: [
      `Work ${p.name} for them as the one who sells their product: every word that goes out has a purpose, and you know the next two steps before you send the first. Likes and follows are the second job.`,
      "A. The people the product is for (the brief says who, and which problem of theirs it solves): someone who says in their own post, in the last day or two, that they have that problem now, or asks for such a thing. For a product that gets a founder's work seen, that is a founder who needs customers and says so: launched and nobody came, asks how to get first users or beta testers, is tired of doing outreach by hand; someone who only announces a launch is not one. Words go to these, and the first word is help they can use today, not a compliment: one or two people who want what they built (customers_for, with the links), or the one thing on their site that loses a visitor.",
      "Plan each of them three steps ahead and keep it with note_person (plan): 1. what this opener gives them and why they would answer; 2. what you say when they answer (that finding such people is what the customer does all day, with a thing they are building, described in plain words, no name and no link); 3. what you ask for in the end (that they try it on their own product: the name and the link once they ask how). An opener with no step 2 and 3 is not sent.",
      "B. Fellow builders sharing what they make: a like or a follow in passing, which keeps the account warm and seen. No words unless they ask for feedback. Everyone your searches turn up is kept in the pool by code, fit or not: do not stop to note the ones who do not fit, go on to the next.",
      // The founder, 2026-11-18: "Focus on ICP, not how big the account is".
      "Pick by fit, never by size: a founder with forty followers who sells something (a price, a waitlist, a product page) and says they need users is worth more than a big account or a popular post. Hobby projects with nobody to sell to (a game jam entry, fan art, a toy repo) and people who only post about building are B, however many follow them.",
      "Whoever plainly uses what the product runs on fits better (the brief says where it lives: for one that lives in Telegram, a t.me link in their bio or on their site, a channel or a bot of their own). Prefer them among A, and say it in note_person.",
      ...(went ? [went] : []),
      // Code watches replies, not private messages (live, 2026-11-13: Dhruv answered "I would absolutely love those links!"
      // on LinkedIn, and runs read his message five times without a word back).
      ...(p.limits.messages > 0
        ? [`0. Before anything else, open their messages on ${p.name} (the platform map says where). Anyone whose last message there is to them, answering one of theirs, gets an answer in this run (outreach_draft kind message, to their profile): give what was offered, finding it now if it was not found yet (customers_for for people, or the places such people really gather, true and named), and keep their plan with note_person. Never a promise of something you do not have.`]
        : []),
      ...(comeBack.length
        ? [`0. First, people met here before, to come back to (open each one's newest post, then take the next step named; skip one with nothing new):\n${comeBack.join("\n")}`]
        : []),
      ...(p.key === "telegram"
        ? TELEGRAM_STEPS
        : p.key === "discord"
          ? DISCORD_STEPS
        : [`1. Look for new ones on ${p.name}, A first: find_people where it covers the site, with a play that names the problem in the words such people use (else the site's newest search, its communities, or a web search with site: on it), past the people already reached and the searches that found nobody.`]),
      `2. Likes and follows are nearly free, so be generous with them: like the post of everyone real who shares what they make (find_people's "Worth a like" list, and anyone you read here), up to 15 likes a run, and follow the ones whose profile you read and who build something, up to 8. A like or a follow needs no check and no note.`,
      // The founder, 2026-11-18: "Shuffle prospecting with casual conversations and simple reactions for organic activity".
      `2b. Between the openers, be a person there, not only someone who prospects: up to ${CASUAL_A_RUN} casual replies a run (outreach_draft kind reply with casual true) under fresh posts you read on the way, from people in their field: a word or two or one emoji about what they said, as a passer-by would. No question, no tip, no purpose, nothing about work or the product, never under a post that is sad or serious. Spread them between the openers, not all at once.`,
      `3. Words are different, and they go to A. For the ones who fit best, up to 5: check them properly (their profile and what they posted before, their site when it names one with read_site, pages 3, tried as a visitor would: what its first screen says, what is unclear or broken; their listing where they launched), keep it with note_person, and write only where it adds something: an answer to what they asked, the one thing you noticed that helps them, or a real question about what they are stuck on.${p.limits.messages > 0 ? " The one or two who fit best (what they are after is what the customer gives, and your note says how): a private message (outreach_draft kind message, to their profile) once you are connected, to start a real conversation." : ""}`,
      "4. Keep going: after each search, run the next one with the problem said another way (other words, another kind of founder who needs customers, a launch word like beta testers, first users, just launched, feedback wanted), at least six different searches a run, more while they turn up new people. Stop only when three in a row turned up nobody new: never the same search twice. Stay on this site. (Answers to what went up before are read by code, and the manager hears them.)",
      "End with who you reached and what went up, one line each.",
    ].join("\n"),
  };
}

/**
 * What the rotation does besides the platforms' turns, so their Chrome is never idle and the work is not only replies
 * (the founder, 2026-11-11: "no idle is allowed when the agent is active ... every possible channel must be explored ...
 * if socials are filled, use google, gmail etc. Let the agent find and suggest new platforms ... read analytics of each
 * platform to understand what works ... more of actual posts"). Each is a run like any other, known by its title, due
 * `every` so long after its last one started; `filler` ones also run whenever no platform is open.
 */
export interface Extra {
  readonly title: string;
  readonly agent: "outreach" | "explorer";
  readonly site: string | null;
  readonly every: number;
  readonly filler?: boolean;
  readonly instructions: string;
}

const HOUR = 3_600_000;
/** Casual replies a run: a word or a reaction under a post read on the way, so the account is not only openers. */
export const CASUAL_A_RUN = 3;
/** A filler run comes again no sooner than this after its last one started. */
export const FILLER_REST_MS = 25 * 60_000;
/** A post of their own on a platform: this far apart, while its day has posts left and none waits on their tap. */
export const OWN_POST_EVERY_MS = 6 * HOUR;
/** Why a platform is passed over that still lets a post of their own be written there. */
const STILL_POSTS = new Set(["a run started there lately", "its last two runs found nobody", "its last three runs put nothing up", "the day's likes and follows there are spent"]);

/**
 * Where a post of their own is not written by the rotation: Reddit's posts are the manager's, and these take a picture
 * or a video, never words alone (live, 2026-11-11: a text post drafted for Instagram and one for TikTok could not go up).
 */
// Medium too, for now: its new-story editor is one box holding the title and the story, a fill puts every line into the
// title and leaves the story empty, so no story could be published (measured in their Chrome, 2026-11-14).
const NO_TEXT_POSTS = new Set(["reddit", "instagram", "tiktok", "youtube", "pinterest", "email", "telegram", "whatsapp", "discord", "medium"]);

/**
 * What a post of their own is, drawn in code each run (a model asked to vary settles on one): live, 2026-11-13, their
 * Threads showed four "Anyone learning X? I know people who built apps for it" in a day, and the founder: "This wall of
 * similar posts is a bit concerning, need some fun ones too". Finding a kind of person stays the most common.
 */
export const POST_FORMS: readonly { readonly weight: number; readonly steps: string }[] = [
  { weight: 3, steps: "" },
  // The shape that drew three builders on LinkedIn in a day (2026-11-13: "If your site went down tonight, how long until you'd notice?").
  { weight: 3, steps: `This one asks the reader about a risk of their own. Call who_is_wanted first and pick a problem several people built a fix for this week. Open with one question that puts the reader in the bad moment ("If your site went down tonight, how long until you'd notice?"), then a line or two saying, with no names, that they met a few people this week who built for exactly that, and end by offering to pass names along to whoever replies. No link, no list, nothing about their own product. Never the same problem as a post of theirs this week.` },
  { weight: 2, steps: `This one is fun, not a search: a light question other builders enjoy answering, from the life of building something alone (the bug that ate a whole day, the feature nobody used, the tab that is always open, what they do while it deploys). Their voice, a little self-mocking if it fits, an emoji only if it adds something. Nobody is introduced, nothing is sold, and it is not a "who here..." search.` },
  // The founder, 2026-11-18: "Invite people to a thread, let them comment their project link and generate prospects for
  // each one as a reply. They can come to us and we can come to them."
  { weight: 4, steps: `This one is a link thread: invite builders to reply with the link to what they are building and whom it is for, and promise something real for it: each one who replies gets people who are asking for just that, found for them this week (what the customer does all day, given away once; the comments run finds them with page_for and answers each with their page). Say it plainly and warmly, the way a person would on ${"{site}"}, in new words each time, never "drop your link 👇". It may say in a few words that finding such people is what they build.` },
  // "Brag in posts about our wins; write posts about the features ... that make it work; write about our analytics".
  { weight: 2, steps: "This one is a win: one thing that went well for them or their product this week, told as it happened, glad about it and specific (a number, a person's words, what changed), as the numbers below, their lessons and their brief tell it. It may name their product once. Nothing made up, no lesson thread." },
  { weight: 2, steps: "This one is about one thing their product does that makes it work, from their brief and their site: one feature, what it is in plain words, the moment it matters, how it came to be built. A different feature than any post of theirs this month. It may name their product once, with no link. Told by the person who built it, not as an ad." },
  { weight: 2, steps: "This one is their numbers, in the open: two or three figures from the numbers below (only those, exactly as counted, never rounded up), what they say about the last week, and one honest thing the numbers do not show yet. Builders like real figures. It may name their product once. With no numbers below, write a small true moment from their week instead." },
  { weight: 1, steps: "This one is a small true moment from their own week of building, as their brief, decisions and lessons tell it: one thing that happened, told plainly, with a question at the end only if it is a real one. Nothing made up, no lesson thread, no hype, no product name." },
  { weight: 1, steps: "This one is an opinion: one short, honest take about building or launching that some builders would disagree with, said as theirs and open to being wrong. Nothing about their product, no thread." },
];

/** Tags on a post of their own (the founder, 2026-11-18: "Always use different tags to better attract audience"). */
const TAGS =
  "End it with two or three hashtags the people it is for follow there (their kind of work, the problem, the stage they are at), on a line of their own, and never the same set as any post of theirs you read on their profile: other tags reach other people. None on a site where posts carry none (Hacker News, Indie Hackers, Peerlist).";

function drawForm(random: () => number = Math.random): string {
  const total = POST_FORMS.reduce((n, f) => n + f.weight, 0);
  let at = random() * total;
  for (const f of POST_FORMS) if ((at -= f.weight) < 0) return f.steps;
  return "";
}

export function ownPost(p: Platform): Extra {
  const search = [
      `Write one post of their own for ${p.name} that finds a specific kind of person (the founder, 2026-11-12: "the actual posts must be about finding specific types of people, not random"). Not a reply, not a pitch, nothing about their own product.`,
      "1. Call who_is_wanted: the kinds of people several builders are looking for this week, and the kinds of maker several people ask for, each with a question a post could ask.",
      "2. Open their own profile there and read what they posted lately, with what each got (views, likes, replies, as the page shows): never ask for the same kind of person twice in a week, and write more like what people answered.",
      `3. Pick the kind that fits ${p.name}'s people best and write the post as a question that makes them speak up ("Anyone learning a language right now? I know a few people who just built apps for it."). It may say they know people building it, or people looking for it; it names nobody and has no link and no list. Whoever answers gets the introduction as a reply, and that is how people learn the customer knows who builds what.`,
      "4. Nothing wanted this week: one true thing from their brief or what happened this week instead, as a real question to other founders. Nothing made up, no advice thread, no hype.",
      `5. Draft it with outreach_draft, kind post, in their voice, as short as posts read here. ${TAGS} One post; if one of theirs already waits on a card here, change nothing and say so.`,
      "End with the post's words, whom it looks for and who is waiting for them.",
    ].join("\n");
  return {
    title: `${p.name}: a post of their own`,
    agent: "outreach",
    site: siteFor(p),
    every: OWN_POST_EVERY_MS,
    // Drawn afresh each time the run is started.
    get instructions() {
      const form = drawForm().replace("{site}", p.name);
      if (!form) return search;
      return [
        `Write one post of their own for ${p.name}. Not a reply, not a pitch, nothing about their own product. ${form}`,
        "Open their own profile there first and read what they posted lately, with what each got (views, likes, replies, as the page shows): it must not read like any of them, in its opening words or its shape, and should sound more like the ones people answered.",
        `Draft it with outreach_draft, kind post, in their voice, as short as posts read here, no link. ${TAGS} One post; if one of theirs already waits on a card here, change nothing and say so.`,
        "End with the post's words and why this one.",
      ].join("\n");
    },
  };
}

/** How a run that answers who waits is titled, after its platform. */
const WAITS = ": who is waiting for an answer";
/** How often a platform's waiting people are looked at: sooner while the records name someone. */
export const WAITING_EVERY_MS = 2 * HOUR;
/**
 * With nobody named, the run is only a look at their private messages, which no watch reads: twice a day. Live,
 * 2026-11-18: at 6 h a platform these and the comment runs were half of all runs (26 of 53 in a night), most of them
 * opening notifications the watch had read minutes before. Live, 2026-11-19: twice a day on every platform was 19 runs
 * and about 6M tokens a day, and 2 words went up; every two days now.
 */
export const INBOX_EVERY_MS = 48 * HOUR;
const WAITING_DAYS = 4;
const LISTS = /notifications|\/activity|mentions|\/feed\/?$|\/inbox/;

/**
 * Who answered on a platform in the last days and has had nothing back since, each with their latest words. Read from the
 * records, by code (the founder, 2026-11-14: "you sometimes are more aware of which people are waiting for replies than
 * the Quest itself"). An answer was told to the manager once, as an event, and nothing looked again: a yes to "want the
 * link?" on X, a builder who answered their own LinkedIn post with his product and two questions about Quest sat for
 * one to two days.
 */
export function waitingOn(p: Platform, x: { drafts: readonly Draft[]; results: readonly ResultEntry[]; now: Date }): { person: string; said: string; at?: string }[] {
  const since = x.now.getTime() - WAITING_DAYS * DAY_MS;
  const latest = new Map<string, ResultEntry>();
  for (const r of x.results) {
    if (r.stage !== "conversation" || !r.person || r.at.getTime() < since || !onPlatform(p, r.url)) continue;
    const key = r.person.toLowerCase();
    if (!latest.has(key) || latest.get(key)!.at < r.at) latest.set(key, r);
  }
  const mine = x.drafts.filter((d) => draftPlatform(d).key === p.key && (d.status === "posted" || d.status === "open" || d.status === "uncertain" || d.status === "posting"));
  return [...latest.values()]
    .filter((r) => {
      const said = r.evidence.replace(/^[^"]*"/, "").slice(0, 30).toLowerCase();
      const first = r.person!.replace(/^@/, "").split(/\s+/)[0]!.toLowerCase();
      return !mine.some(
        (d) =>
          (d.sentAt ?? d.createdAt).getTime() > r.at.getTime() - 5 * 60_000 &&
          ((r.url !== null && !LISTS.test(r.url) && d.url === r.url) ||
            (first.length >= 3 && `${d.author ?? ""} ${d.target ?? ""}`.toLowerCase().includes(first)) ||
            (said.length >= 12 && (d.quote ?? "").toLowerCase().includes(said))),
      );
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 8)
    .map((r) => ({ person: r.person!, said: r.evidence.replace(/^[^"]*"/, "").replace(/"\s*$/, "").slice(0, 220), ...(r.url && !LISTS.test(r.url) ? { at: r.url } : {}) }));
}

/**
 * Where an answer's own address is found when the records kept only the list it was read off (live, 2026-11-14: an X run
 * answered one of six, "I never found the posts they wrote under": the mentions page showed other names by then).
 */
const FIND_ANSWER_ANY = "Where no address is given, find the answer on their notifications; not there, open that person's profile and their recent replies, and look for the one to the customer. Never give up on someone because the first page did not show them.";
const FIND_ANSWER: Readonly<Record<string, string>> = {
  x: "Where no address is given: read_page https://x.com/search?q=to%3A<the customer's handle>&f=live lists every reply to the customer, newest first, each with its own address and who wrote it; scroll it for older ones. A name on the list is a display name: match it by the words. Not there, open that person's profile, With replies.",
};

/** A run that answers who waits on a platform: its unread notifications and messages, and whoever the records name. */
export function whoWaits(p: Platform, owed: readonly { person: string; said: string; at?: string }[]): Extra {
  return {
    title: `${p.name}${WAITS}`,
    agent: "outreach",
    site: siteFor(p),
    every: owed.length ? WAITING_EVERY_MS : INBOX_EVERY_MS,
    instructions: [
      `Answer everyone who is waiting on ${p.name}. Search for nobody new in this run: no find_people, no likes for strangers.`,
      "1. Open their notifications there, then their private messages. Look at the unread counters first (the number on the bell, on the messages icon, beside each conversation): every unread conversation and every unread answer is someone waiting, whether or not they are on the list below.",
      "2. For each one, open the conversation, or the answer's own page so a reply goes under it, and read what they wrote and what the customer said before. Read their record; check them as usual if they are new.",
      "A yes to an offer (to introduce them, to send posts or a link) is owed what was offered: note_person on them gives back their record, with the posts or people promised. Do that step now (their link under each of those posts as an introduction, then a reply to them that it is done, with the posts), never an answer that puts it off. A yes to \"want the link?\" gets the customer's own site link, the product's name and that the first run is free, in one line and nothing more.",
      "3. Answer in the customer's voice, short, to what they said. Someone who said yes to an offer gets what was offered at once (their record's plan keeps the links under Links: or Introduce:). A question is answered truthfully; when they ask what the customer builds or does, how they were found, or about the product, name it, say what it does in a line and give its link (they asked, so it may be named), in the same hour's run and before anyone else. Someone who only thanked in a private message gets the message's own reaction (drafted as a like on that conversation), not more words; under a post, see 5. Where the customer already answered after their words, leave it.",
      "A reply to someone on the list below, with their words as listed in quote, needs no check and no like first: draft it with outreach_draft kind reply on the address of the post or comment it answers. Start with the first on the list and get through all of them before anything else; a profile is read only where the answer needs it.",
      "4. A private message that deserves words gets a short one, sent as a message to their profile, with their last words from the conversation as its quote: that shows they answered, so it needs no like first and may go although an earlier message of the customer's is on record.",
      "5. Comments under their own posts have a run of their own (\"comments under their posts\"): leave them to it unless the list below names someone there.",
      owed.length ? `Waiting by the records, their latest words:\n${owed.map((o) => `- ${o.person}${o.at ? ` (${o.at})` : ""}: "${o.said}"`).join("\n")}\n${FIND_ANSWER[p.key] ?? FIND_ANSWER_ANY}` : "The records name nobody: go by the unread counters.",
      "Keep each with note_person and what passed. End with who was answered, who still waits and why.",
    ].join("\n"),
  };
}

/** How a run that answers every comment under their own posts is titled, after its platform. */
const UNDER_POSTS = ": comments under their posts";
/** How often each platform's own posts are gone through for comments with no answer. */
export const UNDER_POSTS_EVERY_MS = 3 * HOUR;
/**
 * Where Quest put no post up in a week, only their pinned and their own posts can have comments: every three days (live,
 * 2026-11-19: once a day on every platform, 11 runs and about 8M tokens answered nobody, on TikTok, Discord and YouTube
 * where they have no posts).
 */
export const UNDER_OLD_POSTS_EVERY_MS = 72 * HOUR;

/** Whether a run is one code starts by a clock (the rotation's, its extras), not one the manager or the customer asked for. */
export const isRoutine = (title: string): boolean =>
  [NEEDS, WAITS, UNDER_POSTS, ": a post of their own"].some((s) => title.endsWith(s)) || /^(Introductions|What works|New places|The wider web): /.test(title);

/**
 * Every comment under a post of theirs gets words (the founder, 2026-11-16: "you have to answer all comments under your
 * posts, it fires up the algorithm and we get multiple times more exposure", on their Product Hunt launch post on X and
 * their LinkedIn post about downtime). Live, the day before: the "who is waiting" runs gave praise a like ("a like is
 * enough"), the tool refused the thank-yous as small talk, and of 30 comments under the LinkedIn post 3 were answered
 * before the run ran out of steps. So it is a run of its own, every few hours, doing nothing else.
 */
export function underPosts(p: Platform, recent: readonly string[]): Extra {
  return {
    title: `${p.name}${UNDER_POSTS}`,
    agent: "outreach",
    site: siteFor(p),
    every: recent.length ? UNDER_POSTS_EVERY_MS : UNDER_OLD_POSTS_EVERY_MS,
    instructions: [
      `Answer every comment under the customer's own posts on ${p.name}. Every answered comment shows the post to more people, so a comment left with no answer is reach thrown away. Nothing else in this run: no find_people, no strangers, no new posts.`,
      "1. Open their own profile there and its recent posts (on LinkedIn their activity, recent-activity/all/; on X their profile; elsewhere wherever their posts list), their pinned post whatever its age, and every post of the last 7 days that shows comments or replies, the most commented first.",
      "2. Open each such post on its own page and scroll until every comment has loaded (press the page's own \"Load more comments\" or \"Show replies\" where it has one). Every comment with no answer of the customer's under it is someone waiting.",
      "3. Answer each under the comment itself, on the comment's own address, with words in the customer's voice: never only a like. A question gets a true answer. Praise or a thanks gets a few warm words back with one thing that is about what they said or who they are (their name where the site shows it, what they build), sometimes a light question back so they come again; never the same words twice in a post. Someone who answered a post that looks for a kind of person gets what the post promised. Someone who left a link to what they build (under a link thread, or anywhere) gets people for it: open their link, call page_for with what they make, and answer with the page's address in a line (found a few people asking for this, put them on a page for you, then the address); when it finds nobody, one true thing about what they built instead. A comment that is spam or garbled gets a like and nothing more. A reply under their own post needs no check and no like first; quote the comment's own words.",
      "4. Get through every post before you stop; a post with many comments takes several steps of answers, keep going. Where the customer already answered after a comment, leave it.",
      recent.length ? `Their posts Quest put up there lately, by their opening words (find them on their profile; it may hold others too):\n${recent.map((r) => `- ${r}`).join("\n")}` : "",
      "Keep whoever is new with note_person. End with each post and how many comments were answered, and any left with why.",
    ].filter(Boolean).join("\n"),
  };
}

export const EXTRAS: readonly Extra[] = [
  {
    // The founder, 2026-11-12: "to get at least one paying customer it must connect at least 100 people per day".
    title: "Introductions: people who need each other",
    agent: "outreach",
    site: null,
    every: 40 * 60_000,
    instructions: [
      "Bring together people who need each other: someone asking for a thing, and someone who just made that thing. Nothing here is about the customer's product.",
      "1. Call find_pairs. It matches this week's asks and launches by code and gives the pairs, both posts each.",
      "2. For each pair, best first: read both posts in full and what is under them (read_page). Drop the pair when someone already pointed one to the other, when the thing made is not what was asked for after all, or when a post is closed.",
      "3. Read each person's profile and keep them with note_person (what they build or what they are after). Whoever lives in Telegram (a bot, a mini app, a channel, a t.me link) comes first.",
      "4. One reply under each post, in a line or two, as someone who came across both: to the one asking, who made just that and where (the address of their launch post); to the one who made it, who is asking for it (the address of their post) and one true thing you noticed about what they made. It reads like passing a friend's name along, never like a pitch. Draft every one with outreach_draft: it waits for their tap. Work through every pair find_pairs gave: a pair is two reads and two drafts.",
      "5. A post on Hacker News, on Reddit (read only for them) or on any place the customer avoids is where you found them, not where you write (never draft there): reach that person where else they are. Their profile there (Hacker News: news.ycombinator.com/user?id=<name>), their site and their repository name an email, an X, Bluesky, LinkedIn or Telegram handle: read those (no contact on the profile: their earlier posts there name what they make, and that site has one), then a reply to a fresh post of theirs or a message there (their email: outreach_draft kind message through the customer's mail, with a subject), saying where you saw their post. Nowhere else to reach them: put the line and both addresses in your report, and still write to the other one, since half an introduction helps too.",
      "End with each pair in a line: who asked, who made it, and what went to each.",
    ].join("\n"),
  },
  {
    title: "What works: their numbers on each platform and their site",
    agent: "outreach",
    site: null,
    every: 12 * HOUR,
    instructions: [
      "Read their own numbers and say what works, so the work follows what happened, not a guess. Read only: change no setting, press nothing.",
      "1. On each platform they show up on, open their own profile and its analytics where their account has them (X: each post's views on their profile, x.com/i/account_analytics; LinkedIn: linkedin.com/analytics/creator/content/; YouTube: studio.youtube.com, Analytics; Threads: threads.net/insights; Instagram: their professional dashboard; TikTok: tiktok.com/tiktokstudio/analytics). A page that asks to sign in or to pay: skip it and say so.",
      "2. For the last 7 days: which of their posts and replies were seen and answered most, and what they have in common (the kind of post, its length, who it answered, the hour); which got nothing. New followers or connections, profile visits, clicks to their site where shown. Name the one post that drew the most on each platform by its opening words and its numbers, and say what made it: how it opens, whom it speaks to, what it asks of the reader, what it offers them. Open that post and see who commented: name anyone with no answer of the customer's under their comment, they are waiting.",
      "3. Their site's own analytics, when their Chrome is signed in to one (PostHog: us.posthog.com or eu.posthog.com, Web analytics; else Plausible, Google Analytics, Vercel): visitors and sign-ups this week against last, and where visitors came from (which platform sends people who stay: every link Quest puts up to their site carries utm_source=<platform>, so break visits and sign-ups down by UTM source). Not signed in to any: say so in a line, once.",
      "4. End with numbers, a line per platform, then the heading Lessons and three or four numbered lessons, each one sentence that stands on its own, since they are kept and every later run reads them: the pattern of the post that drew the most, with its opening words and numbers, so the next post can be built the same way (\"On LinkedIn a post that opens with a question about the reader's own risk and offers to pass their name along drew 2 comments and 80 views; tips drew none\"); what to stop; and where the people who come actually come from. Only what the pages showed; a run that could read no page writes no lessons.",
    ].join("\n"),
  },
  {
    title: "New places: where else their people are",
    agent: "explorer",
    site: null,
    every: 24 * HOUR,
    instructions: [
      "Find places beyond the platforms they already work where founders and builders gather or where what they built can be listed, and are not filed yet: launch sites and directories, forums and Q&A, newsletters that take submissions, communities (Slack, Discord, Telegram groups with a public way in), blogs whose comments founders read, and other networks (Bluesky, Mastodon, dev.to, Indie Hackers, Product Hunt, Hacker News, Quora, Medium, Substack).",
      "Open each one, read its rules, see how fresh it is (posts today? this week?) and whether their Chrome is signed in there, and file it. Skip the dead ones.",
      "End with the three worth starting on now, best first, each with why, what the first move there is, and what it needs from them (an account, a sign-in).",
    ].join("\n"),
  },
  {
    title: "The wider web: founders asking, beyond their platforms",
    agent: "outreach",
    site: null,
    every: 3 * HOUR,
    filler: true,
    instructions: [
      "Look beyond their platforms for the people the product is for, saying in their own post in the last day or two that they have the problem it solves or asking for such a thing (words go to them), and for fellow builders sharing what they make (a like or a follow): Hacker News (Show HN, newest), Indie Hackers, Product Hunt's launches of today, Bluesky, Mastodon, dev.to, and a web search for fresh posts (search_posts, source web, newest).",
      "1. Where their Chrome is signed in, get to know them as anywhere: a like or an upvote for everyone real, a follow for the builders whose profile you read.",
      "2. For up to 5 who fit best, check them properly before a word: try their landing page as a visitor would (read_site, pages 3: what it says in its first screen, what is unclear, what is broken), their listing where they launched, their profile and what they posted before. Keep it with note_person. Then write only what could be for them alone: the one thing you noticed that helps.",
      "3. Someone who fits and whose site gives an email for feedback or contact: a short email is fine (outreach_draft kind message, through their mail as the platform map says), about their product only, giving the thing you noticed and asking for nothing.",
      "4. A site with no way to answer signed in: draft nothing there, and note the place in your report, for them to decide on an account. A Mastodon post lives on its author's server, where they have no account: nothing can go up under it there.",
      "End with who you reached and where, one line each, and the places that looked alive.",
    ].join("\n"),
  },
];

/** When a run with this title last started, or 0. */
const lastStarted = (tasks: readonly Task[], title: string): number => Math.max(0, ...tasks.filter((t) => t.title === title).map((t) => t.createdAt.getTime()));

/**
 * The extra to run now, or null: one due by its clock (never two extras in a row while a platform is open), else, with
 * no platform open, the filler longest without a run once it has rested.
 */
export function nextExtra(
  picked: readonly Platform[],
  x: { tasks: readonly Task[]; drafts: readonly Draft[]; avoided: ReadonlySet<string>; now: Date; results?: readonly ResultEntry[] },
  platformOpen: boolean,
  answerOnly = false,
): Extra | null {
  const now = x.now.getTime();
  const day = now - DAY_MS;
  const posts = picked
    .filter((p) => p.limits.posts > 0 && !NO_TEXT_POSTS.has(p.key))
    .filter((p) => {
      const why = passedOver(p, x);
      if (why && !STILL_POSTS.has(why)) return false;
      const mine = x.drafts.filter((d) => draftPlatform(d).key === p.key && d.kind === "post");
      return !mine.some((d) => d.status === "open") && mine.filter((d) => d.status === "posted" && (d.sentAt?.getTime() ?? 0) > day).length < p.limits.posts;
    })
    .map(ownPost);
  // Who waits comes before anything new: a platform with someone named is due first.
  const waits = picked
    .filter((p) => p.key !== "email")
    .filter((p) => {
      const why = passedOver(p, x);
      return !why || STILL_POSTS.has(why);
    })
    .map((p) => whoWaits(p, waitingOn(p, { drafts: x.drafts, results: x.results ?? [], now: x.now })))
    .sort((a, b) => a.every - b.every);
  const comments = picked
    .filter((p) => p.key !== "email")
    .filter((p) => {
      const why = passedOver(p, x);
      return !why || STILL_POSTS.has(why);
    })
    .map((p) => underPosts(p, x.drafts.filter((d) => d.kind === "post" && d.status === "posted" && draftPlatform(d).key === p.key && (d.sentAt?.getTime() ?? 0) > now - 7 * DAY_MS).slice(0, 8).map((d) => (d.title ?? d.text).replace(/\s+/g, " ").slice(0, 90))));
  // The short clocks hold only while something new came: an answer recorded there since that run last started. Live,
  // 2026-11-18 to 20: 46 of 60 such runs drafted nothing, about 27M tokens in two days, mostly the same names and the
  // same comments looked at again every two or three hours.
  const answeredSince = (title: string, p: Platform | undefined): boolean => {
    if (!p) return true;
    const since = lastStarted(x.tasks, title);
    return (x.results ?? []).some((r) => r.stage === "conversation" && r.at.getTime() > since && onPlatform(p, r.url));
  };
  const byTitle = new Map(picked.map((p) => [p.name, p]));
  const platformOf = (e: Extra): Platform | undefined => byTitle.get(e.title.slice(0, e.title.indexOf(":")));
  // Only answering: each platform's answers and comments once on the short clock, nothing else.
  if (answerOnly) {
    const due = [...waits, ...comments]
      .map((e) => ({ ...e, every: e.title.endsWith(WAITS) ? WAITING_EVERY_MS : UNDER_POSTS_EVERY_MS }))
      .filter((e) => now - lastStarted(x.tasks, e.title) >= e.every)
      .sort((a, b) => lastStarted(x.tasks, a.title) - lastStarted(x.tasks, b.title));
    return due[0] ?? null;
  }
  for (const e of [...waits, ...comments]) {
    if (e.every === WAITING_EVERY_MS || e.every === UNDER_POSTS_EVERY_MS) {
      if (!answeredSince(e.title, platformOf(e))) (e as { every: number }).every = e.title.endsWith(WAITS) ? INBOX_EVERY_MS : UNDER_OLD_POSTS_EVERY_MS;
    }
  }
  const all = [...waits, ...comments, ...EXTRAS, ...posts];
  const titles = new Set(all.map((e) => e.title));
  const last = x.tasks.reduce<Task | null>((a, t) => (!a || t.createdAt > a.createdAt ? t : a), null);
  const named = (e: Extra): boolean => e.title.endsWith(WAITS) && e.every === WAITING_EVERY_MS;
  // Someone named by the records is answered before anything else is started, a platform's turn too.
  const due = all.filter((e) => now - lastStarted(x.tasks, e.title) >= e.every).sort((a, b) => Number(named(b)) - Number(named(a)) || lastStarted(x.tasks, a.title) - lastStarted(x.tasks, b.title));
  if (due.length && (named(due[0]!) || !(platformOpen && last && titles.has(last.title)))) return due[0]!;
  if (platformOpen) return null;
  return all.filter((e) => e.filler && now - lastStarted(x.tasks, e.title) >= FILLER_REST_MS)[0] ?? null;
}

export class Rotation implements Loop {
  readonly #d: RotationDeps;
  /** Why nothing was started for each customer at the last look, to log it once when it changes. */
  readonly #idle = new Map<CustomerId, string>();
  /** When each customer was last found with nothing to start. */
  readonly #idleAt = new Map<CustomerId, number>();
  readonly #everyMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #running: Promise<void> | null = null;

  constructor(deps: RotationDeps, options: { everyMs?: number } = {}) {
    this.#d = deps;
    this.#everyMs = options.everyMs ?? ROTATION_EVERY_MS;
  }

  get busy(): boolean {
    return this.#running !== null;
  }

  start(): void {
    this.#timer ??= setInterval(() => void this.tick(), this.#everyMs);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#running;
  }

  /** One look at every customer whose Chrome is open: at most one run started for each. */
  tick(): Promise<void> {
    this.#running ??= this.#look().finally(() => (this.#running = null));
    return this.#running;
  }

  /** When a platform's run last started for each customer (in memory: counted from the first look after a start). */
  readonly #routineAt = new Map<string, number>();

  async #look(): Promise<void> {
    for (const id of this.#d.online()) {
      await this.#fill(id).catch((e: unknown) => this.#d.log.warn("rotation.failed", { customerId: id, error: e instanceof Error ? e.message : String(e) }));
    }
  }

  /** Starts the next run for them when a slot is free; returns the task started, or null with nothing to start. */
  async #fill(customerId: CustomerId): Promise<Task | null> {
    const d = this.#d;
    const c = await d.customers.get(customerId);
    // Someone not in yet, switched off, or before their first sweep ended (it reads those sites first, by code).
    if (c.status !== "active" || !c.activatedAt || c.offAt || !c.sweptAt) return null;
    if (await d.restingUntil(customerId)) return null;
    const rests = d.modelsRest?.() ?? null;
    if (rests) return this.#why(customerId, `the models rest until ${rests.toISOString()}`);
    // A line of answering and asked-for work must not starve the browsing that likes and follows (live, 2026-11-14:
    // with such runs queued all day, 18 platform runs started against 128 two days before, and likes fell from 215 to
    // 43). When none started for `STARVED_MS`, one joins the line ahead of asked-for work, behind the answers.
    if (!this.#routineAt.has(customerId)) this.#routineAt.set(customerId, d.now().getTime());
    const starved = d.now().getTime() - this.#routineAt.get(customerId)! > STARVED_MS;
    if (!starved && d.tasks.atWork && (await d.tasks.atWork(customerId)) >= d.perCustomer) return null;
    // Nothing could start a moment ago: the lists are read again only after a while.
    if (d.now().getTime() - (this.#idleAt.get(customerId) ?? 0) < IDLE_LOOK_MS) return null;
    const tasks = await d.tasks.list(customerId);
    const active = tasks.filter((t) => ACTIVE.has(t.status));
    const full = active.length >= d.perCustomer;
    if (full && (!starved || active.some((t) => t.title.endsWith(NEEDS)))) {
      if (starved) this.#routineAt.set(customerId, d.now().getTime());
      return null;
    }
    if (!full && catchingBreath(tasks, d.now())) return null;
    // A run no longer waits for the outbox to be empty: with openers due all day it never was, and no run that answers
    // people started for hours (live, 2026-11-14). A send still takes the front first, and gives a run its stretch after
    // (`Outbox`, `RUN_SLICE_MS`).
    const picked = pickedPlatforms(c)
      .map((key) => PLATFORMS.find((p) => p.key === key))
      .filter((p): p is Platform => Boolean(p && p.key !== "email"));
    if (!picked.length) return null;
    const avoided = new Set((await d.places.listFor(customerId)).filter((p) => p.verdict === "avoid").map((p) => p.key));
    const now = d.now();
    const drafts = await d.drafts.recent(customerId, 300);
    const results = d.results ? await d.results.list(customerId, 500).catch(() => []) : [];
    const x = { tasks, drafts, avoided, now, results };
    const p = d.answerOnly ? null : nextPlatform(picked, x);
    const extra = full ? null : nextExtra(picked, x, p !== null, d.answerOnly);
    if (d.answerOnly && !extra) return this.#why(customerId, "only answering: nobody due");
    if (extra) {
      // Its place in the queue: answering who waits first, introductions with asked-for work, the rest as routine.
      // A post of their own may brag only with figures counted from the records.
      const numbers = extra.title.endsWith(": a post of their own") ? await d.numbers?.(customerId).catch(() => null) : null;
      const t = await d.tasks.start(customerId, extra.agent, extra.title, numbers ? `${extra.instructions}\nNumbers of the last 7 days, counted from the records (use only these, as they are):\n${numbers}` : extra.instructions, extra.site, extra.title.endsWith(WAITS) || extra.title.endsWith(UNDER_POSTS) ? 0 : extra.title.startsWith("Introductions") ? 1 : 2);
      this.#idle.delete(customerId);
      d.log.info("rotation.started", { customerId, taskId: t.id, site: t.site, extra: extra.title });
      return t;
    }
    if (!p && full) this.#routineAt.set(customerId, now.getTime() - STARVED_MS + 10 * 60_000);
    if (!p) return this.#why(customerId, picked.map((q) => `${q.key}: ${passedOver(q, x)}`).join("; "));
    this.#idle.delete(customerId);
    const comeBack = d.people ? await d.people.comeBack(customerId, contactSite(`https://${siteFor(p)}`) ?? siteFor(p)).catch(() => []) : [];
    const brief = rotationBrief(p, comeBack, wentLine(p, howItWent(p, { drafts, results, now })));
    const t = await d.tasks.start(customerId, "outreach", brief.title, brief.instructions, siteFor(p), full ? 0 : 2);
    this.#routineAt.set(customerId, now.getTime());
    d.log.info("rotation.started", { customerId, taskId: t.id, site: t.site, ...(full ? { starved: true } : {}) });
    return t;
  }

  /** Nothing to start, and why: logged once each time the reason changes, so an idle stretch can be read off the log. */
  #why(customerId: CustomerId, why: string): null {
    if (this.#idle.get(customerId) !== why) this.#d.log.info("rotation.idle", { customerId, why });
    this.#idle.set(customerId, why);
    this.#idleAt.set(customerId, this.#d.now().getTime());
    return null;
  }
}
