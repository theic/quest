/**
 * The extension against a scratch agent, without Telegram or models: a test-lane
 * customer, the extension's API on a local port, one connect link, then a few
 * reads in the connected Chrome (a page, a site, DuckDuckGo, Reddit). Prints
 * what came back; deletes the test customer at the end.
 *
 *   node --experimental-strip-types scripts/try-chrome.ts [port]
 *
 * Open the printed link in a Chrome that has the extension loaded.
 */
import { lookup } from "node:dns/promises";
import { serve } from "@hono/node-server";
import { HostGuard, type ChromeJob } from "@mq/core";
import { ChromeBroker } from "../apps/agent/src/chrome/broker.ts";
import { ChromeLinkService, showCode } from "../apps/agent/src/chrome/link-service.ts";
import { ChromeReach } from "../apps/agent/src/chrome/reach.ts";
import { searchJob as duckJob, searchUrl as duckUrl } from "../apps/agent/src/chrome/duckduckgo.ts";
import { searchJob as redditJob, searchUrl as redditUrl } from "../apps/agent/src/chrome/reddit.ts";
import { chromeDebugRoutes, chromeRoutes } from "../apps/agent/src/http/chrome-routes.ts";
import { createPool } from "../apps/agent/src/infra/db.ts";
import { PgChromeLinks } from "../apps/agent/src/infra/pg-chrome-links.ts";
import { PgCustomerRepository } from "../apps/agent/src/infra/pg-customers.ts";
import { silentLogger, systemClock } from "../apps/agent/src/infra/system.ts";
import { publicSourceList } from "../apps/agent/src/sources/registry.ts";
import { Hono } from "hono";
import { readEnvFile } from "./env-file.ts";

const port = Number(process.argv[2] ?? 8790);
const databaseUrl = readEnvFile().get("DATABASE_URL");
if (!databaseUrl) throw new Error("DATABASE_URL must be in .env.local");

const pool = createPool(databaseUrl, 3);
const customers = new PgCustomerRepository(pool, "test");
const customer = await customers.create({ channel: { kind: "telegram", address: `try-chrome-${Date.now()}` }, userRef: "0", displayName: "Try", language: "en" });
const broker = new ChromeBroker();
let code = "";
const links = new ChromeLinkService({
  links: new PgChromeLinks(pool),
  broker,
  messenger: {
    say: async (_id, text) => console.log(`[to the customer] ${text}`),
    sendLinks: async () => undefined,
  },
  events: { push: async () => undefined },
  wakeManager: () => undefined,
  publicUrl: `http://localhost:${port}`,
  clock: systemClock,
  log: silentLogger,
});

const app = new Hono();
app.route("/", chromeRoutes({ links, broker, log: silentLogger }));
app.route("/", chromeDebugRoutes(broker));
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });

async function finish(): Promise<void> {
  await pool.query("delete from mq.customers where id = $1", [customer.id]);
  server.close();
  await pool.end();
}
process.on("SIGINT", () => void finish().then(() => process.exit(130)));

const offer = await links.offer(customer.id);
code = offer.sent ? showCode(offer.code) : "";
console.log(`Open in Chrome with the extension: http://localhost:${port}/connect#${code}`);

for (let waited = 0; !broker.online(customer.id); waited++) {
  if (waited > 600) {
    console.log("No Chrome connected in 10 minutes.");
    await finish();
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1_000));
}
console.log("Chrome connected.");

const guard = new HostGuard({ resolve: async (host) => (await lookup(host, { all: true })).map((a) => a.address), unresolved: "refuse" });
const { reader, posts } = new ChromeReach(broker, guard, publicSourceList()).forCustomer(customer.id);
const line = (s: string | null | undefined, n = 90) => (s ?? "").replace(/\s+/g, " ").slice(0, n);

async function step(name: string, run: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const out = await run();
    console.log(`\n## ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)\n${out}`);
  } catch (e) {
    console.log(`\n## ${name}: FAILED ${e instanceof Error ? `${e.name} ${(e as { reason?: string }).reason ?? ""}: ${e.message}` : String(e)}`);
  }
}

/** The raw read, for measuring a page's shape: row counts, and the first row of each spec. */
async function raw(job: ChromeJob): Promise<string> {
  const r = await broker.read(customer.id, job);
  const rows = Object.entries(r.rows).map(([k, v]) => `${k}: ${v.length}${v[0] ? ` e.g. ${JSON.stringify(v[0]).slice(0, 300)}` : ""}`);
  return [`${r.status} ${r.url} visible=${r.visible} title="${line(r.title)}"`, ...rows, `text: ${line(r.text, 300)}`].join("\n");
}

// Measuring: `try-chrome.ts <port> https://...` reads just those pages, drawn, and says what is on them.
const measure = process.argv.slice(3).filter((a) => /^https?:\/\//.test(a));
if (measure.length) {
  const shape = {
    testids: { items: "[data-testid]", limit: 400, fields: { id: "attr:data-testid", tag: "tag" } },
    custom: { items: "shreddit-post, shreddit-comment, faceplate-partial, search-telemetry-tracker, faceplate-tracker", limit: 400, fields: { tag: "tag", noun: "attr:noun", slot: "attr:slot" } },
    posts: { items: "shreddit-post", limit: 3, fields: { title: "attr:post-title", author: "attr:author", at: "attr:created-timestamp", href: "attr:permalink", body: "text:[slot=text-body]" } },
    units: { items: "[data-testid='search-post-unit']", limit: 3, fields: { html: "text", href: "href:a[data-testid='post-title']|href:a[href*='/comments/']", at: "attr:datetime@time|attr:ts@faceplate-timeago", author: "text:a[href^='/user/']" } },
    comments: { items: "shreddit-comment", limit: 3, fields: { author: "attr:author", at: "attr:datetime@time|attr:ts@faceplate-timeago", body: "text:[slot=comment]" } },
  };
  for (const url of measure) {
    await step(`measure ${url}`, async () => {
      // MEASURE_DRAWN=0 reads without bringing Quest's window on screen: does the page render hidden?
      const drawn = process.env["MEASURE_DRAWN"] !== "0";
      const r = await broker.read(customer.id, { url, take: { text: true, specs: shape }, drawn, settleMs: 6_000, waitFor: "shreddit-post, [data-testid='search-post-unit']" });
      const tally = (rows: readonly Record<string, unknown>[], key: string) => {
        const n = new Map<string, number>();
        for (const row of rows) n.set(String(row[key]), (n.get(String(row[key])) ?? 0) + 1);
        return [...n].map(([k, v]) => `${k}×${v}`).join(" ");
      };
      return [
        `${r.status} ${r.url} visible=${r.visible} title="${line(r.title)}"`,
        `testids: ${tally(r.rows.testids ?? [], "id")}`,
        `custom: ${tally(r.rows.custom ?? [], "tag")}`,
        ...["posts", "units", "comments"].map((k) => `${k}: ${(r.rows[k] ?? []).map((x) => JSON.stringify(x).slice(0, 400)).join("\n  ")}`),
        `text: ${line(r.text, 600)}`,
      ].join("\n");
    });
  }
  await finish();
  process.exit(0);
}

const query = process.argv[3] ?? "typeform alternative";
await step("page example.com", async () => {
  const p = await reader.readPage("https://example.com/");
  return `${p.title}: ${line(p.text)}`;
});
await step("site tally.so", async () => {
  const s = await reader.readSite("https://tally.so/");
  return s.pages.map((p) => `${p.url} "${line(p.title, 50)}" ${p.text.length} chars`).join("\n");
});
await step("DuckDuckGo raw", () => raw(duckJob(duckUrl(query, "year"))));
await step("web search", async () => {
  const found = await posts.search({ source: "web", query, within: "year", limit: 5 });
  return found.map((p) => `${p.url} | ${line(p.title, 60)}`).join("\n") || "(none)";
});
await step("Reddit search raw", () => raw(redditJob(redditUrl(query, null, "year"))));
let thread: string | null = null;
await step("reddit search r/SaaS", async () => {
  const found = await posts.search({ source: "reddit", query: "form builder", site: "SaaS", within: "year", limit: 5 });
  thread = found[0]?.url ?? null;
  return found.map((p) => `${p.postedAt?.toISOString().slice(0, 10) ?? "?"} u/${p.author} ${p.url} | ${line(p.title, 60)} (${p.replies} replies)`).join("\n") || "(none)";
});
if (thread) {
  await step("reddit thread", async () => {
    const p = await reader.readPage(thread!);
    return `${JSON.stringify(p.post)}\n${line(p.text, 600)}`;
  });
}

await finish();
console.log("\nDone; the test customer is deleted.");
process.exit(0);
