/**
 * The local edition's database alone, served for anything that speaks Postgres (the integration tests, a psql):
 *
 *   node --experimental-strip-types scripts/local-db.ts [folder, ~/.quest/db] [port, 5499]
 *   MQ_INTEGRATION=1 DATABASE_URL=postgres://postgres@127.0.0.1:5499/postgres MQ_ENV_FILE=none npx vitest run apps/agent/test/pg.integration.test.ts
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { startLocalDb } from "../apps/agent/src/infra/local-db.ts";

const [dir = join(homedir(), ".quest", "db"), port = "5499"] = process.argv.slice(2);
const t0 = Date.now();
const db = await startLocalDb({ dataDir: dir, migrations: join(import.meta.dirname, "..", "supabase", "migrations"), port: Number(port) });
console.log(`${db.url} (${dir}), ready in ${Date.now() - t0} ms`);
process.on("SIGINT", () => void db.close().then(() => process.exit(0)));
