/**
 * The shared database of people's first fill: dev's mq.known_people into production's (the founder, 2026-11-19: "Yes,
 * load them"). Public columns only (no paired_at: who dev paired is dev's), never anyone who told dev's customer no
 * (mq.said_no), and never over a row production already has. Prints counts, never a value; without --write it only counts.
 *
 *   node --experimental-strip-types scripts/load-people.ts [--write]
 */
import pg from "pg";
import { envPath, readEnvFile } from "./env-file.ts";

const write = process.argv.includes("--write");
const url = (stage: "dev" | "production") => {
  const u = readEnvFile(envPath(stage)).get("DATABASE_URL");
  if (!u) throw new Error(`no DATABASE_URL for ${stage}`);
  return u;
};
const devUrl = url("dev");
const prodUrl = url("production");
if (!prodUrl.includes("atjukklkmfwhmbbzxaod") || !devUrl.includes("bglbnziyilxkxgzortuf")) throw new Error("the env files do not point at dev's and production's databases");

const dev = new pg.Client({ connectionString: devUrl, ssl: { rejectUnauthorized: false } });
const prod = new pg.Client({ connectionString: prodUrl, ssl: { rejectUnauthorized: false } });
await dev.connect();
await prod.connect();

const COLUMNS = ["key", "site", "handle", "name", "profile_url", "site_url", "about", "reach", "telegram", "makes", "makes_url", "makes_at", "wants", "wants_url", "wants_at", "checked_at", "created_at", "updated_at"];
const { rows } = await dev.query(
  `select ${COLUMNS.join(", ")} from mq.known_people k
    where not exists (select 1 from mq.said_no n where k.site = n.site and lower(k.handle) = lower(ltrim(n.person, '@')))`,
);
const { rows: all } = await dev.query<{ n: number }>(`select count(*)::int n from mq.known_people`);
console.log(`dev: ${all[0]!.n} people, ${rows.length} to load (${all[0]!.n - rows.length} said no)`);

if (write) {
  let added = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const batch = rows.slice(i, i + 1000);
    const r = await prod.query(
      `insert into mq.known_people (${COLUMNS.join(", ")})
       select ${COLUMNS.join(", ")} from jsonb_populate_recordset(null::mq.known_people, $1::jsonb)
       on conflict (key) do nothing`,
      [JSON.stringify(batch)],
    );
    added += r.rowCount ?? 0;
  }
  const { rows: now } = await prod.query<{ n: number }>(`select count(*)::int n from mq.known_people`);
  console.log(`production: ${added} added, ${now[0]!.n} people now`);
}
await dev.end();
await prod.end();
