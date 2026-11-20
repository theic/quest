/**
 * A sweep by code, measured: the search words from a customer's brief (one call), then each site's own search in their
 * Chrome (Reddit, X, LinkedIn, YouTube, all at once, each at its own pace) and the public APIs (Hacker News, Bluesky),
 * cut into posts by code, and the posts judged in batches on a cheap seat. Prints what it read, what the judge kept,
 * and what it cost and took, to set beside a scout run on the same brief. Nothing is saved or sent.
 *
 * It reads through a laptop agent run with CHROME_DEBUG=1 (`CHROME_DEBUG=1 npm run dev`): its /debug/chrome/read
 * hands each page to the customer's own Chrome, through the broker, as the team's reads go.
 *
 *   node --experimental-strip-types scripts/try-sweep.ts <customer id> [--seats=volume,researcher,vision] [--sites=reddit,x,linkedin,youtube,hackernews,bluesky]
 *        [--queries="a|b|c"] [--from=sweep.json] [--confirm] [--write=3] [--out=sweep.json]
 *
 * --seats judges the same posts on each seat in turn (the first one's picks go on); --from takes the posts of an
 * earlier --out instead of searching again; --confirm reads each pick that was only a search result (a Reddit title)
 * and judges it again on its own words, as the sweep must before anyone is quoted; --write has the writer (their
 * voice) write for the best few.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { customerId, HostGuard, type ChromeJob, type ChromeRead, type FoundPost, type Logger, type ModelUsage } from "@mq/core";
import type { ModelRole } from "../apps/agent/src/agents/models.ts";
import { modelsFor } from "../apps/agent/src/model-source.ts";
import { ChromeReader } from "../apps/agent/src/chrome/chrome-reader.ts";
import { RedditSource, SiteSource } from "../apps/agent/src/chrome/chrome-sources.ts";
import { LINKEDIN, X, YOUTUBE } from "../apps/agent/src/chrome/sites.ts";
import { loadConfig } from "../apps/agent/src/config.ts";
import { voiceFrom, Writer } from "../apps/agent/src/drafts/writer.ts";
import { BatchJudge, type JudgedPost, type Judging } from "../apps/agent/src/finds/batch-judge.ts";
import { searchWords } from "../apps/agent/src/finds/search-words.ts";
import { createPool } from "../apps/agent/src/infra/db.ts";
import { PgCustomerRepository } from "../apps/agent/src/infra/pg-customers.ts";
import { PgFindRepository } from "../apps/agent/src/infra/pg-finds.ts";
import { PgMemoryRepository } from "../apps/agent/src/infra/pg-memory.ts";
import { PgTranscript } from "../apps/agent/src/infra/pg-transcript.ts";
import { BlueskySource } from "../apps/agent/src/sources/bluesky.ts";
import { HackerNewsSource } from "../apps/agent/src/sources/hackernews.ts";
import type { PostSource } from "../apps/agent/src/sources/http.ts";
import { readEnvFile } from "./env-file.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const has = (name: string): boolean => args.includes(`--${name}`);
const id = args.find((a) => !a.startsWith("--"));
if (!id) throw new Error("usage: try-sweep.ts <customer id> [--seats=volume,researcher] [--sites=…] [--queries=a|b] [--from=file.json] [--confirm] [--write=3] [--out=file.json]");
const AGENT = process.env.MQ_AGENT ?? "http://127.0.0.1:8080";
const seats = (flag("seats") ?? "volume").split(",") as ModelRole[];
const sites = new Set((flag("sites") ?? "reddit,x,linkedin,youtube,hackernews,bluesky").split(","));

const config = loadConfig({ ...process.env, ...Object.fromEntries(readEnvFile()) });
const models = await modelsFor(config);
const pool = createPool(config.databaseUrl, 2);
const quiet: Logger = { info: () => undefined, warn: () => undefined, error: (e, d) => console.log(`  !! ${e} ${JSON.stringify(d ?? {})}`) };
const me = customerId(id);
const customer = await new PgCustomerRepository(pool).get(me);
if (!customer.brief) throw new Error("this customer has no brief yet");
const brief = customer.brief;


const spent: { what: string; usage: ModelUsage | null }[] = [];
const t0 = Date.now();
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const usd = (u: ModelUsage | null) => `$${(u?.cost ?? 0).toFixed(4)}`;

let pages = 0;
const read = async (job: ChromeJob): Promise<ChromeRead> => {
  pages++;
  const res = await fetch(`${AGENT}/debug/chrome/read`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ customerId: id, job }) });
  const body = (await res.json()) as ChromeRead & { error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
};

type Ran = { source: string; query: string; site?: string; posts: FoundPost[]; ms: number; done: number; error: string | null };
let queries: string[] = [];
let communities: string[] = [];
let ran: Ran[] = [];
let posts: FoundPost[];

const from = flag("from");
if (from) {
  // An earlier sweep's posts, judged again: the same pages, no Chrome.
  const saved = JSON.parse(readFileSync(from, "utf8")) as { queries: string[]; communities: string[]; posts: (FoundPost & { postedAt: string | null })[] };
  queries = saved.queries;
  communities = saved.communities;
  posts = saved.posts.map((p) => ({ ...p, postedAt: p.postedAt ? new Date(p.postedAt) : null }));
  console.log(`${posts.length} posts from ${from}, searched for ${queries.map((q) => `"${q}"`).join(", ")}\n`);
} else {
  // 1. The search words, once.
  queries = flag("queries")?.split("|").map((q) => q.trim()).filter(Boolean) ?? [];
  if (!queries.length) {
    const words = await searchWords(models, { brief }, seats[0]);
    spent.push({ what: "search words", usage: words.usage });
    queries = [...words.queries];
    communities = [...words.communities];
  }
  console.log(`Searches (${secs(Date.now() - t0)}): ${queries.map((q) => `"${q}"`).join(", ")}${communities.length ? `\nCommunities: ${communities.map((c) => `r/${c}`).join(", ")}` : ""}\n`);

  // 2. Every search at once: the broker keeps each site at its own pace.
  const sources: Record<string, PostSource> = {
    reddit: new RedditSource(read),
    x: new SiteSource(X, read),
    linkedin: new SiteSource(LINKEDIN, read),
    youtube: new SiteSource(YOUTUBE, read),
    hackernews: new HackerNewsSource(fetch),
    bluesky: new BlueskySource(fetch),
  };
  const searches: { source: string; query: string; site?: string }[] = [];
  for (const name of Object.keys(sources)) {
    if (!sites.has(name)) continue;
    for (const query of queries) searches.push({ source: name, query });
    if (name === "reddit") for (const c of communities) for (const query of queries.slice(0, 2)) searches.push({ source: name, query, site: c });
  }
  ran = await Promise.all(
    searches.map(async (s): Promise<Ran> => {
      const started = Date.now();
      try {
        const found = await sources[s.source]!.search({ source: s.source, query: s.query, ...(s.site ? { site: s.site } : {}), within: "month" }, 20);
        return { ...s, posts: found, ms: Date.now() - started, done: Date.now() - t0, error: null };
      } catch (e) {
        return { ...s, posts: [], ms: Date.now() - started, done: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  const bySource = new Map<string, { searches: number; posts: number; failed: number; last: number }>();
  for (const r of ran) {
    const s = bySource.get(r.source) ?? { searches: 0, posts: 0, failed: 0, last: 0 };
    s.searches++;
    s.posts += r.posts.length;
    if (r.error) s.failed++;
    s.last = Math.max(s.last, r.done);
    bySource.set(r.source, s);
  }
  console.log("What each site gave:");
  for (const [name, s] of bySource) console.log(`  ${name.padEnd(11)} ${String(s.searches).padStart(2)} searches  ${String(s.posts).padStart(3)} posts  ${s.failed ? `${s.failed} failed  ` : ""}done by ${secs(s.last)}`);
  for (const r of ran.filter((r) => r.error)) console.log(`  ! ${r.source} "${r.query}"${r.site ? ` in r/${r.site}` : ""}: ${r.error!.slice(0, 160)}`);
  const unique = new Map<string, FoundPost>();
  for (const r of ran) for (const p of r.posts) if (!unique.has(p.url)) unique.set(p.url, p);
  posts = [...unique.values()];
  console.log(`\n${pages} pages in their Chrome and ${ran.filter((r) => r.source === "hackernews" || r.source === "bluesky").length} API searches in ${secs(Date.now() - t0)}: ${posts.length} posts.`);
}
const known = await new PgFindRepository(pool).known(me, posts.map((p) => p.url));
const fresh = posts.filter((p) => !known.has(p.url));
console.log(`${posts.length - fresh.length} already found for them, ${fresh.length} to judge.\n`);

// 3. Judged in batches, on each seat asked for.
const line = (j: JudgedPost) => `${j.fit === "strong" ? "★" : "·"} [${j.post.source}] ${j.post.postedAt?.toISOString().slice(0, 10) ?? "?"} ${j.post.author ?? ""}${j.post.preview ? " (preview)" : ""}\n  ${j.post.url}\n  "${j.quote.slice(0, 200)}"\n  ${j.why}`;
const judgings: { seat: ModelRole; judging: Judging }[] = [];
for (const seat of seats) {
  const judging = await new BatchJudge({ models, log: quiet, seat, ...(flag("batch") ? { batch: Number(flag("batch")) } : {}) }).judge({ customerId: me, brief, posts: fresh });
  judgings.push({ seat, judging });
  spent.push({ what: `judge on ${seat} (${judging.calls} calls)`, usage: judging.usage });
  const strong = judging.judged.filter((j) => j.fit === "strong").length;
  console.log(`On ${seat}: ${judging.looked} posts in ${secs(judging.ms)}, ${usd(judging.usage)}: ${strong} strong, ${judging.judged.length - strong} maybe, ${judging.unquoted} dropped for a quote not in the post${judging.failed ? `, ${judging.failed} batches unanswered` : ""}.`);
}
const [first] = judgings;
if (judgings.length > 1) {
  const picks = (j: Judging, fit?: string) => new Set(j.judged.filter((p) => !fit || p.fit === fit).map((p) => p.post.url));
  for (const other of judgings.slice(1)) {
    const a = picks(first!.judging);
    const b = picks(other.judging);
    const as = picks(first!.judging, "strong");
    const bs = picks(other.judging, "strong");
    console.log(`  ${first!.seat} and ${other.seat}: ${[...a].filter((u) => b.has(u)).length} picks in common of ${a.size} and ${b.size}; strong in common ${[...as].filter((u) => bs.has(u)).length} of ${as.size} and ${bs.size}`);
    for (const j of other.judging.judged.filter((j) => j.fit === "strong" && !a.has(j.post.url))) console.log(`    only ${other.seat} picked: ${j.post.url}  "${j.quote.slice(0, 120)}"`);
    for (const j of first!.judging.judged.filter((j) => j.fit === "strong" && !b.has(j.post.url))) console.log(`    only ${first!.seat} picked: ${j.post.url}  "${j.quote.slice(0, 120)}"`);
  }
}
let judged = [...first!.judging.judged];
console.log("");
for (const j of judged) console.log(line(j));

// 4. A pick that was only a search result is read, then judged again on its own words.
if (has("confirm")) {
  const guard = new HostGuard({ resolve: async (host) => (await lookup(host, { all: true })).map((a) => a.address), unresolved: "refuse" });
  const reader = new ChromeReader(read, guard);
  const previews = judged.filter((j) => j.post.preview && !/youtube\.com/.test(j.post.url));
  const started = Date.now();
  const before = pages;
  const readPosts = await Promise.all(
    previews.map(async (j): Promise<FoundPost | null> => {
      try {
        const page = await reader.readPage(j.post.url);
        return { ...j.post, author: page.post?.author ?? j.post.author, postedAt: page.post?.postedAt ?? j.post.postedAt, text: page.text.slice(0, 3_000), preview: false };
      } catch (e) {
        console.log(`  ! could not read ${j.post.url}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    }),
  );
  const again = await new BatchJudge({ models, log: quiet, seat: first!.seat }).judge({ customerId: me, brief, posts: readPosts.filter((p): p is FoundPost => p !== null) });
  spent.push({ what: `confirm on ${first!.seat}`, usage: again.usage });
  const held = new Map(again.judged.map((j) => [j.post.url, j]));
  console.log(`\nConfirmed ${previews.length} picks that were only search results: ${pages - before} pages, ${secs(Date.now() - started)}, ${usd(again.usage)}.`);
  for (const j of previews) {
    const now = held.get(j.post.url);
    console.log(`  ${j.fit} → ${now ? now.fit : "no"}  ${j.post.url}${now ? `\n    "${now.quote.slice(0, 160)}"` : ""}`);
  }
  judged = [...judged.filter((j) => !j.post.preview || /youtube\.com/.test(j.post.url)), ...again.judged];
}

// 5. The writer for the best few, in their voice.
const write = Number(flag("write") ?? 0);
const written: { url: string; text: string }[] = [];
if (write > 0) {
  const voice = voiceFrom({ customers: new PgCustomerRepository(pool), memory: new PgMemoryRepository(pool), transcript: new PgTranscript(pool), clock: { now: () => new Date() } });
  const writer = new Writer({ models, voice, log: quiet });
  const best = judged.filter((j) => !j.post.preview && j.fit === "strong").slice(0, write);
  const started = Date.now();
  for (const j of best) {
    const w = await writer.write(me, {
      kind: "reply",
      platform: j.post.source.startsWith("reddit") ? "reddit" : new URL(j.post.url).hostname.replace(/^www\./, ""),
      place: j.post.source,
      author: j.post.author,
      quote: j.quote,
      title: null,
      draft: `Answer what they asked (${j.why}), helpfully, in two to four sentences, and say plainly who the customer is and what they make where it fits.`,
    });
    written.push({ url: j.post.url, text: w.text });
    console.log(`\n✍ ${j.post.url}\n${w.text}`);
  }
  console.log(`\nWrote ${best.length} in ${secs(Date.now() - started)} (the writer's cost is in mq.model_calls as agent "writer").`);
}

// 6. What it cost.
const total = spent.reduce((n, s) => n + (s.usage?.cost ?? 0), 0);
console.log(`\nCost: ${spent.map((s) => `${s.what} ${usd(s.usage)} (${s.usage?.input ?? 0} in, ${s.usage?.cached ?? 0} cached, ${s.usage?.output ?? 0} out)`).join("; ")}; $${total.toFixed(4)} in all, without the writer.`);
console.log(`Time: ${secs(Date.now() - t0)} in all, ${pages} pages in their Chrome.`);

const out = flag("out");
if (out) writeFileSync(out, JSON.stringify({ queries, communities, searches: ran.map((r) => ({ source: r.source, query: r.query, site: r.site ?? null, posts: r.posts.length, ms: r.ms, error: r.error })), posts, judged, written, cost: total, ms: Date.now() - t0 }, null, 1));
await pool.end();
