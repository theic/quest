/**
 * A customer's daily report, made now from what the database keeps, written to a file to open (read only: nothing is
 * kept or sent). The evening turn makes the same page (main.ts, afterReport), with the news and what waits on them.
 *
 *   node --experimental-strip-types scripts/try-report.ts <customer id> [hours, 24] [file, .artifacts/report.html]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";
import { customerId } from "@mq/core";
import { PgReports } from "../apps/agent/src/infra/pg-reports.ts";
import { PgDraftMarks } from "../apps/agent/src/infra/pg-draft-marks.ts";
import { daySample } from "../apps/agent/src/manager/day-sample.ts";
import { reportHtml } from "../apps/agent/src/manager/day-report.ts";
import { envPath, readEnvFile } from "./env-file.ts";

const [id, hours = "24", file = ".artifacts/report.html"] = process.argv.slice(2);
if (!id) throw new Error("usage: try-report.ts <customer id> [hours] [file]");
const url = process.env["DATABASE_URL"] ?? readEnvFile(envPath("dev")).get("DATABASE_URL");
if (!url) throw new Error("no DATABASE_URL for dev");
const pool = new pg.Pool({ connectionString: url, ssl: url.includes("localhost") ? false : { rejectUnauthorized: false }, max: 2 });
const who = customerId(id);
const now = new Date();
const since = new Date(now.getTime() - Number(hours) * 3_600_000);
const reports = new PgReports(pool);
const tz = process.env["TZ_REPORT"] ?? "Europe/Lisbon";
const [today, week, answered, sent, charts] = await Promise.all([
  reports.platforms(who, since),
  reports.platforms(who, new Date(now.getTime() - 7 * 86_400_000)),
  reports.answered(who, since),
  new PgDraftMarks(pool).sent(who, since),
  reports.charts(who, new Date(since.getTime() - 13 * 86_400_000), since, tz),
]);
const html = reportHtml({
  day: now.toDateString(),
  news: null,
  answered,
  today,
  week,
  charts,
  needs: null,
  paused: [],
  sample: (daySample(sent, () => false) ?? "").split("\n").filter(Boolean),
});
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, html);
console.log(`${file}: ${html.length} bytes; ${answered.length} answered, ${sent.length} words up, ${today.length} platforms`);
for (const p of today) console.log(`  ${p.platform.padEnd(20)} ${JSON.stringify(p.sent)} answered ${p.answered}`);
await pool.end();
