/**
 * Copies one customer, and everything Quest keeps for them, from one database to another: at the
 * cutover, the founder's Quest from the dev database to production. Ids are kept, so what points
 * at what (an event at its promise, a find at its task) still does, and so is the state of their
 * unfinished tasks (LangGraph's checkpoints). Only the columns both databases have are copied.
 *
 * Stop every agent on both databases first: a row written during the copy would be left behind.
 * Refuses a customer the target already has. Prints table names and counts, never a row.
 *
 *   MQ_TO_ENV=../messaging-quest-v2/.env.production.local \
 *   MQ_ENV_FILE=../messaging-quest-v2/.env.local \
 *     node --experimental-strip-types scripts/copy-customer.ts <customer id> [--dry-run]
 *
 * --dry-run writes every row into the target inside a transaction and rolls it back.
 *
 * Afterwards the target's identity sequences must pass the copied ids. mq_app may not move them;
 * the script prints the statements to run as the owner (the Supabase connector).
 */
import pg from "pg";
import { readEnvFile } from "./env-file.ts";

const customer = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!customer || !/^[0-9a-f-]{36}$/.test(customer)) throw new Error("usage: copy-customer.ts <customer id>");
const toFile = process.env["MQ_TO_ENV"];
if (!toFile) throw new Error("MQ_TO_ENV must name the target's env file");
const fromUrl = readEnvFile().get("DATABASE_URL");
const toUrl = readEnvFile(toFile).get("DATABASE_URL");
if (!fromUrl || !toUrl) throw new Error("DATABASE_URL is missing from one of the env files");
if (fromUrl === toUrl) throw new Error("the source and the target are the same database");

/** Parents before children. `where` picks the customer's rows; $1 is the customer's id. */
const TABLES: readonly { name: string; where: string }[] = [
  { name: "customers", where: "id = $1" },
  { name: "channels", where: "customer_id = $1" },
  { name: "transcript", where: "customer_id = $1" },
  { name: "tasks", where: "customer_id = $1" },
  { name: "events", where: "customer_id = $1" },
  { name: "questions", where: "customer_id = $1" },
  { name: "finds", where: "customer_id = $1" },
  { name: "places", where: "customer_id = $1" },
  { name: "memories", where: "customer_id = $1" },
  { name: "drafts", where: "customer_id = $1" },
  { name: "trust", where: "customer_id = $1" },
  { name: "chrome_links", where: "customer_id = $1" },
  { name: "commitments", where: "customer_id = $1" },
  { name: "results", where: "customer_id = $1" },
  { name: "routes", where: "customer_id = $1" },
  { name: "model_calls", where: "customer_id = $1" },
  // The working state of their tasks still to finish; a finished task's is never read again.
  ...["checkpoints", "checkpoint_blobs", "checkpoint_writes"].map((name) => ({
    name,
    where: "thread_id in (select 'task:' || id from mq.tasks where customer_id = $1 and status in ('queued', 'running', 'waiting'))",
  })),
];

/** Rows a statement inserts. */
const BATCH = 50;

const connect = async (url: string) => {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
};
const from = await connect(fromUrl);
const to = await connect(toUrl);

const columns = async (db: pg.Client, table: string) =>
  (await db.query<{ column_name: string; is_identity: string }>(
    "select column_name, is_identity from information_schema.columns where table_schema = 'mq' and table_name = $1 and is_generated = 'NEVER'",
    [table],
  )).rows;

try {
  const present = await to.query("select 1 from mq.customers where id = $1", [customer]);
  if (present.rowCount) throw new Error("the target already has this customer");

  await to.query("begin");
  await to.query("set local statement_timeout = '5min'");
  const sequences: string[] = [];
  for (const { name, where } of TABLES) {
    const { rows } = await from.query<{ row: Record<string, unknown> }>(`select row_to_json(t) as row from mq.${name} t where ${where}`, [customer]);
    const targetColumns = await columns(to, name);
    const target = new Set(targetColumns.map((c) => c.column_name));
    const source = (await columns(from, name)).map((c) => c.column_name);
    const shared = source.filter((c) => target.has(c));
    const dropped = source.filter((c) => !target.has(c));
    const identity = targetColumns.filter((c) => c.is_identity === "YES").map((c) => c.column_name);
    const list = shared.map((c) => `"${c}"`).join(", ");
    // In batches: a task's checkpoints run to megabytes.
    for (let i = 0; i < rows.length; i += BATCH) {
      await to.query(
        `insert into mq.${name} (${list}) ${identity.length ? "overriding system value " : ""}select ${list} from json_populate_recordset(null::mq.${name}, $1::json)`,
        [JSON.stringify(rows.slice(i, i + BATCH).map((r) => r.row))],
      );
    }
    for (const column of identity) {
      sequences.push(`select setval(pg_get_serial_sequence('mq.${name}', '${column}'), greatest((select max(${column}) from mq.${name}), 1));`);
    }
    console.log(`${name}: ${rows.length}${dropped.length ? ` (left out, not in the target: ${dropped.join(", ")})` : ""}`);
  }
  if (dryRun) {
    await to.query("rollback");
    console.log("\ndry run: every row went in, and was rolled back");
  } else {
    await to.query("commit");
    console.log("\nRun as the owner on the target, so new rows pass the copied ids:");
    for (const s of sequences) console.log(s);
  }
} catch (e) {
  await to.query("rollback").catch(() => {});
  throw e;
} finally {
  await from.end();
  await to.end();
}
