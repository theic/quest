import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = new URL("../../../supabase/migrations/", import.meta.url);
const migrations = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .map((name) => ({ name, sql: readFileSync(new URL(name, DIR), "utf8").replace(/--.*$/gm, "") }));

/** Tables made before this rule that rely on the schema's default privileges (mq_app has them; checked 2026-10-22). */
const GRANDFATHERED = new Set(["mq.finds"]);

const created = (sql: string): string[] => [...sql.matchAll(/create table (?:if not exists )?([a-z_.]+)/gi)].map((m) => m[1] ?? "");

/** Whether a migration says what mq_app may do with a table: a grant to it, or a revoke from it. */
function saysForApp(sql: string, table: string): boolean {
  const bare = table.replace(/^mq\./, "");
  return sql
    .split(";")
    .some((s) => /\b(grant|revoke)\b/i.test(s) && /\bmq_app\b/i.test(s) && (new RegExp(`\\bon\\b[^;]*\\b(mq\\.)?${bare}\\b`, "i").test(s) || /on all tables in schema mq/i.test(s)));
}

describe("the migrations", () => {
  it("make every table in mq, server-only, never in public", () => {
    // Supabase stops granting new public tables to its Data API on 2026-10-30; nothing here uses that API, and mq is
    // closed to anon and authenticated (20260925190000_agent_schema.sql).
    for (const { name, sql } of migrations) for (const table of created(sql)) expect(table, name).toMatch(/^mq\./);
  });

  it("say in the same file what mq_app may do with each new table", () => {
    let tables = 0;
    for (const { name, sql } of migrations) {
      for (const table of created(sql)) {
        if (GRANDFATHERED.has(table)) continue;
        tables++;
        expect(saysForApp(sql, table), `${name}: ${table} needs a grant to (or revoke from) mq_app`).toBe(true);
      }
    }
    expect(tables).toBeGreaterThan(20);
  });

  it("notices a table nobody granted", () => {
    expect(saysForApp("create table mq.ideas (id int); grant select on mq.assets, mq.ideas to mq_app;", "mq.ideas")).toBe(true);
    expect(saysForApp("create table mq.wake (id int); revoke all on mq.wake from mq_app, public;", "mq.wake")).toBe(true);
    expect(saysForApp("create table mq.ideas (id int); grant select on mq.assets to mq_app;", "mq.ideas")).toBe(false);
    expect(saysForApp("create table mq.ideas (id int); grant select on mq.ideas to anon;", "mq.ideas")).toBe(false);
    expect(saysForApp("create table mq.ideas_old (id int); grant select on mq.ideas_old to mq_app;", "mq.ideas")).toBe(false);
  });
});
