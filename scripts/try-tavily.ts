/**
 * The spike for reading the web through Tavily, before anything depends on it: how often it answers where
 * Quest needs it, how fresh the posts are, how long it takes, and what it costs. Run it once with a key
 * (TAVILY_API_KEY in .env.local) and put what it prints in FACTS.md.
 *
 *   node --experimental-strip-types scripts/try-tavily.ts [file]
 *
 * `file`: one sample per line, `#` for a comment; a line that starts with http is a page to read, any
 * other line is a search. Without one it tries a few of each, Reddit, Hacker News, indie and review sites.
 * The thing to look at first is Reddit: if its threads come back without their comments, or not at all,
 * Tavily is for the rest of the web only, and Reddit stays in the customer's Chrome.
 */
import { readFileSync } from "node:fs";
import { TavilyClient, TavilyError } from "../apps/agent/src/web/tavily-client.ts";
import { readEnvFile } from "./env-file.ts";

const key = process.env["TAVILY_API_KEY"] ?? readEnvFile().get("TAVILY_API_KEY");
if (!key) throw new Error("TAVILY_API_KEY must be in .env.local (or the environment)");
const client = new TavilyClient(key);

const DEFAULTS = `
# threads and pages Quest reads
https://www.reddit.com/r/SaaS/
# add real Reddit threads from the dev customer's finds here: the thread and its comments are the question
https://news.ycombinator.com/item?id=40000000
https://www.indiehackers.com/
https://tally.so/pricing
https://www.g2.com/categories/survey
https://www.trustpilot.com/review/typeform.com
https://alternativeto.net/software/typeform/
# searches Quest runs
typeform alternative for waitlists
site:reddit.com looking for a form builder
site:news.ycombinator.com ask hn form builder
"looking for" scheduling tool for freelancers
best invoicing app for freelancers reddit
`;

const samples = (process.argv[2] ? readFileSync(process.argv[2], "utf8") : DEFAULTS)
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

const DAY = 86_400_000;
const seen = { pages: 0, pagesOk: 0, searches: 0, searchesOk: 0, credits: 0, fresh: 0, dated: 0, redditHits: 0 };
const clip = (s: string, n = 100) => s.replace(/\s+/g, " ").slice(0, n);

for (const sample of samples) {
  const started = Date.now();
  const ms = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;
  try {
    if (/^https?:\/\//i.test(sample)) {
      seen.pages++;
      seen.credits += 0.2; // 1 credit per 5 pages
      const got = await client.extract([sample]);
      const page = got.results[0];
      if (!page?.raw_content.trim()) {
        console.log(`PAGE   no text   ${ms()}  ${sample}  ${got.failed[0] ? `(${clip(got.failed[0].error, 80)})` : ""}`);
        continue;
      }
      seen.pagesOk++;
      const comments = (page.raw_content.match(/comment/gi) ?? []).length;
      console.log(`PAGE   ${String(page.raw_content.length).padStart(6)} chars, "comment" ×${comments}  ${ms()}  ${sample}\n         ${clip(page.raw_content)}`);
    } else {
      seen.searches++;
      seen.credits += 1;
      const site = /\bsite:(\S+)/i.exec(sample);
      const hits = await client.search({
        query: sample.replace(/\bsite:\S+/gi, "").trim() || sample,
        max_results: 10,
        time_range: "month",
        ...(site?.[1] ? { include_domains: [site[1]] } : {}),
      });
      seen.searchesOk += hits.length ? 1 : 0;
      const dated = hits.filter((h) => h.published_date && !Number.isNaN(Date.parse(h.published_date)));
      const fresh = dated.filter((h) => Date.now() - Date.parse(h.published_date!) < 14 * DAY);
      seen.dated += dated.length;
      seen.fresh += fresh.length;
      seen.redditHits += hits.filter((h) => /(^|\.)reddit\.com$/i.test(new URL(h.url).hostname)).length;
      console.log(`SEARCH ${hits.length} results, ${dated.length} dated, ${fresh.length} under 14 days  ${ms()}  ${sample}`);
      for (const h of hits.slice(0, 3)) console.log(`         ${h.published_date?.slice(0, 10) ?? "no date  "} ${new URL(h.url).hostname}  ${clip(h.title, 60)}`);
    }
  } catch (e) {
    console.log(`FAILED ${e instanceof TavilyError ? e.reason : "error"}  ${ms()}  ${sample}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(
  `\n${seen.pagesOk}/${seen.pages} pages read, ${seen.searchesOk}/${seen.searches} searches with results; ` +
    `${seen.fresh} of ${seen.dated} dated results under 14 days old; ${seen.redditHits} Reddit results; ` +
    `about ${seen.credits.toFixed(1)} credits by the price list (the dashboard has the real count).`,
);
