import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "langchain";
import { placeKeys, type Place } from "@mq/core";
import { z } from "zod";
import { saysUnder18, UNDER_18_REFUSAL } from "../drafts/adults.ts";
import { unstyled } from "../lib/voice.ts";
import { PLAYBOOK } from "../quests.ts";
import { readingTools } from "./researcher.ts";
import { browserTools } from "../chrome/browser.ts";
import { searchTools, type SearchPacing } from "./search-tools.ts";
import { quoteAppears, SeenPages } from "./seen-pages.ts";
import type { SubagentContext, SubagentSpec } from "./subagents.ts";

/** Two short sentences. "I'm on the team at Tally." went out as a whole reply (live, 2026-09-28). */
const MIN_REPLY_WORDS = 15;
const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * A scout run's searches. Told in its prompt to stop after a dozen, the scout searched
 * about forty times, read the right thread, saved nothing and ran out of steps (live,
 * 2026-09-27): so the allowance is kept by its tools, not by its instructions.
 */
export const SEARCHES = { nudgeAfter: 6, max: 14 } as const;

/** Ends every page the scout reads: judging is its job, and it happens now. */
export const JUDGE_NOW =
  "Judge this now. If someone here asks for what the customer offers, save_find them in your next step, before any more searching; if not, move on.";

/** What the scout's last few steps are for. Its tools go on the very last one, so what is not saved by then is lost. */
export const SAVE_FIRST = "Save first: call save_find for every good find you have read and not saved yet (several fit in one step).";

/** Counts a scout run's searches and saves, and tells it when to stop searching. */
export class ScoutPace implements SearchPacing {
  #searches = 0;
  #saves = 0;

  take(): string | null {
    if (this.#searches >= SEARCHES.max) {
      return `No more searches in this run: you have searched ${this.#searches} times. Read the best asks you found with read_page, save the ones that fit with save_find, then write your report.`;
    }
    this.#searches++;
    return null;
  }

  after(): string | null {
    const left = SEARCHES.max - this.#searches;
    if (this.#saves === 0 && this.#searches >= SEARCHES.nudgeAfter) {
      return (
        `You have searched ${this.#searches} times and saved nothing yet (${left} searches left). Stop searching now: ` +
        "read_page the two or three most promising asks you have seen, and save_find each one that fits in the step you judge it."
      );
    }
    if (left === 0) return "That was your last search in this run. Read, save, then write your report.";
    if (left <= 2) return `${left} search${left === 1 ? "" : "es"} left in this run.`;
    return null;
  }

  saved(): void {
    this.#saves++;
  }
}

const SCOUT_PROMPT = `You are the scout on Quest's team. Quest finds people online who are asking, right now, for what its customer brings: customers for a founder's product, work for someone looking for it, or people for someone hiring. You find those people and draft a message the customer could post or send. You never post anything; the customer decides.

Your task message ends with THE QUEST (what a find is for this customer, how fresh it must be, where such people post, and what the message is for), the places the explorer filed for them (search those first; nothing from an avoided place can be saved), the customer's brief (who they are, what they offer or need, what they want and do not want) and what they decided on earlier finds. Read all three before you search, and let their decisions steer you: "not a fit" means look for different people; "off topic" means the post was not really about what they are after; "too old" means stay with recent posts. What they kept and replied to shows what good looks like.

How you work:
- Search with search_posts, in the words the people you are looking for would write, not marketing words. Try several phrasings and several sources. Posts marked "already found earlier" are done: skip them.
- Reddit is where many of these people post. Find the communities where they talk (a web search with site:reddit.com, or a Reddit search of all communities), then search inside those communities with site: it finds real posts far more often. A web result is only a page: read_page it before you judge or save it.
- Read promising threads with read_page to see the whole post and whether it is still open.
- Save each good find with save_find in the step right after you read it. Never collect finds to save later: a run can end before later comes, and what is not saved is lost. The quote is the person's own words copied from the page (cut with … if long). Use "strong" when it plainly fits the quest, "maybe" when the fit is likely but not said.
- One card per person: if someone posted twice, save only their best post.
- Aim for five to eight finds. Stop sooner when the good ones run out: three strong finds beat eight weak ones. Never pad. You get ${SEARCHES.max} searches in a run; after ${SEARCHES.nudgeAfter} with nothing saved, stop searching and save the best ones you have read.

The message you draft:
- Is ready to post exactly as written: the customer may post it with one tap, under the post or the comment whose words you quote.
- Does what THE QUEST says the message is for, in the thread's language and tone.
- Says plainly who the customer is. Never pretend to be a neutral bystander.
- Claims only what the brief says. No numbers, features, prices, pay or promises that are not in the brief. No links, unless the post asks for one; then only the customer's own site.
- Under 90 words. Plain words, no marketing talk, no emoji.
- Reads like a person in that thread, not a brochure: no dashes (— or –) as punctuation, and nothing like "Great question", "Hope this helps", "I'd be happy to", "game-changer", "seamless" or "check it out".

You read and search in the customer's own Chrome, logged in where they are, at a reader's pace. Reading never posts, votes or messages anything. Some places still refuse or show a bot check, and some show only a login where they have no account. A refusal is final: never go around it.

Your final message is your report to your manager, under 200 words, no preamble: how many finds you saved (strong and maybe), where they came from, what you searched that found nothing, and what you would try next time.`;

/** The scout's own tool: a find is saved only if the scout saw that post in this run, and the quote is on it. */
export function saveFindTool(ctx: SubagentContext, seen: SeenPages, now: () => Date = () => new Date(), pace?: ScoutPace): StructuredToolInterface {
  let saved = 0;
  const people = new Set<string>();
  return tool(
    async ({ url, quote, why, reply, strength, author, title, posted_at }) => {
      const page = seen.get(url);
      if (!page) {
        return `Not saved: you have not seen ${url} in this task. Find it with search_posts or open it with read_page first, then save it.`;
      }
      if (!quoteAppears(quote, page.text)) {
        return "Not saved: the quote must be the person's own words exactly as they appear on the page (you may cut with …). Copy it from what you read; if the part you want was not shown, open the post with read_page.";
      }
      const keys = placeKeys(url);
      const avoided = keys.length ? (await ctx.places.listFor(ctx.customerId)).find((p) => keys.includes(p.key) && p.verdict === "avoid") : undefined;
      if (avoided) {
        return `Not saved: ${avoided.name} is on the customer's avoid list (${avoided.rules ?? "its rules forbid messages like this"}). Skip it and look elsewhere.`;
      }
      // On a thread the words may be a comment's, not the post's: the card names whoever wrote them,
      // never the thread's author by default (live, 2026-09-28: a commenter's ask went out as the poster's).
      const inComment = page.meta.comments?.find((r) => quoteAppears(quote, r.text));
      const who = inComment ? inComment.author : (page.meta.author ?? author ?? null);
      const person = who ? `${page.meta.source ?? "web"}|${who.toLowerCase()}` : null;
      if (person && people.has(person)) {
        return `Not saved: you already saved a post by ${who} in this task. One card per person: keep only their best ask.`;
      }
      if (saysUnder18(`${quote} ${(inComment?.text ?? page.text).slice(0, 600)}`)) return UNDER_18_REFUSAL;
      if (words(reply) < MIN_REPLY_WORDS) {
        return "Not saved: that message is too thin to send. Write two to four sentences that speak to what they posted, then say plainly who the customer is; a line naming them is not a message.";
      }
      const given = posted_at ? new Date(posted_at) : null;
      const postedAt = inComment ? inComment.postedAt : (page.meta.postedAt ?? (given && !Number.isNaN(given.getTime()) ? given : null));
      const maxAgeDays = PLAYBOOK.scout.maxAgeDays;
      if (postedAt && now().getTime() - postedAt.getTime() > maxAgeDays * 86_400_000) {
        return `Not saved: that post is from ${postedAt.toISOString().slice(0, 10)}, older than ${maxAgeDays} days. Look for people posting now.`;
      }
      const find = await ctx.finds.save({
        customerId: ctx.customerId,
        taskId: ctx.taskId,
        source: page.meta.source ?? "web",
        url,
        author: who,
        // A search gives a thread's real title (or none, for a social post). A read page's
        // title is only worth showing when the post came from a plain web page.
        title: page.meta.source ? (page.meta.title ?? null) : (page.meta.pageTitle ?? title ?? null),
        quote: quote.trim(),
        postedAt,
        why: unstyled(why.trim()),
        reply: unstyled(reply.trim()),
        strength,
        // What "Post it" would answer: the comment whose words these are, or else the post.
        replyTo: inComment ? (inComment.ref ?? null) : (page.meta.ref ?? null),
      });
      if (!find) return "Not saved: this customer already has that post from an earlier search. Skip it.";
      if (person) people.add(person);
      saved++;
      pace?.saved();
      return `Saved (${saved} in this task).`;
    },
    {
      name: "save_find",
      description:
        "Save a person worth writing to. Only posts you found or read in this task can be saved, and the quote must be their own words from that page.",
      schema: z.object({
        url: z.string().describe("The post's address, as search_posts or read_page showed it."),
        quote: z.string().min(12).max(700).describe("Their own words, from the post or a comment under it: the ask itself. The card names whoever wrote them."),
        why: z.string().min(10).max(300).describe("One sentence: why this person fits what the customer is after."),
        reply: z.string().min(20).max(1200).describe("The message the customer could post or send, written by the rules of THE QUEST and your instructions."),
        strength: z.enum(["strong", "maybe"]),
        author: z.string().optional(),
        title: z.string().optional(),
        posted_at: z.string().optional().describe("When they posted (ISO date), if the page shows it."),
      }),
    },
  );
}

const placeLine = (p: Place): string => `- ${p.name} (${p.url})${p.rules ? `: ${p.rules}` : ""}`;

/** The places the explorer filed for this customer: where to search first, and where nothing may be saved. */
function placesBlock(places: readonly Place[]): string[] {
  const search = places.filter((p) => p.verdict === "search");
  const avoid = places.filter((p) => p.verdict === "avoid");
  return [
    ...(search.length ? ["", "PLACES TO SEARCH FIRST (their rules were checked; follow what they say)", ...search.slice(0, 15).map(placeLine)] : []),
    ...(avoid.length ? ["", "AVOID (their rules forbid messages like the customer's: nothing found there can be saved)", ...avoid.map(placeLine)] : []),
  ];
}

/** The quest, the customer's brief, their places and their earlier decisions: the scout starts every task knowing them. */
async function scoutOpening(ctx: SubagentContext): Promise<string> {
  const [customer, feedback, places] = await Promise.all([ctx.customer(), ctx.finds.feedback(ctx.customerId), ctx.places.listFor(ctx.customerId)]);
  const play = PLAYBOOK.scout;
  return [
    "THE QUEST: people for what they built (they are a founder or a builder)",
    `What a find is: ${play.finds}`,
    `How fresh: ${play.when}`,
    `Where to look first: ${play.where}`,
    `The message: ${play.message}`,
    ...placesBlock(places),
    "",
    "THE CUSTOMER'S BRIEF",
    customer.brief?.trim() || `(No brief written yet. Their site: ${customer.siteUrl ?? "not given"}. Read it with read_site before you search.)`,
    "",
    "WHAT THEY DECIDED ON EARLIER FINDS",
    feedback,
  ].join("\n");
}

export function scoutSpec(): SubagentSpec {
  return {
    name: "scout",
    description:
      "Finds people who are asking, in public and recently, for what the customer made. It searches Reddit, X, LinkedIn, YouTube, the web, Hacker News, " +
      "Stack Exchange sites, Bluesky, Lemmy, GitHub issues and Mastodon hashtags, reads public threads, and saves " +
      "each find with the person's own words, why they fit and a message the customer could send. Saved finds wait for " +
      "you to show them. It reads the customer's brief and their earlier decisions itself: tell it what to focus on. " +
      "It needs the customer's Chrome connected. Its search does not reach Facebook, Instagram or Threads: work on those goes to outreach.",
    role: "researcher",
    systemPrompt: SCOUT_PROMPT,
    stepBudget: 30,
    finishUp: SAVE_FIRST,
    needsChrome: true,
    tools: (ctx) => {
      const seen = new SeenPages();
      const pace = new ScoutPace();
      return [
        ...searchTools(ctx.posts, { seen, known: (urls) => ctx.finds.known(ctx.customerId, urls), pacing: pace }),
        ...readingTools(ctx.reader, seen, JUDGE_NOW),
        ...browserTools(ctx.browser, ctx.customerId, (v) => seen.record(v.url, v.text, { source: new URL(v.url).hostname, pageTitle: v.title }), ctx.browserSession),
        saveFindTool(ctx, seen, undefined, pace),
      ];
    },
    opening: scoutOpening,
    facts: (ctx) => ctx.finds.taskFacts(ctx.customerId, ctx.taskId),
  };
}
