import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { MemorySaver } from "@langchain/langgraph";
import { customerId, taskId, type CustomerId, type FoundPost } from "@mq/core";
import { tool } from "langchain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildAgent, RepeatGuard, SAME_CALL_LIMIT } from "../src/agents/harness.ts";
import { PgSearches } from "../src/infra/pg-searches.ts";
import { managerTools } from "../src/manager/tools.ts";
import { canonical, SearchTrail, searchesBlock } from "../src/tasks/search-trail.ts";
import { onSite, pinToSite, searchRefusal, siteBriefing, siteOf } from "../src/tasks/site-pin.ts";
import { makeWorld, telegramSender } from "./world.ts";

type World = ReturnType<typeof makeWorld>;

const HELPFUL = "Cookie-free analytics needs no banner at all, since nothing personal is stored. We built one for exactly this, hosted in the EU.";

const post = (over: Partial<FoundPost> = {}): FoundPost => ({
  source: "hackernews",
  url: "https://news.ycombinator.com/item?id=41",
  author: "macro-b",
  title: "Ask HN: analytics without cookie banners?",
  text: "I would like to avoid bugging users with cookie banners and consent forms. Any privacy friendly analytics hosted in the EU?",
  postedAt: new Date("2026-09-20T10:00:00Z"),
  replies: 3,
  ...over,
});

async function founder(world: World): Promise<CustomerId> {
  const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
  await world.customers.update(c.id, { brief: "Plausible: cookie-free, EU-hosted web analytics for small businesses.", status: "active", sweptAt: new Date(0) });
  return c.id;
}

function toolsOf(world: World, id: CustomerId) {
  const tools = managerTools({ ...world, customerId: id, userTurn: true, customers: world.customers, now: world.clock.now });
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

const openingOf = (model: ReturnType<typeof fakeModel>, call = 0): string => String((model.calls[call]!.messages.find((m) => m instanceof HumanMessage) as HumanMessage).content);
const toolAnswers = (model: ReturnType<typeof fakeModel>): string[] =>
  model.calls.flatMap((c) => c.messages.filter((m): m is ToolMessage => m instanceof ToolMessage).map((m) => String(m.content)));

describe("the site the customer named", () => {
  it("is known by what people call it", () => {
    expect(siteOf("X")).toBe("x.com");
    expect(siteOf("twitter")).toBe("x.com");
    expect(siteOf("https://twitter.com/someone/status/1")).toBe("x.com");
    expect(siteOf("www.LinkedIn.com")).toBe("linkedin.com");
    expect(siteOf("r/SaaS")).toBeNull();
    expect(siteOf("reddit")).toBe("reddit.com");
    expect(siteOf("Hacker News")).toBe("news.ycombinator.com");
    expect(siteOf("the forums")).toBeNull();
    expect(onSite("https://mobile.twitter.com/a/status/2", "x.com")).toBe(true);
    expect(onSite("https://old.reddit.com/r/SaaS/comments/1", "reddit.com")).toBe(true);
    expect(onSite("https://www.reddit.com/r/Twitter/comments/1", "x.com")).toBe(false);
  });

  it("keeps a search on that site", () => {
    expect(searchRefusal("x.com", "reddit")).toMatch(/^Not searched: reddit is not x\.com.*Search x\.com itself: .*search_posts with source x/);
    expect(searchRefusal("x.com", "x")).toBeNull();
    expect(searchRefusal("x.com", "web", "site:x.com")).toBeNull();
    expect(searchRefusal("reddit.com", "reddit")).toBeNull();
    expect(searchRefusal("reddit.com", "web")).toMatch(/^Not searched/);
    expect(siteBriefing("x.com")).toMatch(/^THIS TASK WORKS ON x\.com ONLY/);
  });

  it("wraps a task's tools so nothing reads, opens, saves or leaves for another site", async () => {
    const ran: string[] = [];
    const urlTool = (name: string) => tool(async ({ url }) => (ran.push(`${name} ${url}`), `${name} ok`), { name, description: name, schema: z.object({ url: z.string() }) });
    const act = tool(async () => (ran.push("act"), JSON.stringify({ url: "https://www.reddit.com/r/Twitter/" })), { name: "browser_act", description: "act", schema: z.object({ kind: z.string() }) });
    const other = tool(async () => "todo ok", { name: "write_todos", description: "todos", schema: z.object({}) });
    const tools = Object.fromEntries(pinToSite([urlTool("read_page"), urlTool("browser_open"), urlTool("save_find"), act, other], "x.com").map((t) => [t.name, t]));

    expect(await tools["read_page"]!.invoke({ url: "https://www.reddit.com/r/ArtRanting/comments/1/" })).toMatch(/^Not done: reddit\.com is not x\.com/);
    expect(await tools["save_find"]!.invoke({ url: "https://twitter.com/a/status/9" })).toBe("save_find ok");
    expect(await tools["browser_open"]!.invoke({ url: "https://x.com/search?q=first%20users&f=live" })).toBe("browser_open ok");
    expect(await tools["browser_act"]!.invoke({ kind: "click" })).toMatch(/That click left x\.com: open x\.com again/);
    expect(await tools["write_todos"]!.invoke({})).toBe("todo ok");
    expect(ran).toEqual(["save_find https://twitter.com/a/status/9", "browser_open https://x.com/search?q=first%20users&f=live", "act"]);
  });
});

describe("starting work where they asked for it", () => {
  it("pins the task to the site, and gives a site the scout cannot search to outreach", async () => {
    const world = makeWorld();
    const id = await founder(world);
    const tools = toolsOf(world, id);

    expect(await tools["start_task"]!.invoke({ agent: "scout", title: "People on Facebook", instructions: "Find people asking for customers.", site: "Facebook" })).toMatch(
      /^Not started: the scout's search does not reach facebook\.com\. Give it to outreach, with site facebook\.com/,
    );
    expect(await tools["start_task"]!.invoke({ agent: "outreach", title: "People on X", instructions: "Find people asking for customers.", site: "the forums" })).toMatch(/^Not started: "the forums" is not a site/);
    expect(await tools["start_task"]!.invoke({ agent: "outreach", title: "People on X", instructions: "Find people asking for customers.", site: "twitter.com" })).toMatch(
      /^Started task .* for the outreach, on x\.com only\./,
    );
    const [task] = await world.tasks.list(id);
    expect(task).toMatchObject({ agent: "outreach", site: "x.com" });
  });

  it("starts one task for one ask, even when a step asks for two at once", async () => {
    const world = makeWorld();
    const id = await founder(world);
    const tools = toolsOf(world, id);
    const [first, second] = await Promise.all([
      tools["start_task"]!.invoke({ agent: "scout", title: "Founders asking for users", instructions: "Find founders asking how to get users." }),
      tools["start_task"]!.invoke({ agent: "scout", title: "Fresh founders", instructions: "Find founders asking how to get users, this week only." }),
    ]);
    expect(first).toMatch(/^Started task/);
    expect(second).toMatch(/^Not started: you already started the scout this turn \(.*"Founders asking for users"\)\. One ask is one task/);
    expect(await world.tasks.list(id)).toHaveLength(1);
    // Another teammate, or the same one on another site, is another ask.
    expect(await tools["start_task"]!.invoke({ agent: "scout", title: "On HN", instructions: "Find founders on HN.", site: "news.ycombinator.com" })).toMatch(/^Started task/);
  });
});

describe("a run that remembers what its searches came to", () => {
  it("keeps a pinned run on its site, credits the search that found the person, and tells the next run", async () => {
    const researcher = fakeModel()
      .respondWithTools([{ name: "read_page", args: { url: "https://www.reddit.com/r/analytics/comments/1/" } }])
      .respondWithTools([{ name: "search_posts", args: { source: "hackernews", query: "cookie banner analytics" } }])
      .respondWithTools([{ name: "search_posts", args: { source: "hackernews", query: "gdpr dashboards" } }])
      .respondWithTools([
        { name: "save_find", args: { url: post().url, quote: "Any privacy friendly analytics hosted in the EU?", why: "Asks for EU-hosted analytics.", reply: HELPFUL, strength: "strong" } },
      ])
      .respond(new AIMessage("Saved 1 find from Hacker News."))
      .respond(new AIMessage("Nothing new today."));
    const world = makeWorld({ researcher });
    const id = await founder(world);
    world.posts.results["hackernews"] = [post()];
    await world.tasks.start(id, "scout", "Find people on HN", "Find people who want cookie-free analytics.", "news.ycombinator.com");

    await world.runner.runNext();

    expect(openingOf(researcher)).toMatch(/THIS TASK WORKS ON news\.ycombinator\.com ONLY/);
    expect(toolAnswers(researcher)[0]).toMatch(/^Not done: reddit\.com is not news\.ycombinator\.com/);
    // The second search turned up the same post again (a fake search answers the same), and the save came after it.
    expect(world.searches.rows.map(({ site, query, hits }) => ({ site, query, hits }))).toEqual([
      { site: "news.ycombinator.com", query: "cookie banner analytics", hits: 0 },
      { site: "news.ycombinator.com", query: "gdpr dashboards", hits: 1 },
    ]);

    const next = researcher.calls.length;
    await world.tasks.start(id, "scout", "More on HN", "Find more people who want cookie-free analytics.", "news.ycombinator.com");
    await world.runner.runNext();
    const opening = openingOf(researcher, next);
    expect(opening).toContain("WHAT EARLIER SEARCHES FOR THEM CAME TO ON news.ycombinator.com");
    expect(opening).toMatch(/Found people:\n- gdpr dashboards → 1 person \(/);
    expect(opening).toMatch(/Found nobody:\n- cookie banner analytics \(/);
  });

  it("credits a browser search for what its page and its scrolls showed", () => {
    const trail = new SearchTrail();
    const page = (url: string, links: string[]) => JSON.stringify({ url, title: "X", text: "posts", controls: links.map((href, i) => ({ ref: `0:${i}`, role: "link", label: "post", value: null, href })) });
    trail.note("browser_open", { url: "https://x.com/search?q=%22first%20users%22&f=live" }, page("https://x.com/search?q=%22first%20users%22&f=live", ["https://x.com/a/status/1"]));
    trail.note("browser_act", { kind: "scroll" }, page("https://x.com/search?q=%22first%20users%22&f=live", ["https://x.com/b/status/2"]));
    trail.note("browser_open", { url: "https://x.com/search?q=cold%20dms&f=live" }, page("https://x.com/search?q=cold%20dms&f=live", ["https://x.com/c/status/3"]));
    trail.note("browser_open", { url: "https://x.com/b/status/2" }, page("https://x.com/b/status/2", []));
    trail.note("outreach_draft", { url: "https://x.com/b/status/2?s=20" }, JSON.stringify({ id: "d1", status: "offered" }));
    trail.note("outreach_draft", { url: "https://x.com/z/status/9" }, "Read the exact thread and quote its actual words before replying.");
    trail.note("search_posts", { source: "reddit", query: "x growth" }, "Search on reddit failed: offline (Chrome is not connected).");

    expect(trail.runs()).toEqual([
      { site: "x.com", query: "https://x.com/search?q=%22first%20users%22&f=live", hits: 1 },
      { site: "x.com", query: "https://x.com/search?q=cold%20dms&f=live", hits: 0 },
    ]);
    expect(canonical("https://www.twitter.com/B/status/2/?s=20#x")).toBe("x.com/b/status/2");
  });

  it("lists what found people first, then what found nobody, across runs", () => {
    const at = (d: string) => new Date(`2026-10-${d}T10:00:00Z`);
    const block = searchesBlock(
      [
        // Newest first, as the log gives them.
        { agent: "scout", site: "reddit.com", query: "First users", hits: 1, at: at("14") },
        { agent: "scout", site: "web", query: "tweeting into the void", hits: 0, at: at("14") },
        { agent: "scout", site: "reddit.com", query: "first users", hits: 2, at: at("13") },
        { agent: "outreach", site: "x.com", query: "https://x.com/search?q=cold%20dms&f=live", hits: 1, at: at("12") },
      ],
      null,
    );
    expect(block).toBe(
      [
        "WHAT EARLIER SEARCHES FOR THEM CAME TO (run the ones that found people first, with a newer date where they have one; never repeat the ones that found nobody)",
        "Found people:",
        "- reddit.com: First users → 3 people (2026-10-14, 2 runs)",
        "- x.com: https://x.com/search?q=cold%20dms&f=live → 1 person (2026-10-12)",
        "Found nobody:",
        "- web: tweeting into the void (2026-10-14)",
      ].join("\n"),
    );
    expect(searchesBlock([], "x.com")).toBe("");
  });
});

describe("the harness", () => {
  it("refuses the same call a third time in one run", async () => {
    const guard = new RepeatGuard();
    for (let i = 0; i < SAME_CALL_LIMIT; i++) expect(guard.refuse("best_people", { count: 10 })).toBeNull();
    expect(guard.refuse("best_people", { count: 10 })).toMatch(/^Not done: you already called best_people with these same arguments twice in this run/);
    expect(guard.refuse("best_people", { count: 5 })).toBeNull();
    for (let i = 0; i < 5; i++) expect(guard.refuse("browser_act", { kind: "snapshot" })).toBeNull();

    let ran = 0;
    const plan = tool(async () => (ran++, "Plan saved."), { name: "write_plan", description: "plan", schema: z.object({ text: z.string() }) });
    const model = fakeModel()
      .respondWithTools([{ name: "write_plan", args: { text: "Goal: users." } }])
      .respondWithTools([{ name: "write_plan", args: { text: "Goal: users." } }])
      .respondWithTools([{ name: "write_plan", args: { text: "Goal: users." } }])
      .respond(new AIMessage("Done."));
    const refused: string[] = [];
    const agent = buildAgent({ name: "t", model, systemPrompt: "x", tools: [plan], stepBudget: 10, retryDelayMs: 1, onRepeat: (n) => refused.push(n) }, new MemorySaver());
    await agent.invoke({ messages: [new HumanMessage("go")] }, { configurable: { thread_id: "t1" } });
    expect(ran).toBe(2);
    expect(refused).toEqual(["write_plan"]);
  });

  it("keeps a run on its fallback once the first model failed", async () => {
    const primary = fakeModel().alwaysThrow(new Error("Request timed out."));
    const fallback = fakeModel()
      .respondWithTools([{ name: "ping", args: {} }])
      .respond(new AIMessage("Done."));
    const ping = tool(async () => "pong", { name: "ping", description: "ping", schema: z.object({}) });
    const over: string[] = [];
    const agent = buildAgent({ name: "t", model: primary, fallback, systemPrompt: "x", tools: [ping], stepBudget: 10, retryDelayMs: 1, onFallback: (e) => over.push(e) }, new MemorySaver());
    await agent.invoke({ messages: [new HumanMessage("go")] }, { configurable: { thread_id: "t2" } });
    expect(fallback.calls).toHaveLength(2);
    expect(primary.calls.length).toBeLessThanOrEqual(1);
    expect(over).toEqual(["Request timed out."]);
  });
});

describe("mq.searches", () => {
  let db: PGlite;
  const a = customerId("00000000-0000-0000-0000-000000000001");
  const b = customerId("00000000-0000-0000-0000-000000000002");
  const t = taskId("00000000-0000-0000-0000-0000000000aa");

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(
      "create role mq_app; create schema mq; create schema cron; create function cron.schedule(text, text, text) returns bigint language sql as 'select 1::bigint';" +
        "create table mq.customers(id uuid primary key); create table mq.tasks(id uuid primary key, customer_id uuid);" +
        "insert into mq.customers(id) values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002');" +
        "insert into mq.tasks(id, customer_id) values ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001');",
    );
    await db.exec(await readFile(new URL("../../../supabase/migrations/20261014120000_task_site_and_searches.sql", import.meta.url), "utf8"));
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  it("keeps each run's searches, and gives a customer's newest first, by site", async () => {
    const searches = new PgSearches(db as never);
    await searches.record(a, t, "scout", [{ site: "reddit.com", query: "first users", hits: 1 }]);
    await searches.record(a, t, "outreach", [
      { site: "x.com", query: "https://x.com/search?q=cold%20dms&f=live", hits: 0 },
      { site: "x.com", query: "https://x.com/search?q=first%20users&f=live", hits: 2 },
    ]);
    await searches.record(b, t, "scout", [{ site: "x.com", query: "not theirs", hits: 5 }]);
    await searches.record(a, t, "scout", []);

    const onX = await searches.recent(a, { site: "x.com", days: 30, limit: 10 });
    expect(onX.map((r) => [r.agent, r.query, r.hits])).toEqual(
      expect.arrayContaining([
        ["outreach", "https://x.com/search?q=cold%20dms&f=live", 0],
        ["outreach", "https://x.com/search?q=first%20users&f=live", 2],
      ]),
    );
    expect(onX).toHaveLength(2);
    expect(await searches.recent(a, { days: 30, limit: 10 })).toHaveLength(3);
    expect((await db.query<{ site: string | null }>("select site from mq.tasks")).rows).toEqual([{ site: null }]);
  });
});
