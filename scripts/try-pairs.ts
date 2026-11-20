/**
 * Two people who need each other, live: a week of Hacker News' asks and launches (no browser), and, with --agent, the
 * sites a laptop agent's Chrome searches (`CHROME_DEBUG=1 npm run dev`, its /debug/chrome/search), matched in one call
 * on the volume seat. Prints the pairs. Nothing is saved or sent.
 *
 *   node --experimental-strip-types scripts/try-pairs.ts [customer id] [--days=7] [--agent]
 */
import { customerId, type FoundPost, type Logger, type PostQuery, type PostSearch } from "@mq/core";
import { loadConfig } from "../apps/agent/src/config.ts";
import { PairFinder, pairsText, wantedText } from "../apps/agent/src/finds/pair-finder.ts";
import { modelsFor } from "../apps/agent/src/model-source.ts";
import { createPool } from "../apps/agent/src/infra/db.ts";
import { PgKnownPeople } from "../apps/agent/src/infra/pg-known.ts";
import { readEnvFile } from "./env-file.ts";

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith("--")) ?? "00000000-0000-0000-0000-000000000000";
const days = Number(args.find((a) => a.startsWith("--days="))?.slice(7) ?? 7);
const AGENT = process.env.MQ_AGENT ?? "http://127.0.0.1:8080";

const config = loadConfig({ ...process.env, ...Object.fromEntries(readEnvFile()) });
const models = await modelsFor(config);
const log: Logger = { info: (e, d) => console.log(`  ${e} ${JSON.stringify(d ?? {})}`), warn: (e, d) => console.log(`  ! ${e} ${JSON.stringify(d ?? {})}`), error: (e, d) => console.log(`  !! ${e} ${JSON.stringify(d ?? {})}`) };

/** The agent's own search, through its debug route: the customer's Chrome for X, Reddit, LinkedIn and the web, and Bluesky and Mastodon from their own APIs. */
const viaAgent: PostSearch = {
  sources: () => (args.includes("--api") ? ["bluesky", "mastodon"] : ["x", "reddit", "linkedin", "bluesky", "mastodon", "web"]).map((name) => ({ name, covers: name, queryHint: "" })),
  search: async (q: PostQuery): Promise<FoundPost[]> => {
    const res = await fetch(`${AGENT}/debug/chrome/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ customerId: id, ...q }) });
    const body = (await res.json()) as unknown;
    if (!res.ok || !Array.isArray(body)) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
    return (body as (FoundPost & { postedAt: string | null })[]).map((p) => ({ ...p, postedAt: p.postedAt ? new Date(p.postedAt) : null }));
  },
};

// --wanted: the kinds of people several posts look for this week, for a post of the customer's own.
if (args.includes("--wanted")) {
  console.log(`\n${wantedText(await new PairFinder({ models, log }).wanted({ customerId: customerId(id), days }))}`);
  process.exit(0);
}
// --keep: with the shared cache, and every pair kept in mq.pairs (dev's database).
const known = args.includes("--keep") ? new PgKnownPeople(createPool(config.databaseUrl, 2)) : undefined;
const found = await new PairFinder({ models, log, ...(known ? { known } : {}) }).find({ customerId: customerId(id), days, ...(args.includes("--agent") ? { posts: viaAgent } : {}) });
console.log(`\n${pairsText(found)}`);
process.exit(0);
