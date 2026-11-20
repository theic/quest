/**
 * Finds the Supabase pooler host that serves the project, connects as mq_app,
 * and saves the working DATABASE_URL into .env.local. Prints hosts and results,
 * never the URL (it carries the password).
 *
 *   node --experimental-strip-types scripts/db-probe.ts <project-ref> <region>
 */
import pg from "pg";
import { basename } from "node:path";
import { ENV_PATH, readEnvFile, setEnvValue } from "./env-file.ts";

const [ref, region = "eu-central-1"] = process.argv.slice(2);
if (!ref) throw new Error("usage: db-probe.ts <project-ref> [region]");
const password = readEnvFile().get("MQ_DB_PASSWORD");
if (!password) throw new Error("MQ_DB_PASSWORD is missing; run scripts/init-secrets.ts first");

for (const host of [`aws-1-${region}.pooler.supabase.com`, `aws-0-${region}.pooler.supabase.com`]) {
  // Session mode (5432): prepared statements and LISTEN work, which LangGraph's checkpointer needs.
  const url = `postgresql://mq_app.${ref}:${encodeURIComponent(password)}@${host}:5432/postgres`;
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });
  try {
    await client.connect();
    const { rows } = await client.query<{ who: string; tables: string }>(
      "select current_user as who, (select count(*) from information_schema.tables where table_schema = 'mq')::text as tables",
    );
    console.log(`${host}: connected as ${rows[0]?.who}, ${rows[0]?.tables} tables in mq`);
    setEnvValue("DATABASE_URL", url);
    console.log(`DATABASE_URL saved to ${basename(ENV_PATH)}`);
    await client.end();
    process.exit(0);
  } catch (e) {
    console.log(`${host}: ${(e as Error).message}`);
    await client.end().catch(() => {});
  }
}
process.exit(1);
