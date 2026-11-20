import { ReadError, type PageReader, type PageText } from "@mq/core";
import { tool } from "langchain";
import { z } from "zod";
import { CHROME_OFFLINE, searchTools } from "./search-tools.ts";
import type { SeenMeta, SeenPages } from "./seen-pages.ts";
import { personOf } from "../finds/play-finder.ts";
import type { SubagentSpec } from "./subagents.ts";
import { browserTools } from "../chrome/browser.ts";

const PAGE_CHARS = 6_000;

const pageBlock = (p: PageText, max = PAGE_CHARS): string =>
  [`## ${p.title || "(untitled)"} — ${p.url}`, p.description ? `Description: ${p.description}` : "", p.text.slice(0, max)]
    .filter(Boolean)
    .join("\n");

/** What a read page tells the ledger: who posted it and when, when the reader knows. */
const metaOf = (p: PageText): SeenMeta => ({ ...(p.post ?? {}), pageTitle: p.title, ...(p.comments?.length ? { comments: p.comments } : {}) });

const failure = (url: string, e: unknown): string => {
  if (!(e instanceof ReadError)) return `Could not read ${url}: ${e instanceof Error ? e.message : String(e)}.`;
  const line = `Could not read ${url}: ${e.reason} (${e.message}).`;
  switch (e.reason) {
    // A refusal is the site's answer, and Quest takes it: no mirrors, caches or side doors.
    case "blocked":
      return (
        `${line} That is final: do not try to reach its pages another way ` +
        "(other subdomains, mirrors, caches, archives, proxies or search-engine copies). Note it in your report and move on."
      );
    case "offline":
      return `${line} ${CHROME_OFFLINE}`;
    case "hidden":
      return `${line} This page needs the customer's Chrome window to be on screen. Skip pages like it for now and say so in your report.`;
    case "limit":
      return `${line} Quest has read as many pages as it reads in a day. Stop reading and write your report.`;
    default:
      return line;
  }
};

/** `seen`, when given, keeps every page read, so what a subagent saves can be checked against it. */
/** `afterRead`, when given, ends every page read_page returns (the scout's "judge it now"). */
/** A post's own id in its address: X's status, Reddit's comments, Threads' and Instagram's post or reel. */
const POST_ID = /\/(?:status|comments|post|posts|p|reel|video)\/([A-Za-z0-9_-]{5,})/;

/** Whether a page opened for a post's address landed where that post is not (its id gone from the address). */
export function elsewhere(asked: string, landed: string): boolean {
  try {
    const id = POST_ID.exec(new URL(asked).pathname)?.[1];
    return Boolean(id && !new URL(landed).pathname.includes(id));
  } catch {
    return false;
  }
}

export function readingTools(reader: PageReader, seen?: SeenPages, afterRead?: string) {
  const readSite = tool(
    async ({ url, pages }) => {
      try {
        const site = await reader.readSite(url, { pages: pages ?? 4 });
        for (const p of site.pages) seen?.record(p.url, p.text, metaOf(p));
        return site.pages.map((p) => pageBlock(p)).join("\n\n") || `The site at ${url} had no readable text.`;
      } catch (e) {
        return failure(url, e);
      }
    },
    {
      name: "read_site",
      description:
        "Read a website the way a visitor would: its first page, then up to three pages it links to that say " +
        "more about what it sells (pricing, product, about). Use this first for a company's own site.",
      schema: z.object({
        url: z.string().describe("The site's address, e.g. https://example.com"),
        pages: z.number().int().min(1).max(4).optional().describe("How many of its pages, the first one included (default 4)."),
      }),
    },
  );

  const readPage = tool(
    async ({ url, as_visitor }) => {
      try {
        const page = await reader.readPage(url, as_visitor ? { asVisitor: true } : {});
        // A post's address that opened another page (Threads sends one it cannot show to its author's profile) is not
        // that post: what the page shows is filed where it is. Live, 2026-11-04: a like and a reply drafted at such an
        // address went to the profile, and the like was pressed on no post of theirs.
        const moved = elsewhere(url, page.url);
        if (!moved) seen?.record(url, page.text, metaOf(page));
        if (page.url !== url) seen?.record(page.url, page.text, metaOf(page));
        // A search or a listing cut into posts: each post is seen with its own words, so it can be saved from here.
        for (const p of page.posts ?? []) if (!p.preview) seen?.record(p.url, [p.title, p.text].filter(Boolean).join("\n"), p);
        // Opened itself, with what is under its post: a reply is drafted only from here (outreach_draft).
        const posts = (page.posts ?? []).map((p) => ({ author: personOf(p.url, p.author ?? null), text: [p.title, p.text].filter(Boolean).join("\n") }));
        if (!moved) seen?.opened(url, posts);
        if (page.url !== url) seen?.opened(page.url, posts);
        seen?.account(page.account, page.url);
        const block = pageBlock(page, 12_000);
        const note = moved ? `That address opened ${page.url} instead: the post at ${url} is not there (removed, or not its own address). Like, reply or save only at an address a page showed for the post.\n\n` : "";
        return `${note}${afterRead ? `${block}\n\n${afterRead}` : block}`;
      } catch (e) {
        return failure(url, e);
      }
    },
    {
      name: "read_page",
      description:
        "Read one web page's text. Use it for a specific page the site read did not cover. Pages open logged in as the customer; " +
        "set as_visitor to see a page as someone who is not logged in, which is the only way to tell whether their own post or comment shows to others " +
        "(logged in, they still see their own removed ones).",
      schema: z.object({
        url: z.string().describe("The page's full address."),
        as_visitor: z.boolean().optional().describe("Read it as someone who is not logged in: what others see."),
      }),
    },
  );

  return [readSite, readPage];
}

const RESEARCHER_PROMPT = `You are the researcher on Quest's team. Quest finds a founder's first customers: the people online who already need what they built. Your manager gives you research tasks; you work alone and report back to your manager, not to the customer.

How you work:
- Your manager tells you what to find; you choose how. If the instructions name addresses, routes or a page budget for something one of your tools does better (search_posts searches Reddit, the web, Bluesky, Mastodon hashtags, Hacker News and the rest directly), use the tool, and say in your report that you did.
- Read before you conclude. For a company's site, use read_site first, then read_page for anything it did not cover.
- You read in the customer's own Chrome, logged in where they are; when it is closed, public pages are read for you without it (Reddit and logged-in pages need it). Use browser_open/browser_act for interactive pages and workspace searches. Outgoing work goes through the outreach teammate's recorded drafts. To find people and posts, use search_posts: Reddit is searched in their Chrome, the web through a search engine, the other communities through their own public search. Try a few phrasings people with the problem would use. Then read_page the most promising threads to see the whole conversation.
- Search with search_posts, never by opening a search engine's result pages with read_page.
- Never invent facts, quotes, prices, customers or numbers. If the site does not say, say "not stated".
- If something essential is ambiguous and the site cannot settle it (for example, two very different audiences), use ask_human with 2-4 short options. Ask at most one question at a time, and only when the answer would change your report.
- Keep notes in your todo list if the task has several steps.
- The customer's own accounts and pages (their profile, posts, comments, inbox) are found by opening the site in their Chrome with browser_open: signed in, the page shows who they are (yourProfile is their own profile's link). Never search the web for the customer, their name or their accounts.
- A page that says signedIn false asks for a sign-in. When your task needs their account on that site, stop there and report it at once: they have to sign in to it in Chrome themselves. Do not search for another way in.
- Some sites refuse a reader or show a bot check, and some show only a login page (X, LinkedIn, Facebook, Instagram). When a site refuses you, that is final: never go around it through mirrors, alternative front-ends, caches, archives, proxies or search-engine copies, even if your instructions suggest it. Say so in your report.
- Guessed addresses mostly lead nowhere. Prefer links you have seen on a page you read.
- You have a limited number of steps. When you are told you are near the end, stop and report what you have.

Your final message is your report to your manager. Plain text, no preamble. If your manager asked for something specific (for example, posts where people ask for help), report exactly that, with the address of every page you cite, and say what you could not reach. Otherwise, under 350 words, in this shape:
What it is: one or two sentences.
Who it's for: the specific people who would buy or use it.
The problem it solves: in the words those people would use.
Words they use: 5-10 phrases a person with this problem would type or say.
Where they talk: 3-6 specific online places (named communities, forums, sites) where such people ask about this problem, each with one line on why.
Doesn't add up: anything on the site that contradicts itself, looks out of date, or differs from what your instructions say they told your manager, with both in quotes; or "nothing".
Open questions: anything you could not settle.`;

/**
 * `needsChrome` false: public pages and web search have another way to run (the web reader), so the task starts
 * with the customer's Chrome closed; only Reddit and logged-in pages then wait for it.
 */
export function researcherSpec(opts: { needsChrome?: boolean } = {}): SubagentSpec {
  const needsChrome = opts.needsChrome ?? true;
  return {
    name: "researcher",
    description:
      "Reads a website or specific pages and reports what the product is, who it is for, " +
      "the problem it solves in its buyers' words, and where those people talk online. Give it the address and what to find out. " +
      "It can also search Reddit, the web, Hacker News, Stack Exchange sites, Bluesky, Lemmy, GitHub issues and Mastodon hashtags " +
      "to answer a research question (what people complain about, where they talk). To find people to reply to, use the scout. " +
      (needsChrome
        ? "It needs the customer's Chrome connected. "
        : "It reads public pages and searches the web even when the customer's Chrome is closed; Reddit needs their Chrome. ") +
      "It can inspect any logged-in workspace with browser_open/browser_act, including member-only forums and social sites. Access depends on the customer's existing login, not a fixed platform list.",
    role: "researcher",
    systemPrompt: RESEARCHER_PROMPT,
    stepBudget: 20,
    needsChrome,
    tools: (ctx) => [...readingTools(ctx.reader), ...searchTools(ctx.posts), ...browserTools(ctx.browser, ctx.customerId, undefined, ctx.browserSession)],
  };
}
