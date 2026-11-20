import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { CustomerId, Logger, PageText, SpendLog } from "@mq/core";
import type { ModelProvider } from "../agents/models.ts";
import { usageOf } from "../agents/usage.ts";
import { quoteAppears } from "../tasks/seen-pages.ts";

/**
 * Answers to what went up as the customer on a site that is not Reddit, read off a page of their own account (their
 * notifications, or the post a reply went under) on the volume seat. Reddit's comments come cut by code with their
 * parents (reply-watch.ts); X, Threads, Instagram, LinkedIn, YouTube and TikTok show answers as a feed of words, which
 * one model call reads. Until 2026-11-04 nothing looked there at all: a reply on Threads was never watched, and outreach
 * runs went to the notifications by hand to see who answered. An answer is kept only when its words are on the page
 * as it says them, so nobody is told someone said what they did not.
 */

/** What went up as the customer that answers may come to. */
export interface Sent {
  readonly kind: "reply" | "post";
  /** Whose post a reply went under. */
  readonly to: string | null;
  readonly said: string;
  readonly at: Date;
  /** The post a reply went under, or the post itself. */
  readonly url: string;
}

/** Someone's answer, as the page shows it. */
export interface Heard {
  /** Which of the sent things it answers, from 0; null when it answers the customer but none of them. */
  readonly to: number | null;
  readonly author: string;
  readonly text: string;
}

/** How much of the page the model reads: a notifications page's last day or two. */
const PAGE_CHARS = 14_000;

export const ANSWERS_SYSTEM = `You read one page of a social site as the customer's own account shows it (their notifications or mentions, or a post with the replies under it), for Quest, which posts and replies as the customer. You get what went up as the customer there lately, numbered, and the page's words. Find every answer someone else wrote to one of them: a reply to it, a reply to the customer under that post, a mention of the customer answering it.
- Only words someone else wrote to the customer, shown on this page. Not the customer's own words (a reply of theirs is often shown with no name over it: words that match what went up as them, or read as its continuation, are theirs), not the post they replied to, not another person's reply to that post or to someone else (it opens with another handle, or stands beside the customer's reply rather than under it), not the post's author adding to their own post, not notices with no words of their own (liked, followed, reposted, viewed, "replied to you" with nothing after it), not ads or suggested posts.
- n: the number of what it answers (the same person or the same post); 0 when it answers the customer but none of the numbered things.
- author: their handle or name as the page shows it. text: their words, copied exactly from the page (at most 400 characters; cut with … if long).
Return only JSON: {"answers":[{"n":1,"author":"…","text":"…"}]}, or {"answers":[]} when there are none.`;

const day = (d: Date): string => d.toISOString().slice(0, 16).replace("T", " ");

export function answersPrompt(page: PageText, sent: readonly Sent[], account: string | null): string {
  return [
    ...(account ? [`The customer's account here: ${account}`, ""] : []),
    "WHAT WENT UP AS THE CUSTOMER",
    ...sent.map((s, i) => `#${i + 1} ${day(s.at)} ${s.kind === "post" ? "their post" : `a reply${s.to ? ` to ${s.to}` : ""}`} (${s.url}): "${s.said.replace(/\s+/g, " ").slice(0, 400)}"`),
    "",
    `THE PAGE (${page.url})`,
    page.text.slice(0, PAGE_CHARS),
  ].join("\n");
}

export function parseAnswers(raw: string, count: number): Heard[] {
  try {
    const v = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { answers?: unknown };
    if (!Array.isArray(v.answers)) return [];
    return v.answers.flatMap((a): Heard[] => {
      const o = a as Record<string, unknown>;
      const n = Number(o.n);
      if (!Number.isInteger(n) || n < 0 || n > count || typeof o.author !== "string" || typeof o.text !== "string") return [];
      const author = o.author.trim().slice(0, 80);
      const text = o.text.trim().slice(0, 500);
      return author && text ? [{ to: n === 0 ? null : n - 1, author, text }] : [];
    });
  } catch {
    return [];
  }
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (p && typeof p === "object" && "text" in p && typeof p.text === "string" ? p.text : "")).join("") : "";

const same = (a: string, b: string | null): boolean => Boolean(b && a.replace(/^@/, "").toLowerCase() === b.replace(/^@/, "").toLowerCase());

export class AnswerReader {
  readonly #models: ModelProvider;
  readonly #spend: SpendLog | undefined;
  readonly #log: Logger;

  constructor(deps: { models: ModelProvider; spend?: SpendLog; log: Logger }) {
    this.#models = deps.models;
    this.#spend = deps.spend;
    this.#log = deps.log;
  }

  /** The answers on the page to what went up as them, each in the page's own words; the customer's own left out. */
  async read(customerId: CustomerId, page: PageText, sent: readonly Sent[], account: string | null): Promise<Heard[]> {
    const started = Date.now();
    const reply = await this.#models.modelFor("volume", { customerId }).invoke([new SystemMessage(ANSWERS_SYSTEM), new HumanMessage(answersPrompt(page, sent, account))]);
    const usage = usageOf(reply);
    if (usage) this.#spend?.record({ customerId, taskId: null, agent: "watch", model: (reply as { response_metadata?: { model_name?: string } }).response_metadata?.model_name ?? null, ms: Date.now() - started, usage });
    const all = parseAnswers(textOf(reply.content), sent.length);
    const heard = all.filter((a) => quoteAppears(a.text, page.text) && !same(a.author, account) && !sent.some((s) => quoteAppears(a.text, s.said)));
    this.#log.info("watch.answers_read", { customerId, page: new URL(page.url).hostname, sent: sent.length, answers: heard.length, unquoted: all.length - heard.length, ms: Date.now() - started });
    return heard;
  }
}
