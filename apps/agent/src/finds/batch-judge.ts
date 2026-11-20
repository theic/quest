import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { CustomerId, FoundPost, Logger, ModelUsage, SpendLog, TaskId } from "@mq/core";
import type { ModelProvider, ModelRole } from "../agents/models.ts";
import { usageOf } from "../agents/usage.ts";
import { PLAYBOOK } from "../quests.ts";
import { quoteAppears } from "../tasks/seen-pages.ts";

/**
 * Posts judged many at a time on a cheap seat, instead of a teammate reading page after page (the founder, 2026-10-23:
 * browsing "cheaper and faster"). Code cuts the pages into posts (`chrome/sites.ts`, `chrome/reddit.ts`, the public
 * APIs); one call here looks at up to `JUDGE_BATCH` of them against the customer's brief and what a find is, and keeps the
 * ones worth a message, each with the person's own words that show it. The writer then writes for the best few only.
 * A quote the model did not copy from the post is not kept: nothing here may put words in someone's mouth.
 */

export const JUDGE_BATCH = 40;
/** How much of each post the judge sees: enough for an ask, which is mostly in its first lines. */
const POST_CHARS = 700;

export type Fit = "strong" | "maybe";

export interface JudgedPost {
  readonly post: FoundPost;
  readonly fit: Fit;
  /** Their own words that show it, copied from the post. For a preview (a title, a video) read the post before quoting. */
  readonly quote: string;
  readonly why: string;
  /** A first draft of what the customer could answer, as THE QUEST says the message reads; the writer rewrites it in their voice. Empty when none came. */
  readonly reply: string;
}

export interface Judging {
  readonly judged: readonly JudgedPost[];
  /** Posts looked at, after the ones too old were left out. */
  readonly looked: number;
  /** Picks whose quote was not in the post: dropped. */
  readonly unquoted: number;
  /** Batches no model answered (logged): their posts were not judged. */
  readonly failed: number;
  readonly calls: number;
  readonly usage: ModelUsage;
  readonly ms: number;
}

export interface JudgeAsk {
  readonly customerId: CustomerId | null;
  /** The run it judges for, so its calls count to that run. */
  readonly taskId?: TaskId | null;
  readonly brief: string;
  /** What they decided on earlier finds, as the scout reads it; optional. */
  readonly decisions?: string;
  /**
   * Who to pick, in the manager's words, instead of THE QUEST's find (outreach's plays: "founders who just shared what
   * they built"). A play's picks carry no first draft: the teammate checks each person, and the writer writes.
   */
  readonly play?: string;
  /** What the customer decided and the team learned, kept for good: the judge follows them as the team does. */
  readonly rules?: string;
  /** Posts older than this are not looked at; THE QUEST's year otherwise. */
  readonly maxAgeDays?: number;
  /** Pick widely: the posts are for a like, not a word (live, 2026-11-06: "Be strict" kept 1 of 12 on X). */
  readonly wide?: boolean;
  readonly posts: readonly FoundPost[];
}

export const BATCH_JUDGE_SYSTEM = `You judge posts for Quest, which finds people online who are asking, right now, for what its customer brings: people for what they built. You get THE QUEST (what a find is), the customer's brief and a numbered list of posts. Pick the posts whose authors Quest should write to.
- "strong": the author plainly asks for, or is in the middle of choosing, what the customer brings, as THE QUEST says what a find is.
- "maybe": likely so, but they do not quite say it.
- Leave out everything else: people selling or promoting their own thing, news, tutorials and listicles, launches and brags, a different need, people who already chose and are happy, bots, and anyone who says they are under 18.
- Judge the author's own words. A post that is only a title (a video, a forum list) can be "maybe" when the title is an ask.
- quote: the author's words that show the ask, copied exactly from the post or its title (at most 300 characters; cut with … if long). why: one short sentence, plain words.
- reply: what the customer could answer, as THE MESSAGE says: two to four plain sentences that answer what they asked, in the language of the post. Only facts from the brief.
Be strict: most posts are not finds, and three strong ones beat ten weak ones.
Return only JSON: {"picks":[{"n":<number>,"fit":"strong"|"maybe","quote":"…","why":"…","reply":"…"}]}, with only the posts you pick; {"picks":[]} when none fit.`;

/** The same judging for a play: the people it names, whatever they post, and no first draft. */
export const PLAY_JUDGE_SYSTEM = `You judge posts for Quest, which finds the people its customer wants to reach. You get THE PLAY (who to pick), the customer's brief, what the customer decided and the team learned, and a numbered list of posts. Pick the posts whose authors are the people THE PLAY names.
- "strong": the author is plainly one of them, in their own words, in this post.
- "maybe": likely one of them, but the post does not quite show it.
- Leave out everything else: posts that only look like it (a listicle, news, a thread about others, a giveaway), agencies and growth sellers unless THE PLAY asks for them, bots, the customer's own posts, anyone who says they are under 18, and anything the customer's decisions rule out.
- Judge the author's own words, and the post's date against how fresh THE PLAY wants it.
- quote: the author's words that show it, copied exactly from the post (at most 300 characters; cut with … if long). why: one short sentence, plain words: who they are and why they fit.
Be strict: three that surely fit beat ten that might.
Return only JSON: {"picks":[{"n":<number>,"fit":"strong"|"maybe","quote":"…","why":"…"}]}, with only the posts you pick; {"picks":[]} when none fit.`;

/** The same judge for likes: nothing is written to them, so every post that may fit is picked. */
const PLAY_JUDGE_WIDE = PLAY_JUDGE_SYSTEM.replace("Be strict: three that surely fit beat ten that might.", "Be generous: this is only for a friendly like, so pick every post that may fit, as \"maybe\" when unsure.");

const day = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : "date unknown");

export function judgePrompt(ask: JudgeAsk, posts: readonly FoundPost[], today?: Date): string {
  const play = PLAYBOOK.scout;
  return [
    ...(ask.play
      ? [`THE PLAY: who to pick: ${ask.play.trim().slice(0, 1_500)}`, ...(today ? [`Today is ${day(today)}.${ask.maxAgeDays ? ` Nothing older than ${ask.maxAgeDays} days.` : ""}`] : [])]
      : [`THE QUEST: what a find is: ${play.finds}`, `How fresh: ${play.when}`, `THE MESSAGE: ${play.message}`]),
    "",
    "THE CUSTOMER'S BRIEF",
    ask.brief.trim().slice(0, 4_000),
    ...(ask.rules?.trim() ? ["", "WHAT THE CUSTOMER DECIDED, AND WHAT THE TEAM LEARNED (follow these)", ask.rules.trim().slice(0, 2_000)] : []),
    ...(ask.decisions?.trim() ? ["", "WHAT THEY DECIDED ON EARLIER FINDS", ask.decisions.trim().slice(0, 1_500)] : []),
    "",
    "THE POSTS",
    ...posts.map((p, i) =>
      [
        `#${i + 1} [${p.source}] ${day(p.postedAt)}${p.author ? ` by ${p.author}` : ""}${p.replies !== null ? `, ${p.replies} replies` : ""}${p.title ? ` "${p.title}"` : ""}`,
        p.text.replace(/\s+/g, " ").slice(0, POST_CHARS),
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n");
}

interface Pick {
  readonly n: number;
  readonly fit: Fit;
  readonly quote: string;
  readonly why: string;
  readonly reply: string;
}

export function parsePicks(raw: string): Pick[] {
  try {
    const v = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { picks?: unknown };
    if (!Array.isArray(v.picks)) return [];
    return v.picks.flatMap((p): Pick[] => {
      const o = p as Record<string, unknown>;
      const n = Number(o.n);
      const fit = o.fit === "strong" || o.fit === "maybe" ? o.fit : null;
      return Number.isInteger(n) && fit && typeof o.quote === "string" ? [{ n, fit, quote: o.quote.trim(), why: typeof o.why === "string" ? o.why.trim() : "", reply: typeof o.reply === "string" ? o.reply.trim().slice(0, 1_200) : "" }] : [];
    });
  } catch {
    return [];
  }
}

const NO_USAGE: ModelUsage = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0 };
const add = (a: ModelUsage, b: ModelUsage | null): ModelUsage =>
  b ? { input: a.input + b.input, cached: a.cached + b.cached, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output, reasoning: a.reasoning + b.reasoning, cost: (a.cost ?? 0) + (b.cost ?? 0) } : a;

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (p && typeof p === "object" && "text" in p && typeof p.text === "string" ? p.text : "")).join("") : "";

export class BatchJudge {
  readonly #models: ModelProvider;
  readonly #spend: SpendLog | undefined;
  readonly #log: Logger;
  readonly #seat: ModelRole;
  readonly #size: number;
  readonly #now: () => Date;

  constructor(deps: { models: ModelProvider; spend?: SpendLog; log: Logger; seat?: ModelRole; batch?: number; now?: () => Date }) {
    this.#models = deps.models;
    this.#spend = deps.spend;
    this.#log = deps.log;
    this.#seat = deps.seat ?? "volume";
    this.#size = deps.batch ?? JUDGE_BATCH;
    this.#now = deps.now ?? (() => new Date());
  }

  /** The posts worth a message, strong first, newest first within each. Posts older than a find may be are not looked at. */
  async judge(ask: JudgeAsk): Promise<Judging> {
    const started = Date.now();
    const oldest = this.#now().getTime() - (ask.maxAgeDays ?? PLAYBOOK.scout.maxAgeDays) * 86_400_000;
    const posts = ask.posts.filter((p) => !p.postedAt || p.postedAt.getTime() >= oldest);
    const batches: FoundPost[][] = [];
    for (let i = 0; i < posts.length; i += this.#size) batches.push(posts.slice(i, i + this.#size));
    const results = await Promise.all(
      batches.map((b) =>
        this.#batch(ask, b).catch((e: unknown) => {
          // One batch no model answered is its posts unjudged, not the whole sweep lost.
          this.#log.warn("finds.judge_failed", { customerId: ask.customerId, posts: b.length, error: e instanceof Error ? e.message : String(e) });
          return null;
        }),
      ),
    );
    const answered = results.filter((r): r is NonNullable<typeof r> => r !== null);
    const judged = answered.flatMap((r) => r.judged);
    const order = (j: JudgedPost) => (j.fit === "strong" ? 0 : 1);
    judged.sort((a, b) => order(a) - order(b) || (b.post.postedAt?.getTime() ?? 0) - (a.post.postedAt?.getTime() ?? 0));
    const out: Judging = {
      judged,
      looked: posts.length,
      unquoted: answered.reduce((n, r) => n + r.unquoted, 0),
      failed: results.length - answered.length,
      calls: batches.length,
      usage: answered.reduce((u, r) => add(u, r.usage), NO_USAGE),
      ms: Date.now() - started,
    };
    this.#log.info("finds.judged", { customerId: ask.customerId, looked: out.looked, strong: judged.filter((j) => j.fit === "strong").length, maybe: judged.filter((j) => j.fit === "maybe").length, unquoted: out.unquoted, failed: out.failed, calls: out.calls, ms: out.ms });
    return out;
  }

  async #batch(ask: JudgeAsk, posts: readonly FoundPost[]): Promise<{ judged: JudgedPost[]; unquoted: number; usage: ModelUsage | null }> {
    const started = Date.now();
    const reply = await this.#models.modelFor(this.#seat, { customerId: ask.customerId }).invoke([new SystemMessage(ask.wide ? PLAY_JUDGE_WIDE : ask.play ? PLAY_JUDGE_SYSTEM : BATCH_JUDGE_SYSTEM), new HumanMessage(judgePrompt(ask, posts, this.#now()))]);
    const usage = usageOf(reply);
    if (usage) this.#spend?.record({ customerId: ask.customerId, taskId: ask.taskId ?? null, agent: "judge", model: (reply as { response_metadata?: { model_name?: string } }).response_metadata?.model_name ?? null, ms: Date.now() - started, usage });
    const judged: JudgedPost[] = [];
    const taken = new Set<number>();
    let unquoted = 0;
    for (const pick of parsePicks(textOf(reply.content))) {
      const post = posts[pick.n - 1];
      if (!post || taken.has(pick.n)) continue;
      if (!quoteAppears(pick.quote, [post.title, post.text].filter(Boolean).join("\n"))) {
        unquoted++;
        continue;
      }
      taken.add(pick.n);
      judged.push({ post, fit: pick.fit, quote: pick.quote, why: pick.why, reply: pick.reply });
    }
    return { judged, unquoted, usage };
  }
}
