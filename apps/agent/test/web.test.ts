import { customerId, HostGuard, ReadError, SearchError, type FoundPost, type Logger, type PageReader, type PageText, type PostQuery, type PostSearch, type WebReach } from "@mq/core";
import { describe, expect, it } from "vitest";
import { managerTools } from "../src/manager/tools.ts";
import { researcherSpec } from "../src/tasks/researcher.ts";
import { SubagentCatalog } from "../src/tasks/subagents.ts";
import { RoutedReach } from "../src/web/routed-reach.ts";
import { DailyCredits, TavilyClient } from "../src/web/tavily-client.ts";
import { TavilyReach } from "../src/web/tavily-reach.ts";
import { makeWorld, telegramSender } from "./world.ts";

const C = customerId("11111111-1111-4111-8111-111111111111");
const guard = new HostGuard({ resolve: async (host) => (host.endsWith("intranet.test") ? ["10.0.0.5"] : ["93.184.216.34"]), unresolved: "refuse" });

type Answer = { status?: number; body?: unknown };

/** Tavily with a scripted answer per call, remembering what it was asked and what was logged. */
function tavily(answer: (path: string, body: Record<string, unknown>) => Answer, creditsPerDay = 60) {
  const calls: { path: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const lines: { event: string; data: Record<string, unknown> | undefined }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.slice(1);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ path, body, auth: new Headers(init?.headers).get("authorization") });
    const a = answer(path, body);
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200 });
  }) as typeof fetch;
  const log: Logger = {
    info: (event, data) => void lines.push({ event, data }),
    warn: (event, data) => void lines.push({ event, data }),
    error: (event, data) => void lines.push({ event, data }),
  };
  const reach = new TavilyReach({ client: new TavilyClient("tvly-secret", fetchImpl), guard, credits: new DailyCredits(creditsPerDay), log });
  return { calls, lines, reach, ...reach.forCustomer(C) };
}

const extracted = (...pages: [string, string][]): Answer => ({ body: { results: pages.map(([url, raw_content]) => ({ url, raw_content })), failed_results: [] } });

describe("reading public pages through Tavily", () => {
  it("reads a page as markdown, sends the key as a bearer, and logs the host and never the path", async () => {
    const t = tavily(() => extracted(["https://example.com/pricing/secret-plan", "# Example pricing\n\nFrom $9 a month for freelancers."]));
    const page = await t.reader.readPage("https://example.com/pricing/secret-plan");

    expect(page).toEqual({ url: "https://example.com/pricing/secret-plan", title: "Example pricing", description: null, text: "# Example pricing\n\nFrom $9 a month for freelancers." });
    expect(t.calls).toEqual([{ path: "extract", body: { urls: ["https://example.com/pricing/secret-plan"], format: "markdown", extract_depth: "basic" }, auth: "Bearer tvly-secret" }]);
    expect(JSON.stringify(t.lines)).toContain("example.com");
    expect(JSON.stringify(t.lines)).not.toContain("secret-plan");
  });

  it("never sends an address on a private network to Tavily", async () => {
    const t = tavily(() => extracted());
    await expect(t.reader.readPage("http://wiki.intranet.test/notes")).rejects.toMatchObject({ reason: "blocked" });
    await expect(t.reader.readPage("http://localhost:8080/")).rejects.toMatchObject({ reason: "blocked" });
    expect(t.calls).toHaveLength(0);
  });

  it.each<[string, Answer, string]>([
    ["a page that is gone", { body: { results: [], failed_results: [{ url: "https://example.com/x", error: "404 Not Found" }] } }, "not_found"],
    ["a site that refuses the reader", { body: { results: [], failed_results: [{ url: "https://example.com/x", error: "403 Forbidden" }] } }, "blocked"],
    ["a page that takes too long", { body: { results: [], failed_results: [{ url: "https://example.com/x", error: "Request timed out" }] } }, "timeout"],
    ["a failure it does not explain", { body: { results: [], failed_results: [{ url: "https://example.com/x", error: "Extraction failed" }] } }, "unavailable"],
    ["a page with no words", extracted(["https://example.com/x", "   "]), "unavailable"],
    ["an allowance that is spent", { status: 432, body: {} }, "limit"],
    ["a rate limit", { status: 429, body: {} }, "limit"],
    // Our own key being refused is not a site refusing the page: "blocked" would tell the agent it is final.
    ["a key that is not accepted", { status: 401, body: {} }, "unavailable"],
    ["an outage", { status: 502, body: {} }, "unavailable"],
  ])("says %s as %s", async (_what, answer, reason) => {
    const t = tavily(() => answer);
    const failed = await t.reader.readPage("https://example.com/x").catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ReadError);
    expect(failed).toMatchObject({ reason });
    expect((failed as Error).message).not.toMatch(/chrome/i);
    // A key that is refused is the one failure that is an error in the logs: it stops everyone's reading.
    expect(t.lines.some((l) => l.data?.["key"] === "not accepted")).toBe(_what === "a key that is not accepted");
  });

  it("reads a site: its first page, then the same-site pages it links to, in one more call", async () => {
    const t = tavily((_path, body) =>
      (body["urls"] as string[]).length === 1
        ? extracted(["https://acme.test/", "# Acme\n\nInvoices for freelancers. [Pricing](/pricing) · [Log in](/login) · [Blog post](https://other.test/x) · [How it works](https://acme.test/how-it-works)"])
        : extracted(["https://acme.test/pricing", "# Pricing\n\n$9 a month."], ["https://acme.test/how-it-works", "# How it works\n\nSend, remind, get paid."]),
    );
    const site = await t.reader.readSite("https://acme.test/", { pages: 4 });

    expect(site.pages.map((p) => p.title)).toEqual(["Acme", "Pricing", "How it works"]);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]?.body["urls"]).toEqual(["https://acme.test/pricing", "https://acme.test/how-it-works"]);
  });

  it("still returns the first page of a site when the others will not open", async () => {
    const t = tavily((_path, body) => ((body["urls"] as string[])[0] === "https://acme.test/" ? extracted(["https://acme.test/", "# Acme\n\n[Pricing](/pricing)"]) : { status: 502 }));
    expect((await t.reader.readSite("https://acme.test/")).pages).toHaveLength(1);
  });

  it("stops at the customer's allowance for the day without calling Tavily again", async () => {
    const t = tavily(() => extracted(["https://example.com/x", "# Hello"]), 2);
    await t.reader.readPage("https://example.com/x");
    await t.reader.readPage("https://example.com/x");
    await expect(t.reader.readPage("https://example.com/x")).rejects.toMatchObject({ reason: "limit" });
    await expect(t.web.search({ source: "web", query: "q" }, 5)).rejects.toMatchObject({ reason: "rate_limited" });
    expect(t.calls).toHaveLength(2);
  });

  it("gives the allowance back the next day", () => {
    let now = Date.UTC(2026, 9, 5, 23, 0);
    const credits = new DailyCredits(1, () => now);
    expect(credits.take(C, 1)).toBe(true);
    expect(credits.take(C, 1)).toBe(false);
    now = Date.UTC(2026, 9, 6, 0, 1);
    expect(credits.take(C, 1)).toBe(true);
  });
});

describe("searching the web through Tavily", () => {
  it("returns results as pages still to be read, with the date when Tavily has one", async () => {
    const t = tavily(() => ({
      body: {
        results: [
          { title: "Typeform alternative? | Indie Hackers", url: "https://www.indiehackers.com/post/form-tool", content: "I need a <b>form</b> tool that...", published_date: "2026-10-01T08:00:00Z" },
          { title: "", url: "https://forum.test/t/2", content: "Another", published_date: null },
        ],
      },
    }));
    const found = await t.web.search({ source: "web", query: "typeform alternative", within: "week" }, 5);

    expect(t.calls[0]?.body).toMatchObject({ query: "typeform alternative", max_results: 5, time_range: "week", search_depth: "basic" });
    expect(found).toEqual<FoundPost[]>([
      { source: "web", url: "https://www.indiehackers.com/post/form-tool", author: null, title: "Typeform alternative? | Indie Hackers", text: "I need a form tool that...", postedAt: new Date("2026-10-01T08:00:00Z"), replies: null, preview: true },
      { source: "web", url: "https://forum.test/t/2", author: null, title: null, text: "Another", postedAt: null, replies: null, preview: true },
    ]);
  });

  it("takes site:example.com out of the words and keeps the search on that site", async () => {
    const t = tavily(() => ({ body: { results: [] } }));
    await t.web.search({ source: "web", query: 'site:news.ycombinator.com "looking for" form builder' }, 5);
    expect(t.calls[0]?.body).toMatchObject({ query: '"looking for" form builder', include_domains: ["news.ycombinator.com"] });
    expect(t.calls[0]?.body).not.toHaveProperty("time_range");
  });

  it.each<[Answer, string]>([
    [{ status: 429 }, "rate_limited"],
    [{ status: 422 }, "bad_query"],
    [{ status: 500 }, "unavailable"],
  ])("explains a failed search (%j) as %s", async (answer, reason) => {
    const t = tavily(() => answer);
    await expect(t.web.search({ source: "web", query: "q" }, 5)).rejects.toMatchObject({ name: "SearchError", reason });
  });
});

/** A Chrome that answers each call with the next scripted thing, and remembers what it was asked. */
function chromeThat(...answers: (PageText | Error)[]) {
  const asked: { url: string; opts?: unknown }[] = [];
  const next = (): PageText => {
    const a = answers.shift();
    if (!a) throw new Error("no scripted answer");
    if (a instanceof Error) throw a;
    return a;
  };
  const reader: PageReader = {
    readPage: async (url, opts) => (asked.push({ url, opts }), next()),
    readSite: async (url) => (asked.push({ url }), { pages: [next()] }),
  };
  const searched: PostQuery[] = [];
  const failures: SearchError[] = [];
  const posts: PostSearch = {
    sources: () => [{ name: "web", covers: "x", queryHint: "y" }],
    search: async (q) => {
      searched.push(q);
      const failed = failures.shift();
      if (failed) throw failed;
      return [{ source: q.source, url: "https://chrome.test/1", author: null, title: "from chrome", text: "", postedAt: null, replies: null }];
    },
  };
  const reach: WebReach = { forCustomer: () => ({ reader, posts }) };
  return { asked, searched, failures, reach };
}

const page = (url: string, title: string): PageText => ({ url, title, description: null, text: `${title} text` });

function routed(chrome: ReturnType<typeof chromeThat>, answer: (path: string, body: Record<string, unknown>) => Answer = () => extracted(["https://example.com/x", "# From Tavily"])) {
  const t = tavily(answer);
  return { tavilyCalls: t.calls, ...new RoutedReach({ chrome: chrome.reach, tavily: t.reach }).forCustomer(C) };
}

describe("routing between the customer's Chrome and Tavily", () => {
  it("reads in the customer's Chrome first, and leaves Tavily alone while it answers", async () => {
    const chrome = chromeThat(page("https://example.com/x", "From Chrome"));
    const r = routed(chrome);
    expect((await r.reader.readPage("https://example.com/x")).title).toBe("From Chrome");
    expect(r.tavilyCalls).toHaveLength(0);
  });

  it.each(["offline", "limit", "hidden"] as const)("reads through Tavily when Chrome could not try the page (%s)", async (reason) => {
    const chrome = chromeThat(new ReadError(reason, "x"));
    const r = routed(chrome);
    expect((await r.reader.readPage("https://example.com/x")).title).toBe("From Tavily");
    expect(r.tavilyCalls).toHaveLength(1);
  });

  it("takes a site's refusal as final: a page Chrome was refused is not tried another way", async () => {
    const chrome = chromeThat(new ReadError("blocked", "example.com showed a bot check"));
    const r = routed(chrome);
    await expect(r.reader.readPage("https://example.com/x")).rejects.toMatchObject({ reason: "blocked" });
    expect(r.tavilyCalls).toHaveLength(0);
  });

  it("does not hide a page that is simply gone", async () => {
    const r = routed(chromeThat(new ReadError("not_found", "404")));
    await expect(r.reader.readPage("https://example.com/x")).rejects.toMatchObject({ reason: "not_found" });
    expect(r.tavilyCalls).toHaveLength(0);
  });

  it("keeps Reddit, reading as a visitor and checking the customer's own posts in their Chrome, even when it is closed", async () => {
    const chrome = chromeThat(new ReadError("offline", "x"), new ReadError("offline", "x"), new ReadError("offline", "x"));
    const r = routed(chrome);
    await expect(r.reader.readPage("https://www.reddit.com/r/SaaS/comments/abc/x/")).rejects.toMatchObject({ reason: "offline" });
    await expect(r.reader.readPage("https://example.com/x", { asVisitor: true })).rejects.toMatchObject({ reason: "offline" });
    await expect(r.reader.readPage("https://example.com/x", { asVisitor: true, check: true })).rejects.toMatchObject({ reason: "offline" });
    expect(r.tavilyCalls).toHaveLength(0);
    expect(chrome.asked[1]?.opts).toEqual({ asVisitor: true });
  });

  it("reads a site the same way, and keeps a Reddit community's pages in Chrome", async () => {
    const chrome = chromeThat(new ReadError("offline", "x"), new ReadError("offline", "x"));
    const r = routed(chrome, () => extracted(["https://acme.test/", "# Acme"]));
    expect((await r.reader.readSite("https://acme.test/")).pages[0]?.title).toBe("Acme");
    await expect(r.reader.readSite("https://www.reddit.com/r/SaaS/")).rejects.toMatchObject({ reason: "offline" });
  });

  it("searches the web through Tavily when the search in Chrome could not run, and never for Reddit", async () => {
    const chrome = chromeThat();
    chrome.failures.push(new SearchError("offline", "x"), new SearchError("refused", "DuckDuckGo showed a check"), new SearchError("offline", "x"));
    const r = routed(chrome, () => ({ body: { results: [{ title: "T", url: "https://forum.test/1", content: "c" }] } }));

    expect((await r.posts.search({ source: "web", query: "q" }))[0]?.url).toBe("https://forum.test/1");
    expect((await r.posts.search({ source: "web", query: "q" }))[0]?.url).toBe("https://forum.test/1");
    await expect(r.posts.search({ source: "reddit", query: "q" })).rejects.toMatchObject({ reason: "offline" });
    expect(r.tavilyCalls).toHaveLength(2);
  });

  it("does not search another way for a query that is wrong, and shows the agents one web search either way", async () => {
    const chrome = chromeThat();
    chrome.failures.push(new SearchError("bad_query", "the query is empty"));
    const r = routed(chrome);
    await expect(r.posts.search({ source: "web", query: "" })).rejects.toMatchObject({ reason: "bad_query" });
    expect(r.tavilyCalls).toHaveLength(0);
    expect(r.posts.sources().map((s) => s.name)).toEqual(["web"]);
  });
});

describe("the manager and work that no longer needs the customer's Chrome", () => {
  it("starts a researcher with the Chrome closed when public pages can be read without it, but still holds the scout", async () => {
    const world = makeWorld();
    const c = await world.customers.create({ channel: telegramSender().channel, userRef: "42", displayName: "Dana", language: "en" });
    await world.customers.update(c.id, { sweptAt: new Date(world.clock.t) });
    world.chrome.state = { linked: false, online: false, device: null, lastSeenAt: null };
    const catalog = new SubagentCatalog([researcherSpec({ needsChrome: false }), ...["scout", "explorer"].map((name) => ({ ...researcherSpec(), name }))]);
    const tools = Object.fromEntries(managerTools({ ...world, catalog, customerId: c.id, userTurn: true, now: world.clock.now }).map((t) => [t.name, t]));

    const started = String(await tools["start_task"]!.invoke({ agent: "researcher", title: "Read the site", instructions: "Read https://acme.test and report." }));
    expect(started).toMatch(/^Started task/);
    expect(await world.tasks.list(c.id)).toHaveLength(1);

    const held = String(await tools["start_task"]!.invoke({ agent: "scout", title: "Find people", instructions: "Search Reddit." }));
    expect(held).toMatch(/^Not started: your team reads and searches the web in the customer's own Chrome/);
  });
});
