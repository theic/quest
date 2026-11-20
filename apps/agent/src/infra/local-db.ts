import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

/**
 * The local edition's database: Postgres compiled to WebAssembly (PGlite), a folder on their disk, served on the
 * Postgres wire on this machine only, so the repositories, the queue's claims and LangGraph's checkpointer use it with
 * the same SQL as Supabase (FACTS.md, "The local edition": the 21 Postgres integration tests pass on it unchanged).
 *
 * What Supabase gives and a laptop does not need is stood in for, once, before the first migration: its roles, an
 * `auth.users` with the columns the migrations touch, and pg_cron and pg_net as functions that do nothing (a laptop
 * does not sleep, so nothing needs waking; the loops run in the agent). Each migration runs once, recorded by file name.
 */
/**
 * Postgres's folders that are empty between runs. A tool that clears empty folders (Windows' Temp cleanup did, on the
 * end-to-end sitting, 2026-11-20) leaves a database Postgres will not open ("could not open directory pg_notify") though
 * every row is there, so they are put back before it starts.
 */
const EMPTY_DIRS = ["pg_notify", "pg_snapshots", "pg_stat", "pg_stat_tmp", "pg_tblspc", "pg_twophase", "pg_replslot", "pg_serial", "pg_dynshmem", "pg_commit_ts", "pg_logical/snapshots", "pg_logical/mappings"];

export async function startLocalDb(o: { dataDir: string; migrations: string; port: number }): Promise<{ url: string; close(): Promise<void> }> {
  if (existsSync(join(o.dataDir, "PG_VERSION"))) for (const d of EMPTY_DIRS) mkdirSync(join(o.dataDir, d), { recursive: true });
  const db = await PGlite.create({ dataDir: o.dataDir, extensions: { pgcrypto } });
  const F = "$f$";
  const fresh = !(await db.query<{ n: number }>(`select count(*)::int n from pg_namespace where nspname = 'quest_local'`)).rows[0]!.n;
  if (fresh) {
    for (const s of [
      "create schema quest_local",
      "create table quest_local.migrations (name text primary key, at timestamptz not null default now())",
      "create role mq_app",
      "create role anon",
      "create role authenticated",
      "create role service_role",
      "create schema if not exists auth",
      "create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb, raw_app_meta_data jsonb, email_confirmed_at timestamptz, last_sign_in_at timestamptz, created_at timestamptz default now())",
      "create schema if not exists extensions",
      "create extension if not exists pgcrypto schema extensions",
      "create schema cron",
      "create table cron.job (jobid bigserial, jobname text)",
      `create function cron.schedule(a text, b text, c text) returns bigint language sql as ${F} select 1::bigint ${F}`,
      `create function cron.schedule(b text, c text) returns bigint language sql as ${F} select 1::bigint ${F}`,
      `create function cron.unschedule(a text) returns boolean language sql as ${F} select true ${F}`,
      "create schema net",
      `create function net.http_post(url text, body jsonb default null, params jsonb default null, headers jsonb default null, timeout_milliseconds int default 5000) returns bigint language sql as ${F} select 1::bigint ${F}`,
    ]) {
      await db.exec(s);
    }
  }
  const done = new Set((await db.query<{ name: string }>(`select name from quest_local.migrations`)).rows.map((r) => r.name));
  for (const f of readdirSync(o.migrations).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(o.migrations, f), "utf8").replace(/create extension[^;]*\b(pg_net|pg_cron)\b[^;]*;/gi, "");
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query(`insert into quest_local.migrations (name) values ($1)`, [f]);
    });
  }
  const server = new PGLiteSocketServer({ db, port: o.port, host: "127.0.0.1", maxConnections: 30 });
  await server.start();
  return {
    url: `postgres://postgres@127.0.0.1:${o.port}/postgres`,
    close: async () => {
      await server.stop();
      await db.close();
    },
  };
}
