import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { customerId } from "@mq/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Queryable } from "../src/infra/db.ts";
import { PgDraftRepository } from "../src/infra/pg-drafts.ts";
import { PgTrustRepository } from "../src/infra/pg-trust.ts";

const id = customerId("00000000-0000-0000-0000-000000000001");
describe("platform-independent outreach against PostgreSQL", () => {
  let db: PGlite;
  let drafts: PgDraftRepository;
  let trust: PgTrustRepository;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec("create role mq_app; create schema mq; create table mq.customers(id uuid primary key, lane text default 'test', quest text, brief text); create table mq.finds(id uuid primary key, sent_at timestamptz); create table mq.tasks(id uuid primary key); insert into mq.customers(id) values ('00000000-0000-0000-0000-000000000001');");
    for (const name of ["20261002120000_drafts.sql", "20261003120000_draft_watch.sql", "20261004120000_trust_and_journal.sql", "20261006184020_platform_independent_outreach.sql", "20261006191015_founder_autonomy.sql", "20261006195034_posting_preferences.sql", "20261006200516_find_post_claims.sql", "20261019130000_ideas_and_assets.sql", "20261104180000_contacts_and_trust_offers.sql", "20261106090000_drafts_answered_at.sql"]) {
      await db.exec(await readFile(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8"));
    }
    const queryable = { query: async (sql: string, values?: unknown[]) => {
      const result = await db.query(sql, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
    } } as Queryable;
    drafts = new PgDraftRepository(queryable, "test");
    trust = new PgTrustRepository(queryable);
  }, 120_000);
  afterAll(async () => { await db?.close(); });

  it("stores forum replies, titleless chat messages and email drafts, without relaxing the Reddit contract", async () => {
    for (const platform of ["forum.example.org", "chat.example.org", "mail.example.org"]) {
      const d = await drafts.add({ customerId: id, platform, kind: "message", url: `https://${platform}/messages`, target: "alex@example.org", title: platform.startsWith("mail") ? "Your forms question" : null, text: "A useful individual reply.", author: "Alex", quote: null });
      expect((await drafts.get(d.id))?.platform).toBe(platform);
    }
    await expect(drafts.add({ customerId: id, platform: "reddit", kind: "post", url: "https://reddit.com/r/test", target: "test", title: null, text: "No title", author: null, quote: null })).rejects.toThrow();
  });

  it("claims a send once and keeps an unknown result held across repository instances", async () => {
    const d = await drafts.add({ customerId: id, platform: "community.example.org", kind: "reply", url: "https://community.example.org/topic/42", target: "topic/42", title: null, text: "Here's what worked for me.", author: "Alex", quote: "What do you use for forms?" });
    expect(await drafts.beginPost(d.id)).toBe(true);
    expect(await drafts.beginPost(d.id)).toBe(false);
    expect(await drafts.revise(d.id, "Different words", null)).toBeNull();
    await drafts.endPost(d.id, true);
    expect((await drafts.get(d.id))?.status).toBe("uncertain");
    expect(await drafts.beginPost(d.id)).toBe(false);
  });

  it("records a confirmed send from its durable claim", async () => {
    const d = await drafts.add({ customerId: id, platform: "mail.example.org", kind: "message", url: "https://mail.example.org/inbox", target: "alex@example.org", title: "Forms", text: "Here's the tool you asked for.", author: null, quote: null });
    await drafts.beginPost(d.id);
    expect(await drafts.markSent(d.id, "https://mail.example.org/sent/123", "connected account", true)).toMatchObject({ status: "posted", alone: true, sentAs: "connected account" });
    expect(await drafts.beginPost(d.id)).toBe(false);
  });

  it("initializes autonomy once, respects host overrides, and applies a global ask-first choice", async () => {
    await trust.initialize(id);
    expect(await trust.approved(id, "new-forum.example.org")).toBe(3);
    await trust.set(id, "new-forum.example.org", 0);
    await trust.initialize(id);
    expect(await trust.approved(id, "new-forum.example.org")).toBe(0);
    await trust.set(id, "mail.example.org", 3);
    await trust.set(id, "*", 0);
    expect(await trust.approved(id, "mail.example.org")).toBe(0);
    expect(await trust.approved(id, "another-forum.example.org")).toBe(0);
    await trust.set(id, "*", 0, true);
    for (let n = 0; n < 4; n++) await trust.approve(id, "a-new-host.example.org");
    expect(await trust.approved(id, "a-new-host.example.org")).toBe(0);
    await trust.set(id, "a-new-host.example.org", 3, true);
    expect(await trust.approved(id, "a-new-host.example.org")).toBe(3);
  });
});
