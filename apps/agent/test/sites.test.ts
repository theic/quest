import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { customerId, HostGuard, type ChromeJob, type ChromeRead, type FoundPost } from "@mq/core";
import { tool } from "langchain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChromeReader } from "../src/chrome/chrome-reader.ts";
import { SiteSource } from "../src/chrome/chrome-sources.ts";
import { agoDate, INDIE_HACKERS, leadingCount, LINKEDIN, readerFor, X, YOUTUBE } from "../src/chrome/sites.ts";
import { BatchJudge } from "../src/finds/batch-judge.ts";
import { PlayFinder } from "../src/finds/play-finder.ts";
import { silentLogger } from "../src/infra/system.ts";
import { finderFirst } from "../src/tasks/find-people.ts";
import { readingTools } from "../src/tasks/researcher.ts";
import { SearchStreak } from "../src/tasks/search-streak.ts";
import { SeenPages } from "../src/tasks/seen-pages.ts";

const NOW = new Date("2026-10-23T14:00:00Z");
const guard = () => new HostGuard({ resolve: async () => ["93.184.216.34"], unresolved: "refuse" });

const read = (url: string, rows: ChromeRead["rows"], over: Partial<ChromeRead> = {}): ChromeRead => ({ url, status: 200, title: "", description: null, text: "page words", links: [], rows, visible: false, ...over });

/** Rows as the extension took them from X's search in the dev founder's Chrome (2026-10-23), in Ukrainian as it showed. */
const X_ROWS = [
  { href: "https://x.com/makerthree/status/2112967369996091430", at: "2026-10-21T18:00:52.000Z", name: "Em · solo SaaS founder\n@makerthree\n·\n21 жовт.", text: "The Ultimate Launch Guide 2026: 47 places worth considering when launching a SaaS.", replies: "22 Відповіді. Відповідь" },
  { href: "https://x.com/dimon3m/status/2112839910415577560?s=20", at: "2026-10-21T09:34:23.000Z", name: "Dima\n@dimon3m", text: "Which form tool do you use for your waitlist? Typeform caps my responses.", replies: "0 Відповідей. Відповідь" },
  // A promoted post: no time, no status link.
  { href: null, at: null, name: "Some brand\n@brand", text: "Buy our thing", replies: null },
];

describe("the big sites, cut into posts by code", () => {
  it("reads X's search as posts with their own addresses, counts in any language, and no promoted posts", () => {
    const posts = X.postsFrom(read("https://x.com/search?q=waitlist&f=live", { tweets: X_ROWS }), NOW);
    expect(posts).toEqual([
      expect.objectContaining({ source: "x", url: "https://x.com/makerthree/status/2112967369996091430", author: "makerthree", replies: 22, postedAt: new Date("2026-10-21T18:00:52.000Z") }),
      expect.objectContaining({ url: "https://x.com/dimon3m/status/2112839910415577560", author: "dimon3m", replies: 0, text: expect.stringContaining("Which form tool") }),
    ]);
    expect(X.searchUrl!({ source: "x", query: "typeform alternative", within: "week" }, NOW)).toBe("https://x.com/search?q=typeform%20alternative%20since%3A2026-10-16&f=live");
  });

  it("reads LinkedIn's posts with the link to each when it has one, else where its author's last posts are", () => {
    const rows = [
      { urn: null, text: "Looking for a form builder that does waitlists … more", actor: "https://www.linkedin.com/in/tymon-podlaszewski/", link: null, all: "Feed post\nTymon Podlaszewski\n• 3rd+\nFounder\n11m\nFollow\nLooking for…" },
      { urn: null, text: "The people pricing your risk have never visited your site.", actor: "https://www.linkedin.com/in/alexsidorenko/", link: "https://www.linkedin.com/feed/update/urn:li:share:7519375159468720128/", all: "Feed post\nAlex\n2d • Edited\nJoin" },
      { urn: null, text: "A group post", actor: "https://www.linkedin.com/company/youzse/", link: "https://www.linkedin.com/groups/2046019/?q=highlightedFeedForGroups&highlightedUpdateUrn=urn%3Ali%3Aactivity%3A7519376200834670592", all: "1yr" },
      { urn: null, text: null, actor: "https://www.linkedin.com/in/nobody/", link: null, all: "" },
      { urn: null, text: "Our CRM does it all", actor: "https://www.linkedin.com/company/acme/", link: null, all: "Feed post\nAcme\nPromoted\nOur CRM does it all" },
      { urn: null, text: "Who else is tired of posting?", actor: "https://www.linkedin.com/in/andrew-%E2%98%85/", link: null, all: "3h" },
    ];
    const posts = LINKEDIN.postsFrom(read("https://www.linkedin.com/search/results/content/?keywords=x", { posts: rows }), NOW);
    expect(posts.map((p) => [p.url, p.author])).toEqual([
      ["https://www.linkedin.com/in/tymon-podlaszewski/recent-activity/all/", "tymon-podlaszewski"],
      ["https://www.linkedin.com/feed/update/urn:li:share:7519375159468720128/", "alexsidorenko"],
      ["https://www.linkedin.com/feed/update/urn:li:activity:7519376200834670592/", "youzse"],
      ["https://www.linkedin.com/in/andrew-%E2%98%85/recent-activity/all/", "andrew-★"],
    ]);
    expect(posts[0]!.text).toBe("Looking for a form builder that does waitlists");
    expect(posts[0]!.postedAt).toEqual(new Date(NOW.getTime() - 11 * 60_000));
    expect(posts[1]!.postedAt).toEqual(new Date(NOW.getTime() - 2 * 86_400_000));
  });

  it("reads YouTube's videos and Indie Hackers' list as previews, to be read before anyone is quoted", () => {
    const [video] = YOUTUBE.postsFrom(
      read("https://www.youtube.com/results?search_query=typeform", {
        videos: [{ href: "https://www.youtube.com/watch?v=24Iy4NExkEo&pp=ygUU", title: "Best Typeform Alternatives 2026", channel: "Tool Clash", channelHref: "https://www.youtube.com/@toolclash", meta: "984\n3mo ago", desc: "From Uformm's free plan to Tally" }],
      }),
      NOW,
    );
    expect(video).toMatchObject({ source: "youtube", url: "https://www.youtube.com/watch?v=24Iy4NExkEo", author: "@toolclash", preview: true });
    const [story] = INDIE_HACKERS.postsFrom(
      read("https://www.indiehackers.com/newest", { stories: [{ href: "https://www.indiehackers.com/post/why-did-you-create-your-project-19305073c0", title: "Why did you create your project?", user: "SolodeveloperJr", comments: "0", ago: "25m" }] }),
      NOW,
    );
    expect(story).toMatchObject({ source: "indiehackers", author: "SolodeveloperJr", replies: 0, preview: true, postedAt: new Date(NOW.getTime() - 25 * 60_000) });
  });

  it("knows which pages it cuts (an X thread too), and leaves other pages to the page reader", () => {
    expect(readerFor("https://x.com/search?q=a&f=live")?.key).toBe("x");
    expect(readerFor("https://x.com/makerthree")?.key).toBe("x");
    expect(readerFor("https://x.com/makerthree/status/1")?.key).toBe("x");
    expect(readerFor("https://x.com/makerthree/status/1/photo/1")).toBeNull();
    expect(readerFor("https://www.linkedin.com/in/someone/recent-activity/all/")?.key).toBe("linkedin");
    expect(readerFor("https://www.linkedin.com/in/someone/")).toBeNull();
    expect(readerFor("https://www.indiehackers.com/newest")?.key).toBe("indiehackers");
    expect(readerFor("https://www.indiehackers.com/post/abc")).toBeNull();
    expect(readerFor("https://example.com/")).toBeNull();
  });

  it("reads ages and counts the way the sites write them", () => {
    expect(agoDate("3mo ago", NOW)).toEqual(new Date(NOW.getTime() - 90 * 86_400_000));
    expect(agoDate("5 days ago", NOW)).toEqual(new Date(NOW.getTime() - 5 * 86_400_000));
    expect(agoDate("1yr", NOW)).toEqual(new Date(NOW.getTime() - 365 * 86_400_000));
    expect(agoDate("21 жовт.", NOW)).toBeNull();
    expect(leadingCount("1.2K replies")).toBe(1200);
    expect(leadingCount("1,5 тис. відповідей")).toBe(1500);
    expect(leadingCount("1 743 перегляди")).toBe(1743);
    expect(leadingCount("Reply")).toBeNull();
  });

  it("searches X in their Chrome, and says so when they are not signed in there", async () => {
    const jobs: ChromeJob[] = [];
    const posts = await new SiteSource(X, async (j) => (jobs.push(j), read(j.url, { tweets: X_ROWS })), () => NOW).search({ source: "x", query: "waitlist form" }, 1);
    expect(posts).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ take: { specs: { tweets: expect.anything() } }, waitFor: "article[data-testid='tweet']" });
    expect(jobs[0]!.drawn).toBeUndefined();
    const signedOut = new SiteSource(X, async () => read("https://x.com/i/flow/login", { tweets: [] }), () => NOW);
    await expect(signedOut.search({ source: "x", query: "a" }, 5)).rejects.toMatchObject({ reason: "unavailable", message: expect.stringContaining("not signed in to x.com") });
  });

  it("gives read_page a search page as its posts, each saved as seen, and the page as it is when nothing could be cut", async () => {
    const pages = [read("https://x.com/search?q=waitlist&f=live", { tweets: X_ROWS }), read("https://x.com/search?q=other&f=live", { tweets: [] }, { text: "No results for other" })];
    const reader = new ChromeReader(async () => pages.shift()!, guard(), { now: () => NOW });
    const seen = new SeenPages();
    const readPage = readingTools(reader, seen)[1] as unknown as { invoke(a: { url: string }): Promise<unknown> };
    const out = String(await readPage.invoke({ url: "https://x.com/search?q=waitlist&f=live" }));
    expect(out).toContain("[x] 2026-10-21 by dimon3m, 0 replies\nhttps://x.com/dimon3m/status/2112839910415577560\nWhich form tool");
    expect(out).not.toContain("page words");
    expect(seen.get("https://x.com/dimon3m/status/2112839910415577560")?.text).toContain("Typeform caps my responses");
    expect(String(await readPage.invoke({ url: "https://x.com/search?q=other&f=live" }))).toContain("No results for other");
  });
});

const post = (n: number, text: string, over: Partial<FoundPost> = {}): FoundPost => ({ source: "x", url: `https://x.com/p${n}/status/${n}`, author: `p${n}`, title: null, text, postedAt: new Date("2026-10-20T00:00:00Z"), replies: 0, ...over });

describe("judging many posts at once on a cheap seat", () => {
  it("keeps the picks with the person's own words, strong first, and drops a quote that is not in the post", async () => {
    let prompt = "";
    const model = fakeModel().respond((messages) => {
      prompt = String(messages.at(-1)!.content);
      return new AIMessage(
        JSON.stringify({
          picks: [
            { n: 3, fit: "maybe", quote: "thinking about moving off Typeform", why: "Might switch." },
            { n: 1, fit: "strong", quote: "Which form tool do you use for your waitlist?", why: "Asks for a form tool." },
            { n: 2, fit: "strong", quote: "I need a new form builder today", why: "Invented." },
          ],
        }),
      );
    });
    const judge = new BatchJudge({ models: { modelFor: () => model } as never, log: silentLogger, now: () => NOW });
    const posts = [
      post(1, "Which form tool do you use for your waitlist? Typeform caps my responses."),
      post(2, "Shipped our new landing page today!"),
      post(3, "I am thinking about moving off Typeform next month."),
      post(4, "Which form tool is best?", { postedAt: new Date("2024-01-01T00:00:00Z") }),
    ];
    const out = await judge.judge({ customerId: null, brief: "A form builder for waitlists.", posts });
    expect(out.judged.map((j) => [j.post.author, j.fit])).toEqual([["p1", "strong"], ["p3", "maybe"]]);
    expect(out).toMatchObject({ looked: 3, unquoted: 1, calls: 1 });
    expect(prompt).toContain("A form builder for waitlists.");
    expect(prompt).toContain("#1 [x] 2026-10-20 by p1, 0 replies");
    expect(prompt).not.toContain("Which form tool is best?"); // older than the quest allows: never looked at
  });

  it("splits a long list into batches", async () => {
    const model = fakeModel().respond(new AIMessage('{"picks":[]}')).respond(new AIMessage("not json"));
    const judge = new BatchJudge({ models: { modelFor: () => model } as never, log: silentLogger, now: () => NOW });
    const out = await judge.judge({ customerId: null, brief: "b", posts: Array.from({ length: 45 }, (_, i) => post(i + 1, `post number ${i + 1} about forms`)) });
    expect(out).toMatchObject({ looked: 45, calls: 2, judged: [] });
  });

  it("counts a batch no model answered, and judges the rest", async () => {
    let calls = 0;
    const model = {
      invoke: async () => {
        if (++calls === 1) throw new Error("Request timed out.");
        return new AIMessage(JSON.stringify({ picks: [{ n: 1, fit: "strong", quote: "post number 3 about forms", why: "Asks." }] }));
      },
    };
    const judge = new BatchJudge({ models: { modelFor: () => model } as never, log: silentLogger, batch: 2, now: () => NOW });
    const out = await judge.judge({ customerId: null, brief: "b", posts: Array.from({ length: 4 }, (_, i) => post(i + 1, `post number ${i + 1} about forms`)) });
    expect(out).toMatchObject({ calls: 2, failed: 1 });
    expect(out.judged.map((j) => j.post.author)).toEqual(["p3"]);
  });
});

describe("people for a play, found by code", () => {
  it("skips a search that found nobody before, reads each pick before it is quoted, drops one the customer already answered, and stops after searches with nobody new", async () => {
    const searched: string[] = [];
    const model = {
      invoke: async (messages: { content: unknown }[]) => {
        const system = String(messages[0]!.content);
        if (system.startsWith("You plan searches")) return new AIMessage(JSON.stringify({ queries: ["found nobody", "just shipped", "launched my app", "nothing a", "nothing b", "nothing c", "nothing d", "nothing e", "nothing f", "never reached"] }));
        const shown = String(messages.at(-1)!.content);
        const picks = [...shown.matchAll(/#(\d+) [^\n]*\n([^\n]*shipped[^\n]*)/g)].map((m) => ({ n: Number(m[1]), fit: "strong", quote: m[2]!.slice(0, 30), why: "Shipped their app." }));
        return new AIMessage(JSON.stringify({ picks }));
      },
    };
    const posts = {
      sources: () => [],
      search: async (q: { query: string }) => {
        searched.push(q.query);
        if (q.query === "just shipped") return [post(1, "I just shipped my habit tracker for founders"), post(2, "I just shipped a CLI for invoices, first users welcome")];
        if (q.query === "launched my app") return [post(3, "Finally shipped my recipe app after two years")];
        return [post(9, "a thread about the weather")];
      },
    };
    const reader = new ChromeReader(async (job: ChromeJob) => {
      const n = Number(/status\/(\d+)/.exec(job.url)![1]);
      const words = { 1: "I just shipped my habit tracker for founders", 2: "I just shipped a CLI for invoices, first users welcome", 3: "Finally shipped my recipe app after two years" }[n]!;
      const tweets = [{ href: `https://x.com/p${n}/status/${n}`, at: "2026-10-20T00:00:00.000Z", text: words, replies: "1 reply" }];
      // Under the second one, the customer has answered already.
      if (n === 2) tweets.push({ href: "https://x.com/serhii/status/77", at: "2026-10-21T00:00:00.000Z", text: "nice, how do you price it?", replies: "0" });
      return read(job.url, { tweets, me: [{ href: "https://x.com/serhii" }] });
    }, guard(), { now: () => NOW });
    const finder = new PlayFinder({
      models: { modelFor: () => model } as never,
      customers: { get: async () => ({ brief: "Quest finds people for founders.", siteUrl: null }) as never },
      memory: { list: async () => [{ kind: "decision", text: "Founders only." }] as never },
      finds: { known: async () => new Set<string>() },
      searches: { recent: async () => [{ site: "x.com", query: "found nobody", hits: 0, agent: "outreach", at: NOW }] },
      log: silentLogger,
      now: () => NOW,
    });
    const streak = new SearchStreak(async () => new Set(["x.com|found nobody"]));
    const trail: string[] = [];
    const found = await finder.find({ customerId: customerId("c"), taskId: null, play: "founders who just shipped", source: "x", within: "week", want: 4, posts: posts as never, reader, streak, searched: (_s, q) => trail.push(q) });

    expect(found.picks.map((p) => p.post.author)).toEqual(["p1", "p3"]);
    expect(found.picks[0]!.quote).toBe("I just shipped my habit tracke");
    expect(found.skipped).toEqual(["found nobody"]);
    expect(searched).toEqual(["just shipped", "launched my app", "nothing a", "nothing b", "nothing c", "nothing d", "nothing e", "nothing f"]);
    expect(trail).toEqual(searched);
    expect(found).toMatchObject({ stopped: "empty", dropped: 1 });
    expect(streak.spent("x|founders who just shipped", 6)).toBe(true);
    // Dry for founders on X: another site, or another play, still searches.
    expect(streak.spent("reddit|founders who just shipped")).toBe(false);
    expect(streak.spent("x|people asking for a habit tracker")).toBe(false);
  });

  it("refuses looking for people by hand where find_people searches", async () => {
    const ran: string[] = [];
    const fake = (name: string) => tool(async (a: Record<string, unknown>) => (ran.push(`${name} ${JSON.stringify(a)}`), "ran"), { name, description: name, schema: z.object({ source: z.string().optional(), url: z.string().optional(), query: z.string().optional() }) });
    const [search, open] = finderFirst([fake("search_posts"), fake("browser_open")], ["x", "linkedin"]);

    expect(await search!.invoke({ source: "x", query: "just shipped" })).toMatch(/^Not searched: find_people searches x by code/);
    expect(await open!.invoke({ url: "https://x.com/search?q=shipped&f=live" })).toMatch(/find_people/);
    expect(await search!.invoke({ source: "web", query: "just shipped" })).toBe("ran");
    expect(await open!.invoke({ url: "https://x.com/theIcreator/with_replies" })).toBe("ran");
    expect(ran).toHaveLength(2);
  });
});
