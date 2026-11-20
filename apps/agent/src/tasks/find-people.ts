import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "langchain";
import { z } from "zod";
import { bareHandle } from "@mq/core";
import { contactSite, handleOf } from "../contacts/handles.ts";
import { foundText, personOf, type PlayFound } from "../finds/play-finder.ts";
import { SearchStreak } from "./search-streak.ts";
import type { SeenPages } from "./seen-pages.ts";
import type { SubagentContext } from "./subagents.ts";

/**
 * Who the picks are, whatever the play says (the founder, 2026-11-11: "likes only" for builders; live, a play for people
 * in pain found none on LinkedIn and three replies went to builders announcing apps). The rest come back as posts worth a like.
 */
const NEED_ONLY =
  "Pick only someone whose own post says they have the problem the customer's product solves, asks for such a thing, or asks for feedback on what they made. " +
  "Someone who only shares or announces what they made is not a pick, however well they fit otherwise.";

/** How many people a run looks for customers for: each is a handful of searches at the site's pace. */
const GIFTS_A_RUN = 2;

/** What the teammate reads after customers_for: the people, and how to hand them over. */
export function giftText(f: Pick<PlayFound, "picks" | "searches" | "stopped">, handle: string, source: string, profile: string | null = null): string {
  const tried = f.searches.map((s) => `"${s.query}"`).join(", ") || "nothing";
  if (!f.picks.length) {
    return f.stopped === "unreachable"
      ? `${source} could not be searched now. Give @${handle} something else (feedback on what they built), and say so in your report.`
      : `Nobody asking for what @${handle} built on ${source} now (searched: ${tried}). Say nothing of it to them: give something else (feedback on what they built), or try one other site.`;
  }
  return [
    `People ready for what @${handle} built (${f.picks.length}):`,
    ...f.picks.map((p, i) => `${i + 1}. ${p.post.author ?? "someone"}${p.post.postedAt ? ` (${p.post.postedAt.toISOString().slice(0, 10)})` : ""} ${p.post.url}\n   "${p.quote}"\n   ${p.why}`),
    `Bring them together, as someone who knows both would. To @${handle}: one reply under a post of theirs you opened, or one message where a message may go, saying what that person is looking for, in a few words, with the link to their post as a bare address. ` +
      `To the person asking, when their post is on a site the customer is on: after the usual check and a like, one reply under their post that @${handle} builds just that${profile ? ` (${profile}: their profile's address, never their site's)` : ""}, in a line, as a tip from someone who came across both. ` +
      "Say of each only what their own public pages say. Nothing about the customer's product and nothing asked in return. Then note_person for each with gave (whom you pointed them to, with the links).",
  ].join("\n");
}

/** The sources find_people searches: the sites cut into posts by code, and the public APIs. */
const SOURCES = ["x", "linkedin", "reddit", "bluesky", "hackernews", "youtube"] as const;

/** The sources find_people covers in this run: none without a finder. */
export function finderSources(ctx: SubagentContext): string[] {
  if (!ctx.finder) return [];
  const offered = new Set(ctx.posts.sources().map((s) => s.name));
  return SOURCES.filter((s) => offered.has(s));
}

/** A site's search page opened in the browser: the way of finding people find_people replaces. */
const SEARCH_PAGES: Readonly<Record<string, RegExp>> = {
  x: /^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\/search\b/i,
  linkedin: /^https?:\/\/(www\.)?linkedin\.com\/search\/results\b/i,
};

const byHand = (source: string) =>
  `Not searched: find_people searches ${source} by code (it writes the searches, judges each post against the play and reads the picks). ` +
  "Call find_people with the play and the site instead, then check each person it gives you and draft.";

/**
 * With find_people there, looking for people by hand is refused: search_posts on a source it covers, and that site's
 * search page in the browser. Live, 2026-10-31: told "Search X (latest) for …" by the manager, the teammate ran
 * search_posts itself and never called find_people.
 */
export function finderFirst(tools: readonly StructuredToolInterface[], covered: readonly string[]): StructuredToolInterface[] {
  if (!covered.length) return [...tools];
  return tools.map((t) => {
    if (t.name !== "search_posts" && t.name !== "browser_open") return t;
    return tool(
      async (args: Record<string, unknown>) => {
        const source = String(args["source"] ?? "");
        if (t.name === "search_posts" && covered.includes(source)) return byHand(source);
        const url = typeof args["url"] === "string" ? args["url"] : "";
        const page = covered.find((s) => SEARCH_PAGES[s]?.test(url));
        if (t.name === "browser_open" && page) return byHand(page);
        const out = await t.invoke(args);
        return typeof out === "string" ? out : JSON.stringify(out);
      },
      { name: t.name, description: t.description, schema: t.schema as never },
    ) as unknown as StructuredToolInterface;
  });
}

/**
 * Finding the people a play names, as one tool call: code searches the site, a cheap judge picks against the play and
 * the customer's decisions, and each pick's post is read before it is quoted (`finds/play-finder.ts`). The teammate's
 * steps go to checking each person and writing to them.
 */
export function findPeopleTool(ctx: SubagentContext, seen: SeenPages, streak: SearchStreak, likeOnly: Set<string> = new Set()): StructuredToolInterface[] {
  const finder = ctx.finder;
  const sources = finderSources(ctx);
  if (!finder || !sources.length) return [];
  // One at a time: live, 2026-10-31, a step asked for two wordings of one play at once, and the two raced on the
  // run's count of empty searches, each stopped after two.
  let last: Promise<unknown> = Promise.resolve();
  let gifts = 0;
  return [
    ...(ctx.people
      ? [
          tool(
            async (args: { profile: string; handle: string; source: string; within?: "day" | "week" | "month" }) => {
              const turn = last.then(() => giftFor(args), () => giftFor(args));
              last = turn;
              return turn;
            },
            {
              name: "customers_for",
              description:
                "The best help for someone the customer got to know: people asking, right now, for what THAT PERSON built. Give the profile of someone kept with note_person " +
                "(what they build, their site) and a site to search; it writes the searches from their product, picks the posts whose authors want such a thing, reads each, and gives " +
                "you up to 3 with their words and links. Hand one or two over to them in one reply or message. For someone who answered the customer or whom you came back to help; two people a run.",
              schema: z.object({
                profile: z.string().url().describe("Their profile's address, as kept with note_person."),
                handle: z.string().min(1).describe("Their handle on that site."),
                source: z.enum(sources as unknown as [string, ...string[]]).describe("The site to search for their customers: where people who need such a thing ask."),
                within: z.enum(["day", "week", "month"]).optional().describe("How fresh the posts must be (default week)."),
              }),
            },
          ),
        ]
      : []),
    tool(
      async (args: { play: string; source: string; within?: "day" | "week" | "month"; want?: number }) => {
        const turn = last.then(() => findFor(args), () => findFor(args));
        last = turn;
        return turn;
      },
      {
        name: "find_people",
        description:
          "Find the people a play names on one site, by code: it writes the searches, runs them in the customer's Chrome, picks the posts whose authors fit the play " +
          "(the customer's decisions and lessons included, nothing older than within), reads each pick's post in full, and gives you each person with their own words. " +
          "It skips posts already answered and people written to lately, and stops after a few searches in a row with nobody new. Use it first to find people; " +
          "then check each one yourself and draft. Call it again only for more people: it never repeats a search that found nobody.",
        schema: z.object({
          play: z.string().min(10).max(1_500).describe("Who to find, in a sentence or two, as the manager put it: who they are, what their post shows, how fresh."),
          source: z.enum(sources as unknown as [string, ...string[]]).describe("The site to search."),
          within: z.enum(["day", "week", "month"]).optional().describe("How fresh their posts must be (default week)."),
          want: z.number().int().min(1).max(8).optional().describe("How many people (default 4)."),
        }),
      },
    ),
  ];

  /** People asking for what someone else built: the gift (the founder, 2026-11-11: "act as a middle man connecting people and get them real customers"). */
  async function giftFor({ profile, handle, source, within }: { profile: string; handle: string; source: string; within?: "day" | "week" | "month" }): Promise<string> {
    const where = contactSite(profile);
    const who = handleOf(profile) ?? bareHandle(handle);
    const contact = where && who ? await ctx.people!.get(ctx.customerId, where, who) : null;
    if (!contact) return "Check them first: read their profile and their site, then keep them with note_person (about: what they build). The searches are written from that.";
    if (gifts >= GIFTS_A_RUN) return `That is ${GIFTS_A_RUN} people this run already: hand over what you have, the rest another time.`;
    gifts++;
    const about = [`What @${contact.handle} builds: ${contact.about}`, contact.siteUrl ? `Its site: ${contact.siteUrl}` : null].filter(Boolean).join("\n");
    const found = await finder!.find({
      customerId: ctx.customerId,
      taskId: ctx.taskId,
      play:
        `People ready, right now, for what @${contact.handle} built, by their own post of the last few days: they ask for such a tool, a recommendation or someone to buy it from, or say the problem it solves is theirs and they are looking for a way out. Someone who would plainly be glad to hear of it today; when in doubt, leave them out. ` +
        `Never someone who builds or sells the same kind of thing, never @${contact.handle} themselves, never a post that only talks about the topic.`,
      about,
      source,
      within: within ?? "week",
      want: 2,
      posts: ctx.posts,
      reader: ctx.reader,
      // Its own count of empty searches, and no trail: these are not the customer's searches.
      streak: new SearchStreak(),
      read: (url, page) => {
        seen.record(url, page.text, { ...(page.post ?? {}), pageTitle: page.title });
        for (const p of page.posts ?? []) seen.record(p.url, p.text, p);
      },
    });
    // Only the surely ready: a maybe handed over as a customer costs the trust the gift is for.
    const ready = found.picks.filter((p) => p.fit === "strong" && personOf(p.post.url, p.post.author) !== contact.handle.toLowerCase());
    return giftText({ ...found, picks: ready }, contact.handle, source, contact.profileUrl);
  }

  async function findFor({ play, source, within, want }: { play: string; source: string; within?: "day" | "week" | "month"; want?: number }): Promise<string> {
    const found = await finder!.find({
      customerId: ctx.customerId,
      taskId: ctx.taskId,
      play: `${play.trim()} ${NEED_ONLY}`,
      source,
      within: within ?? "week",
      want: want ?? 4,
      posts: ctx.posts,
      reader: ctx.reader,
      streak,
      searched: (s, query, urls) => ctx.trail?.add(s, query, urls),
      read: (url, page) => {
        seen.record(url, page.text, { ...(page.post ?? {}), pageTitle: page.title });
        for (const p of page.posts ?? []) seen.record(p.url, p.text, p);
        seen.opened(url, (page.posts ?? []).map((p) => ({ author: personOf(p.url, p.author ?? null), text: p.text })));
        seen.account(page.account, page.url);
      },
    });
    for (const l of found.likes) {
      seen.record(l.post.url, l.post.text, l.post);
      likeOnly.add(l.post.url);
    }
    if (!found.picks.length && !found.likes.length) ctx.nobodyFound?.(source);
    return foundText(found, { source, within: within ?? "week" });
  }
}
