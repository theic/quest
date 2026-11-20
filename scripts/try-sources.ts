/**
 * One live search per public source, to see each still answers and still parses.
 *
 *   node --experimental-strip-types scripts/try-sources.ts [query]
 */
import { publicSources } from "../apps/agent/src/sources/registry.ts";

const query = process.argv[2] ?? "google analytics alternative";
const posts = publicSources();
const runs: { source: string; query: string; site?: string }[] = [
  { source: "hackernews", query },
  { source: "stackexchange", site: "webmasters", query: "GA4 consent" },
  { source: "bluesky", query },
  { source: "lemmy", query },
  { source: "github", query: `"${query}"` },
  { source: "mastodon", query: "gdpr" },
];
for (const r of runs) {
  const started = Date.now();
  try {
    const found = await posts.search({ ...r, limit: 3 });
    console.log(`${r.source}: ${found.length} in ${Date.now() - started} ms`);
    for (const p of found) console.log(`  ${p.postedAt?.toISOString().slice(0, 10) ?? "?"} ${p.author ?? "?"} ${p.url} | ${(p.title ?? p.text).slice(0, 70).replace(/\s+/g, " ")}`);
  } catch (e) {
    console.log(`${r.source}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
