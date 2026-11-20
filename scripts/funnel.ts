/**
 * The weekly funnel, the numbers the plan is judged by (docs/next-goal-open-source.md), read only.
 *
 *   node --experimental-strip-types scripts/funnel.ts [days] [production]
 *
 * Per platform: what went up (replies, messages, posts, likes, follows) and the people who answered. Then the offers
 * ("want the link?"), the links to messaging.quest, the people who said no, the pairs, the makers' pages with their views
 * and clicks, and the customers who came in by `came_from`. Dev by default; production reads production's file.
 */
import pg from "pg";
import { envPath, readEnvFile } from "./env-file.ts";

const args = process.argv.slice(2);
const days = Number(args.find((a) => /^\d+$/.test(a)) ?? 7);
const stage = args.includes("production") ? "production" : "dev";
const url = process.env["DATABASE_URL"] ?? readEnvFile(envPath(stage)).get("DATABASE_URL");
if (!url) throw new Error(`no DATABASE_URL for ${stage}`);
const db = new pg.Client({ connectionString: url, ssl: url.includes("localhost") ? false : { rejectUnauthorized: false } });
await db.connect();
const since = `now() - interval '${days} days'`;
const q = async <T>(sql: string): Promise<T[]> => (await db.query(sql)).rows as T[];

const sent = await q<{ platform: string; kind: string; n: string }>(
  `select coalesce(platform, '?') platform, kind, count(*)::text n from mq.drafts where sent_at > ${since} group by 1, 2`,
);
const answered = await q<{ platform: string; n: string }>(
  `select coalesce(nullif(split_part(regexp_replace(coalesce(url, ''), '^https?://(www\\.)?', ''), '/', 1), ''), '?') platform,
          count(distinct person)::text n
     from mq.results where stage = 'conversation' and created_at > ${since} group by 1`,
);
const site = (p: string): string => p.replace(/^www\./, "").replace(/^twitter\.com$/, "x.com");
const rows = new Map<string, Record<string, number>>();
for (const r of sent) {
  const row = rows.get(site(r.platform)) ?? {};
  row[r.kind] = (row[r.kind] ?? 0) + Number(r.n);
  rows.set(site(r.platform), row);
}
for (const r of answered) {
  const row = rows.get(site(r.platform)) ?? {};
  row["answered"] = (row["answered"] ?? 0) + Number(r.n);
  rows.set(site(r.platform), row);
}
const kinds = ["reply", "message", "post", "like", "follow", "answered"];
console.log(`${stage}, the ${days} days to ${new Date().toISOString().slice(0, 16)} UTC\n`);
console.log(["platform".padEnd(22), ...kinds.map((k) => k.padStart(9))].join(""));
const total: Record<string, number> = {};
for (const [p, row] of [...rows].sort((a, b) => (b[1]["reply"] ?? 0) - (a[1]["reply"] ?? 0))) {
  console.log([p.slice(0, 21).padEnd(22), ...kinds.map((k) => String(row[k] ?? 0).padStart(9))].join(""));
  for (const k of kinds) total[k] = (total[k] ?? 0) + (row[k] ?? 0);
}
console.log(["all".padEnd(22), ...kinds.map((k) => String(total[k] ?? 0).padStart(9))].join(""));

const [one] = await q<Record<string, string>>(`select
  (select count(*) from mq.drafts where sent_at > ${since} and kind in ('reply', 'message') and body ~* 'want the link') offers,
  (select count(*) from mq.drafts where sent_at > ${since} and body ~* 'messaging\\.quest') links,
  (select count(*) from mq.results where stage = 'conversation' and created_at > ${since}) conversations,
  (select count(*) from mq.said_no where created_at > ${since}) said_no,
  (select count(*) from mq.pairs where found_at > ${since}) pairs,
  (select count(*) from mq.match_pages where created_at > ${since}) pages,
  (select coalesce(sum(views), 0) from mq.match_pages where created_at > ${since}) views,
  (select coalesce(sum(clicks), 0) from mq.match_pages where created_at > ${since}) clicks,
  (select count(*) from mq.customers where created_at > ${since}) customers,
  (select count(*) from mq.customers where created_at > ${since} and swept_at is not null) swept`);
console.log("");
for (const [k, v] of Object.entries(one ?? {})) console.log(`${k.padEnd(14)}${v}`);
const came = await q<{ came_from: string; n: string }>(
  `select coalesce(came_from, '(none)') came_from, count(*)::text n from mq.customers where created_at > ${since} group by 1 order by 2 desc`,
);
if (came.length) console.log(`came_from     ${came.map((c) => `${c.came_from} ${c.n}`).join(", ")}`);
await db.end();
