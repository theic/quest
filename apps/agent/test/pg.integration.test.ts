/**
 * The Postgres adapters against the real dev database. Opt-in. Everything here
 * runs in the "test" lane, which the deployed agent never claims from:
 *
 *   MQ_INTEGRATION=1 npx vitest run apps/agent/test/pg.integration.test.ts
 */
import { existsSync } from "node:fs";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { CustomerId } from "@mq/core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChannelRegistry } from "../src/conversation/channel-registry.ts";
import { Messenger } from "../src/conversation/messenger.ts";
import { createPool } from "../src/infra/db.ts";
import { PgBilling } from "../src/infra/pg-billing.ts";
import { PgChromeLinks } from "../src/infra/pg-chrome-links.ts";
import { PgCommitmentRepository } from "../src/infra/pg-commitments.ts";
import { PgResultRepository, PgRouteRepository } from "../src/infra/pg-results.ts";
import { Commitments } from "../src/manager/commitments.ts";
import { PgCustomerRepository } from "../src/infra/pg-customers.ts";
import { PgDraftRepository } from "../src/infra/pg-drafts.ts";
import { PgOutbox } from "../src/infra/pg-outbox.ts";
import { Outbox } from "../src/drafts/outbox.ts";
import { PgEventQueue } from "../src/infra/pg-events.ts";
import { PgFindRepository } from "../src/infra/pg-finds.ts";
import { PgPlaceRepository } from "../src/infra/pg-places.ts";
import { PgMemoryRepository } from "../src/infra/pg-memory.ts";
import { PgQuestionRepository } from "../src/infra/pg-questions.ts";
import { PgSpendLog } from "../src/infra/pg-spend.ts";
import { PgTaskStore } from "../src/infra/pg-tasks.ts";
import { PgTranscript } from "../src/infra/pg-transcript.ts";
import { PgTrustRepository } from "../src/infra/pg-trust.ts";
import { PgWakeSchedule } from "../src/infra/pg-wake.ts";
import { silentLogger, systemClock } from "../src/infra/system.ts";
import { Errands } from "../src/lifecycle/errands.ts";
import { FindService } from "../src/finds/find-service.ts";
import { QuestionService } from "../src/questions/question-service.ts";
import { researcherSpec } from "../src/tasks/researcher.ts";
import { SubagentCatalog } from "../src/tasks/subagents.ts";
import { TaskRunner } from "../src/tasks/task-runner.ts";
import { TaskService } from "../src/tasks/task-service.ts";
import { FakeChannel, FakePoster, FakePostSearch, FakeReach, FakeReader } from "./fakes.ts";
import { stageOfDatabase } from "../src/environments.ts";
import { envPath } from "../../../scripts/env-file.ts";

// Dev's .env.local, the main checkout's from a worktree (scripts/env-file.ts).
const envFile = envPath("dev");
if (process.env["MQ_INTEGRATION"] && existsSync(envFile)) process.loadEnvFile(envFile);
const enabled = Boolean(process.env["MQ_INTEGRATION"] && process.env["DATABASE_URL"]);
// Never production's database, whatever the shell or MQ_ENV_FILE says ("Production and dev" in CLAUDE.md).
if (enabled && stageOfDatabase(process.env["DATABASE_URL"] ?? "") === "production") throw new Error("the integration tests run on dev's database, never production's");
const LANE = "test";

describe.skipIf(!enabled)("Postgres adapters (dev database)", () => {
  let pool: pg.Pool;
  const created: CustomerId[] = [];
  const chat = `it-${Date.now()}`;

  beforeAll(() => {
    pool = createPool(process.env["DATABASE_URL"]!, 4);
  });

  afterAll(async () => {
    if (created.length) {
      await pool.query(`delete from mq.customers where id = any($1::uuid[])`, [created]);
      await pool.query(`delete from mq.checkpoint_writes where thread_id like 'task:%' and thread_id not in (select 'task:' || id from mq.tasks)`).catch(() => undefined);
    }
    await pool.end();
  });

  async function newCustomer(suffix = "") {
    const customers = new PgCustomerRepository(pool, LANE);
    const c = await customers.create({ channel: { kind: "telegram", address: chat + suffix }, userRef: "1", displayName: "IT", language: "en" });
    created.push(c.id);
    return { customers, c };
  }

  it("creates, finds and updates customers; a racing create returns the same one", async () => {
    const { customers, c } = await newCustomer();
    const again = await customers.create({ channel: { kind: "telegram", address: chat }, userRef: "1", displayName: "IT", language: "en" });
    expect(again.id).toBe(c.id);
    expect((await customers.findByChannel({ kind: "telegram", address: chat }))?.id).toBe(c.id);
    await customers.update(c.id, { siteUrl: "https://acme.test/", status: "active" });
    expect((await customers.get(c.id)).status).toBe("active");
    expect(await customers.primaryChannel(c.id)).toEqual({ kind: "telegram", address: chat });
  });

  it("keeps the first-day answers by question, and takes each answer once", async () => {
    const { customers, c } = await newCustomer("-p");
    expect(c.profile).toEqual({});
    const asked = new Date("2026-10-01T12:00:00Z");
    await customers.profileAsked(c.id, "stage", "812", asked);
    await customers.profileAsked(c.id, "team", null, asked);

    expect(await customers.profileAnswered(c.id, "spend", { choice: "zero", answer: "Nothing yet", at: asked })).toBe(false); // never asked
    const at = new Date("2026-10-01T12:00:09Z");
    const twice = await Promise.all([
      customers.profileAnswered(c.id, "stage", { choice: "launched", answer: "Launched, nobody pays yet", at }),
      customers.profileAnswered(c.id, "stage", { choice: "paying", answer: "People pay for it", at }),
    ]);
    expect(twice.filter(Boolean)).toHaveLength(1);
    expect(await customers.profileAnswered(c.id, "team", { choice: "own", answer: "Two of us, \"part-time\"", at })).toBe(true);

    const { profile } = await customers.get(c.id);
    expect(profile["stage"]).toMatchObject({ askedAt: asked, ref: "812", answeredAt: at });
    expect(["launched", "paying"]).toContain(profile["stage"]?.choice);
    expect(profile["team"]).toEqual({ askedAt: asked, ref: null, answeredAt: at, choice: "own", answer: 'Two of us, "part-time"' });

    // A take: what it answers and Quest's words go out with it; what Quest took from their note comes after.
    const scene = { who: "leo, indie dev", where: "r/SaaS", says: "how do you get users?" };
    await customers.profileAsked(c.id, "take_1", "813", asked, { options: [{ id: "me", label: "That's me", sample: "go where they ask" }], scene });
    expect(await customers.profileAnswered(c.id, "take_1", { choice: "own", answer: "shorter, lowercase", at, spoken: true })).toBe(true);
    expect((await customers.get(c.id)).profile["take_1"]).toMatchObject({ scene, spoken: true, options: [{ sample: "go where they ask" }] });
  });

  it("records an incoming message once", async () => {
    const { c } = await newCustomer("-t");
    const t = new PgTranscript(pool);
    expect(await t.recordIncoming(c.id, "telegram", "m1", "hi")).toBe(true);
    expect(await t.recordIncoming(c.id, "telegram", "m1", "hi")).toBe(false);
    await t.recordOutgoing(c.id, "telegram", "m2", "hello");
    expect((await t.recent(c.id, 5)).map((e) => e.direction)).toEqual(["in", "out"]);
  });

  it("leases a customer's events to one worker at a time", async () => {
    const { c } = await newCustomer("-e");
    const q = new PgEventQueue(pool, LANE);
    await q.push(c.id, { kind: "user_message", text: "one" });
    await q.push(c.id, { kind: "heartbeat" });

    let claimed: CustomerId | null = null;
    for (let i = 0; i < 20 && claimed !== c.id; i++) claimed = await q.claimCustomer("w1", 60_000);
    expect(claimed).toBe(c.id);
    const taken = await q.take(c.id, 10);
    expect(taken.map((e) => e.event.kind)).toEqual(["user_message", "heartbeat"]);
    expect(taken[0]?.attempts).toBe(1);

    await q.retryLater([taken[1]!.id], "boom", 0, 3);
    await q.done([taken[0]!.id]);
    await q.release(c.id, "w1");
    const retried = await q.take(c.id, 10);
    expect(retried.map((e) => e.event.kind)).toEqual(["heartbeat"]);
    expect(retried[0]?.attempts).toBe(2);
    await q.done(retried.map((e) => e.id));
  });

  it("wakes a customer's manager for a follow-up at its time, keeping only the latest one set", async () => {
    const { c } = await newCustomer("-f");
    const q = new PgEventQueue(pool, LANE);
    const pending = async () =>
      (await pool.query<{ at: Date }>(`select available_at as at from mq.events where customer_id = $1 and kind = 'follow_up' and status = 'pending'`, [c.id])).rows.map((r) => r.at.getTime());
    const later = new Date(Date.now() + 3_600_000);

    await q.followUpAt(c.id, new Date(Date.now() + 60_000));
    await q.followUpAt(c.id, later);
    await q.followUpAt(c.id, later); // set again by the next turn: the same wake
    expect(await pending()).toEqual([later.getTime()]);
    const rows = await pool.query<{ n: number }>(`select count(*)::int as n from mq.events where customer_id = $1 and kind = 'follow_up'`, [c.id]);
    expect(rows.rows[0]!.n).toBe(2);
    expect(await q.take(c.id, 10)).toEqual([]); // not due yet

    await q.followUpAt(c.id, new Date(Date.now() - 60_000));
    const due = await q.take(c.id, 10);
    expect(due.map((e) => e.event)).toEqual([{ kind: "follow_up" }]);
    await q.done(due.map((e) => e.id));

    await q.followUpAt(c.id, later);
    await q.followUpAt(c.id, null);
    expect(await pending()).toEqual([]);
  });

  it("keeps what Quest owes, wakes it for each one at its time, and settles it once", async () => {
    const { c } = await newCustomer("-p");
    const q = new PgEventQueue(pool, LANE);
    const commitments = new Commitments({ repo: new PgCommitmentRepository(pool), schedule: q, clock: systemClock, log: silentLogger });
    const wakes = async () =>
      (await pool.query<{ id: string; at: Date }>(`select payload->>'commitmentId' as id, available_at as at from mq.events where customer_id = $1 and kind = 'commitment_due' and status = 'pending'`, [c.id])).rows;
    const due = new Date(Date.now() + 60 * 60_000);

    const p = await commitments.add(c.id, { kind: "promise", what: "whether it does Taiwanese", words: "within an hour", person: null, url: null, taskId: null, dueAt: due, onTime: false, source: "said" });
    expect(p).toMatchObject({ kind: "promise", status: "open", moves: 0, words: "within an hour" });
    expect(p.checkAt.getTime()).toBe(due.getTime() - 12 * 60_000);
    expect(await wakes()).toEqual([{ id: p.id, at: p.checkAt }]);

    const later = new Date(due.getTime() + 30 * 60_000);
    const moved = await commitments.move(c.id, p.id, later, "another 30 min", "the second site is slow");
    expect(moved).toMatchObject({ moves: 1, words: "another 30 min", dueAt: later });
    expect((await wakes()).map((w) => w.at.getTime())).toEqual([moved!.checkAt.getTime()]);

    expect(await commitments.settle(c.id, p.id, "kept", "sent it")).toMatchObject({ status: "kept", note: "sent it" });
    expect(await commitments.settle(c.id, p.id, "dropped", "again")).toBeNull();
    expect(await wakes()).toEqual([]);
    expect(await commitments.open(c.id)).toEqual([]);
    expect((await commitments.settled(c.id, 5)).map((x) => x.id)).toEqual([p.id]);
  });

  it("keeps results once per person and stage, counts as given, routes by name, and the reactions Quest gave", async () => {
    const { c } = await newCustomer("-r");
    const results = new PgResultRepository(pool);
    expect((await results.record(c.id, { stage: "conversation", person: "u/Grace", count: 1, url: null, evidence: "answered the reply", source: "system" })).added).toBe(true);
    expect((await results.record(c.id, { stage: "conversation", person: "u/grace", count: 1, url: null, evidence: "again", source: "seen" })).added).toBe(false);
    expect((await results.record(c.id, { stage: "paying", person: null, count: 0, url: null, evidence: "nobody pays yet", source: "told" })).entry).toMatchObject({ count: 0, person: null });
    expect((await results.list(c.id, 10)).map((r) => r.stage)).toEqual(["paying", "conversation"]);

    const routes = new PgRouteRepository(pool);
    expect(await routes.log(c.id, "Reddit replies", "thin", "2 old finds")).toMatchObject({ status: "trying", tries: 1, misses: 1 });
    expect(await routes.log(c.id, "reddit   REPLIES", "failed", null)).toMatchObject({ name: "Reddit replies", status: "spent", tries: 2, misses: 2, lastNote: "2 old finds" });
    expect(await routes.reopen(c.id, "Reddit replies", "new account history")).toMatchObject({ status: "trying", misses: 1 });
    expect(await routes.log(c.id, "Reddit replies", "worked", "u/grace answered")).toMatchObject({ status: "working", wins: 1, misses: 0 });
    expect((await routes.list(c.id)).map((r) => r.name)).toEqual(["Reddit replies"]);

    const t = new PgTranscript(pool);
    await t.recordIncoming(c.id, "telegram", "r1", "No Reddit today please.");
    await t.recordReaction(c.id, "telegram", "r1", "👍");
    expect((await t.recent(c.id, 5)).at(-1)).toMatchObject({ ref: "r1", reaction: "👍" });
  });

  it("says how long each teammate's runs take", async () => {
    const paces = await new PgTaskStore(pool, LANE).paces(new Date(Date.now() - 14 * 86_400_000));
    for (const p of paces) {
      expect(p.runs).toBeGreaterThan(0);
      expect(p.p80Ms).toBeGreaterThanOrEqual(p.medianMs);
    }
  });

  it("keeps drafts: open until posted or skipped, once each, and counts what went up", async () => {
    const { c } = await newCustomer("-d");
    const drafts = new PgDraftRepository(pool);
    const reply = await drafts.add({
      customerId: c.id,
      kind: "reply",
      platform: "reddit",
      url: "https://www.reddit.com/r/SaaS/comments/abc123/comment/c1/",
      target: "t1_c1",
      title: null,
      author: "sam",
      quote: "the free plan caps responses",
      text: "It doesn't.",
    });
    const post = await drafts.add({ customerId: c.id, kind: "post", platform: "reddit", url: "https://www.reddit.com/r/nocode/", target: "nocode", title: "Forms?", author: null, quote: null, text: "What do you use?" });
    await drafts.markShown(reply.id, "77");
    expect(await drafts.get(reply.id)).toMatchObject({ status: "open", cardRef: "77", quote: "the free plan caps responses" });

    expect(await drafts.markSent(reply.id, "https://www.reddit.com/r/SaaS/comments/abc123/comment/n1/", "dana_builds")).toMatchObject({ status: "posted", sentAs: "dana_builds" });
    expect(await drafts.markSent(reply.id, "x", "y")).toBeNull();
    expect(await drafts.skip(post.id)).toMatchObject({ status: "skipped" });
    expect(await drafts.skip(post.id)).toBeNull();
    expect(await drafts.sentSince(c.id, new Date(Date.now() - 3_600_000))).toBe(1);
    expect((await drafts.recent(c.id, 5)).map((d) => d.kind)).toEqual(["post", "reply"]);
    // The posted reply is looked at again for answers, in this lane only.
    const lane = new PgDraftRepository(pool, LANE);
    await lane.watch(reply.id, new Date(Date.now() - 1_000), 1, ["t1_a1"]);
    expect((await lane.dueWatches(new Date(), 50)).find((w) => w.draft.id === reply.id)).toMatchObject({ checks: 1, seen: ["t1_a1"] });
    expect((await drafts.dueWatches(new Date(), 50)).some((w) => w.draft.id === reply.id)).toBe(false); // not the live lane's
    await lane.watch(reply.id, null, 2, ["t1_a1"]);
    expect((await lane.dueWatches(new Date(), 50)).some((w) => w.draft.id === reply.id)).toBe(false);
    // A claim a stopped machine left is found at start, in this lane only, and held as uncertain once.
    const left = await drafts.add({ customerId: c.id, kind: "post", platform: "reddit", url: "https://www.reddit.com/r/nocode/", target: "nocode", title: "Forms, again?", author: null, quote: null, text: "What do you use now?" });
    expect(await lane.beginPost(left.id)).toBe(true);
    expect(await lane.beginPost(left.id)).toBe(false);
    expect((await lane.leftPosting()).map((d) => d.id)).toContain(left.id);
    expect((await drafts.leftPosting()).some((d) => d.id === left.id)).toBe(false); // not the live lane's
    await lane.endPost(left.id, true);
    expect(await drafts.get(left.id)).toMatchObject({ status: "uncertain" });
    expect((await lane.leftPosting()).some((d) => d.id === left.id)).toBe(false);
    // A post without a title, or a reply without the words it answers, is not a draft.
    await expect(drafts.add({ customerId: c.id, kind: "post", platform: "reddit", url: "u", target: "nocode", title: null, author: null, quote: null, text: "Hi" })).rejects.toThrow();
    // New words for their own Reddit profile have no title, and need none.
    await expect(drafts.add({ customerId: c.id, kind: "profile", platform: "reddit", url: "https://www.reddit.com/settings/profile", target: "about", title: null, author: null, quote: null, text: "I make Acme" })).resolves.toMatchObject({ kind: "profile", title: null });
  });

  it("keeps one line in the outbox per draft, claims it once, and paces by what went up on trust", async () => {
    const { c } = await newCustomer("-o");
    const drafts = new PgDraftRepository(pool);
    const d = await drafts.add({ customerId: c.id, kind: "reply", platform: "x.com", url: "https://x.com/a/status/1", target: "https://x.com/a/status/1", title: null, author: "a", quote: "which tool", text: "This one." });
    const outbox = new PgOutbox(pool, LANE);
    const line = await outbox.add({ customerId: c.id, ref: { draftId: d.id }, site: "x.com", approved: "trust" });
    expect(line).toMatchObject({ status: "queued", approved: "trust", draftId: d.id, findId: null });
    expect(await outbox.add({ customerId: c.id, ref: { draftId: d.id }, site: "x.com", approved: "tap" })).toBeNull(); // one line at a time
    expect((await outbox.due(new Date(), 100)).map((i) => i.id)).toContain(line!.id);
    // Live work never sees a test lane's line.
    expect((await new PgOutbox(pool, "live").due(new Date(), 1000)).map((i) => i.id)).not.toContain(line!.id);

    await outbox.wait(line!.id, new Date(Date.now() + 60_000), "tapped", "tap");
    expect(await outbox.of({ draftId: d.id })).toMatchObject({ approved: "tap", reason: "tapped" });
    expect((await outbox.due(new Date(), 100)).map((i) => i.id)).not.toContain(line!.id);
    await outbox.wait(line!.id, new Date(), "now");

    const claims = await Promise.all([outbox.claim(line!.id), outbox.claim(line!.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await outbox.leftSending()).map((i) => i.id)).toContain(line!.id);
    await outbox.settle(line!.id, "done", "sent");
    expect(await outbox.of({ draftId: d.id })).toBeNull();
    expect((await outbox.sentSince(c.id, new Date(Date.now() - 3_600_000))).map((r) => r.site)).toEqual(["x.com"]); // their tap paces the next one too

    const again = await outbox.add({ customerId: c.id, ref: { draftId: d.id }, site: "x.com", approved: "trust" });
    await outbox.claim(again!.id);
    await outbox.settle(again!.id, "done", "sent");
    expect((await outbox.sentSince(c.id, new Date(Date.now() - 3_600_000))).map((r) => r.site)).toEqual(["x.com"]);
    const third = await outbox.add({ customerId: c.id, ref: { draftId: d.id }, site: "x.com", approved: "tap" });
    expect(await outbox.drop({ draftId: d.id }, "skipped")).toBe(true);
    expect((await outbox.active(c.id)).map((i) => i.id)).not.toContain(third!.id);
  });

  it("claims tasks under a lease and respects the per-customer limit", async () => {
    const { c } = await newCustomer("-k");
    const store = new PgTaskStore(pool, LANE);
    const a = await store.create({ customerId: c.id, agent: "researcher", title: "A", instructions: "a" });
    const b = await store.create({ customerId: c.id, agent: "researcher", title: "B", instructions: "b" });

    const claimedIds: string[] = [];
    for (let i = 0; i < 30 && claimedIds.length < 1; i++) {
      const got = await store.claim("w1", 60_000, 1);
      if (got && (got.task.id === a.id || got.task.id === b.id)) claimedIds.push(got.task.id);
      else if (got) await store.release(got.task.id, "w1", got.task.nextInput, 0);
    }
    expect(claimedIds).toHaveLength(1);
    const first = claimedIds[0]!;
    const other = first === a.id ? b.id : a.id;
    // limit 1: the customer's other task must wait
    const blocked = await store.claim("w2", 60_000, 1);
    expect(blocked?.task.id === other).toBe(false);
    if (blocked) await store.release(blocked.task.id, "w2", blocked.task.nextInput, 0);

    await store.requestInterrupt(first as never, { kind: "instructions", text: "new" });
    expect((await store.heartbeat(first as never, "w1", 60_000)).interruptRequested).toBe(true);
    expect((await store.heartbeat(first as never, "wX", 60_000)).held).toBe(false);
    await store.park(first as never, "w1");
    expect((await store.get(first as never))?.status).toBe("waiting");
    expect((await store.requeue(first as never, { kind: "resume", answers: { x: "y" } }))?.status).toBe("queued");
    expect((await store.requestCancel(other as never))?.status).toBe("cancelled");
  });

  it("keeps questions idempotent per interrupt and finds them by the message that asked", async () => {
    const { c } = await newCustomer("-q");
    const tasks = new PgTaskStore(pool, LANE);
    const questions = new PgQuestionRepository(pool);
    const t = await tasks.create({ customerId: c.id, agent: "researcher", title: "Q", instructions: "q" });
    const q1 = await questions.create({ customerId: c.id, taskId: t.id, interruptId: "i1", agent: "researcher", text: "Who?", options: ["A", "B"], why: null });
    const again = await questions.create({ customerId: c.id, taskId: t.id, interruptId: "i1", agent: "researcher", text: "Who?", options: ["A", "B"], why: null });
    expect(again.id).toBe(q1.id);
    expect(q1.options).toEqual(["A", "B"]);
    await questions.markAsked(q1.id, "555");
    expect((await questions.findByAskedRef(c.id, "555"))?.id).toBe(q1.id);
    expect((await questions.answer(q1.id, "A", "user"))?.status).toBe("answered");
    expect(await questions.answer(q1.id, "B", "user")).toBeNull();
    const q2 = await questions.create({ customerId: c.id, taskId: t.id, interruptId: "i2", agent: "researcher", text: "Why?", options: [], why: null });
    expect((await questions.dismiss(q2.id, "skip"))?.answer).toBe("skip");
    expect(await questions.listForTask(t.id, ["pending", "asked"])).toEqual([]);
  });

  it("keeps one find per post, shows the best first, and takes each decision once", async () => {
    const { c } = await newCustomer("-f");
    const finds = new PgFindRepository(pool);
    const base = { customerId: c.id, taskId: null, author: "ann", title: null, why: "asks for it", reply: "Try this.", quote: "any simple analytics tool?" };
    const old = await finds.add({ ...base, source: "hackernews", url: "https://news.ycombinator.com/item?id=1", postedAt: new Date("2026-06-01"), strength: "strong" });
    const fresh = await finds.add({ ...base, source: "hackernews", url: "https://news.ycombinator.com/item?id=2", postedAt: new Date("2026-09-20"), strength: "strong" });
    const maybe = await finds.add({ ...base, source: "bluesky", url: "https://bsky.app/profile/a/post/3", postedAt: new Date("2026-09-25"), strength: "maybe" });
    expect(await finds.add({ ...base, source: "hackernews", url: "https://news.ycombinator.com/item?id=1", postedAt: null, strength: "maybe" })).toBeNull();
    expect([...(await finds.known(c.id, ["https://news.ycombinator.com/item?id=1", "https://x.test/"]))]).toEqual(["https://news.ycombinator.com/item?id=1"]);

    expect((await finds.nextToShow(c.id, 3)).map((f) => f.id)).toEqual([fresh!.id, old!.id, maybe!.id]);
    await finds.markShown(fresh!.id, "700");
    expect(await finds.decide(old!.id, "kept")).toBeNull(); // never shown
    expect((await finds.decide(fresh!.id, "skipped"))?.status).toBe("skipped");
    expect(await finds.decide(fresh!.id, "kept")).toBeNull();
    expect((await finds.giveReason(fresh!.id, "too_old"))?.skipReason).toBe("too_old");
    expect(await finds.counts(c.id)).toEqual({ new: 2, shown: 0, kept: 0, skipped: 1, replied: 0 });
    expect((await finds.listFor(c.id, ["skipped"], 5))[0]?.cardRef).toBe("700");
    expect(await finds.dropWaiting(c.id, [maybe!.id, fresh!.id])).toBe(1); // only the one never shown
    expect(await finds.counts(c.id)).toEqual({ new: 1, shown: 0, kept: 0, skipped: 1, replied: 0 });
  });

  it("records a reply posted on the customer's tap once, and counts the day's posts", async () => {
    const { c } = await newCustomer("-post");
    const finds = new PgFindRepository(pool);
    const since = new Date(Date.now() - 60_000);
    const f = await finds.add({
      customerId: c.id,
      taskId: null,
      source: "reddit:r/SaaS",
      url: `https://www.reddit.com/r/SaaS/comments/abc${chat}/x/`,
      author: "sam",
      title: null,
      quote: "any simple form tool?",
      postedAt: null,
      why: "asks for it",
      reply: "Try this.",
      strength: "strong",
      replyTo: "t1_c1",
    });
    expect(f?.replyTo).toBe("t1_c1");
    await finds.markShown(f!.id, "701");
    // A claim a stopped machine left is found at start, in this lane only.
    expect(await finds.beginPost(f!.id)).toBe(true);
    expect((await new PgFindRepository(pool, LANE).leftPosting()).map((x) => x.id)).toContain(f!.id);
    expect((await finds.leftPosting()).some((x) => x.id === f!.id)).toBe(false); // not the live lane's
    await finds.endPost(f!.id, false);
    const sent = await finds.markSent(f!.id, "https://www.reddit.com/r/SaaS/comments/abc/comment/n1/", "dana_builds");
    expect(sent).toMatchObject({ status: "replied", sentAs: "dana_builds", sentUrl: "https://www.reddit.com/r/SaaS/comments/abc/comment/n1/" });
    expect(sent?.sentAt).toBeInstanceOf(Date);
    expect(await finds.markSent(f!.id, "https://elsewhere.test/", "other")).toBeNull(); // once
    expect(await finds.sentSince(c.id, since)).toBe(1);

    // Looked at again for answers, in this lane only.
    const due = new Date(Date.now() - 1_000);
    await finds.watch(f!.id, due, 0, []);
    expect((await new PgFindRepository(pool, LANE).dueWatches(new Date(), 50)).find((w) => w.find.id === f!.id)).toMatchObject({ checks: 0, seen: [] });
    expect((await new PgFindRepository(pool).dueWatches(new Date(), 50)).some((w) => w.find.id === f!.id)).toBe(false); // not the live lane's
    await finds.watch(f!.id, null, 1, ["t1_a1"]);
    expect((await new PgFindRepository(pool, LANE).dueWatches(new Date(), 50)).some((w) => w.find.id === f!.id)).toBe(false);
  });

  it("files one place per key, and a second filing updates it", async () => {
    const { c } = await newCustomer("-places");
    const places = new PgPlaceRepository(pool);
    const nocode = { customerId: c.id, key: "reddit:r/nocode", name: "r/nocode", url: "https://www.reddit.com/r/nocode/", verdict: "search" as const, rules: null, why: "Builders ask for form tools." };
    expect((await places.save(nocode)).added).toBe(true);
    const again = await places.save({ ...nocode, verdict: "avoid", rules: "No self-promotion." });
    expect(again).toMatchObject({ added: false, place: { verdict: "avoid", rules: "No self-promotion." } });
    await places.save({ ...nocode, key: "community.shopify.com", name: "Shopify Community", url: "https://community.shopify.com/", verdict: "login" });
    expect((await places.listFor(c.id)).map((p) => [p.key, p.verdict])).toEqual([
      ["community.shopify.com", "login"],
      ["reddit:r/nocode", "avoid"],
    ]);
  });

  it("keeps each model call's tokens and cost, and sums them by day", async () => {
    const { c } = await newCustomer("-spend");
    const spend = new PgSpendLog(pool, silentLogger);
    const usage = { input: 12_000, cached: 11_000, cacheWrite: 0, output: 40, reasoning: 0, cost: 0.000_58 };
    spend.record({ customerId: c.id, taskId: null, agent: "manager", model: "xiaomi/mimo-v2.6-pro", ms: 1_234, usage });
    spend.record({ customerId: c.id, taskId: null, agent: "manager", model: "xiaomi/mimo-v2.6-pro", ms: 900, usage: { ...usage, cached: 0, cost: 0.005_2 } });
    // Written without waiting: give the two inserts a moment.
    const rowsIn = async () => (await pool.query<{ n: number }>(`select count(*)::int as n from mq.model_calls where customer_id = $1`, [c.id])).rows[0]!.n;
    for (let i = 0; i < 50 && (await rowsIn()) < 2; i++) await new Promise((r) => setTimeout(r, 100));
    const { rows } = await pool.query(
      `select calls, input_tokens::int, cached_tokens::int, cache_share::float as cache_share, cost::float as cost from mq.model_spend where customer_id = $1`,
      [c.id],
    );
    expect(rows).toEqual([{ calls: 2, input_tokens: 24_000, cached_tokens: 11_000, cache_share: 0.458, cost: 0.005_78 }]);
  });

  it("rests a customer whose day's credits are spent: nothing of theirs is claimed but the evening report, and the queue clock waits", async () => {
    // A lane of its own, so the queue clock sees this customer alone.
    const lane = `rest-${Date.now()}`;
    const customers = new PgCustomerRepository(pool, lane);
    const c = await customers.create({ channel: { kind: "telegram", address: `${chat}-rest` }, userRef: "1", displayName: "IT", language: "en" });
    created.push(c.id);
    const billing = new PgBilling(pool);
    const events = new PgEventQueue(pool, lane);
    const tasks = new PgTaskStore(pool, lane);
    const clock = new PgWakeSchedule(pool, 3_600_000, lane);
    const since = new Date(Date.now() - 60_000);

    new PgSpendLog(pool, silentLogger).record({ customerId: c.id, taskId: null, agent: "scout", model: "m", ms: 1, usage: { input: 1, cached: 0, cacheWrite: 0, output: 1, reasoning: 0, cost: 2.5 } });
    for (let i = 0; i < 50 && (await billing.day(c.id, since)).spent < 2.5; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await billing.day(c.id, since)).toEqual({ spent: 2.5, wallet: null, bought: false, restUntil: null });
    expect((await billing.day(c.id, new Date(Date.now() + 1_000))).spent).toBe(0);

    const until = new Date(Math.ceil((Date.now() + 3_600_000) / 1000) * 1000);
    expect(await billing.rest(c.id, until)).toBe(true);
    expect(await billing.rest(c.id, new Date(until.getTime() + 3_600_000))).toBe(false); // one rest at a time
    expect((await billing.day(c.id, since)).restUntil).toEqual(until);

    await events.push(c.id, { kind: "user_message", text: "any news?" });
    const t = await tasks.create({ customerId: c.id, agent: "researcher", title: "R", instructions: "r" });
    expect(await events.claimCustomer("w", 60_000)).toBeNull();
    expect(await tasks.claim("w", 60_000, 5)).toBeNull();
    expect(await clock.nextWorkAt()).toEqual(until);

    // The evening report does not wait.
    await events.push(c.id, { kind: "day_report", day: "2026-10-16" });
    expect((await clock.nextWorkAt())!.getTime()).toBeLessThan(until.getTime());
    expect(await events.claimCustomer("w", 60_000)).toBe(c.id);
    const report = await events.take(c.id, 10);
    expect(report.map((e) => e.event.kind)).toEqual(["day_report"]);
    await events.done(report.map((e) => e.id));
    await events.release(c.id, "w");

    // A top-up: kept once per session, the bonus only with the first; their rest ends at once, and what waited is taken.
    expect(await billing.topUp({ session: `cs_${lane}_1`, customerId: c.id, paid: 20, bonus: 5 })).toMatchObject({ credit: 25, bonus: 5 });
    expect(await billing.topUp({ session: `cs_${lane}_1`, customerId: c.id, paid: 20, bonus: 5 })).toBeNull();
    expect(await billing.topUp({ session: `cs_${lane}_2`, customerId: c.id, paid: 50, bonus: 15 })).toMatchObject({ credit: 50, bonus: 0 });
    // The calls before the first top-up are not drawn from it.
    await billing.draw(c.id, new Date());
    expect((await billing.day(c.id, since)).wallet).toEqual({ paid: 75, spent: 0, topUps: 2 });
    await billing.endRest(c.id);
    expect(await events.claimCustomer("w", 60_000)).toBe(c.id);
    await events.done((await events.take(c.id, 10)).map((e) => e.id));
    await events.release(c.id, "w");
    expect((await tasks.claim("w", 60_000, 5))?.task.id).toBe(t.id);
    await tasks.finish(t.id, "w", { status: "cancelled" });
  });

  it("trades a code for a connected Chrome once, and keeps one Chrome per customer", async () => {
    const { c } = await newCustomer("-chrome");
    const links = new PgChromeLinks(pool);
    const now = new Date();
    const soon = new Date(now.getTime() + 15 * 60_000);

    await links.offer(c.id, `code-a-${chat}`, soon);
    expect(await links.lastOffer(c.id)).toBeInstanceOf(Date);
    const first = await links.redeem(`code-a-${chat}`, `token-a-${chat}`, "Chrome 141 on Windows", now);
    expect(first).toMatchObject({ customerId: c.id, device: "Chrome 141 on Windows" });
    expect(await links.redeem(`code-a-${chat}`, `token-x-${chat}`, null, now)).toBeNull(); // one use
    expect(await links.lastOffer(c.id)).toBeNull();

    await links.offer(c.id, `code-b-${chat}`, soon);
    const second = await links.redeem(`code-b-${chat}`, `token-b-${chat}`, null, now);
    expect(await links.byToken(`token-a-${chat}`)).toBeNull(); // replaced
    expect((await links.active(c.id))?.id).toBe(second?.id);

    await links.offer(c.id, `code-c-${chat}`, new Date(now.getTime() - 1_000));
    expect(await links.redeem(`code-c-${chat}`, `token-c-${chat}`, null, now)).toBeNull(); // expired

    expect(await links.revoke(second!.id, now)).toMatchObject({ id: second!.id });
    expect(await links.active(c.id)).toBeNull();
  });

  it("keeps lanes apart: a live agent never claims test work, and the queue clock sees each lane alone", async () => {
    const { c } = await newCustomer("-l");
    const testQueue = new PgEventQueue(pool, LANE);
    const liveQueue = new PgEventQueue(pool);
    await testQueue.push(c.id, { kind: "user_message", text: "hi" });

    for (let i = 0; i < 10; i++) {
      const live = await liveQueue.claimCustomer("live-agent", 60_000);
      expect(live).not.toBe(c.id);
      if (live) await liveQueue.release(live, "live-agent");
    }
    const liveTasks = new PgTaskStore(pool);
    const t = await new PgTaskStore(pool, LANE).create({ customerId: c.id, agent: "researcher", title: "L", instructions: "l" });
    const claimed = await liveTasks.claim("live-agent", 60_000, 5);
    expect(claimed?.task.id === t.id).toBe(false);
    if (claimed) await liveTasks.release(claimed.task.id, "live-agent", claimed.task.nextInput, 0);

    expect(await new PgWakeSchedule(pool, 3_600_000, LANE).nextWorkAt()).not.toBeNull();
    let claimedTest: CustomerId | null = null;
    for (let i = 0; i < 20 && claimedTest !== c.id; i++) claimedTest = await testQueue.claimCustomer("w-test", 60_000);
    expect(claimedTest).toBe(c.id);
    await testQueue.done((await testQueue.take(c.id, 10)).map((e) => e.id));
    await testQueue.release(c.id, "w-test");
    await new PgTaskStore(pool, LANE).requestCancel(t.id);
  });

  it("persists arbitrary workspace drafts, durable send claims and global/host posting choices", async () => {
    const { c } = await newCustomer("-browser");
    const drafts = new PgDraftRepository(pool, LANE);
    const trust = new PgTrustRepository(pool);
    const d = await drafts.add({ customerId: c.id, platform: "chat.example.org", kind: "message", url: "https://chat.example.org/room", target: "Alex", title: null, author: null, quote: null, text: "Your requested link." });
    expect(await drafts.beginPost(d.id)).toBe(true);
    expect(await drafts.beginPost(d.id)).toBe(false);
    await drafts.endPost(d.id, true);
    expect((await drafts.get(d.id))?.status).toBe("uncertain");
    await trust.initialize(c.id);
    expect(await trust.approved(c.id, "chat.example.org")).toBe(3);
    await trust.set(c.id, "chat.example.org", 0);
    expect(await trust.approved(c.id, "chat.example.org")).toBe(0);
    expect(await trust.approved(c.id, "mail.example.org")).toBe(3);
    await trust.set(c.id, "*", 0);
    expect(await trust.approved(c.id, "mail.example.org")).toBe(0);
  });

  it("parks a real run on a question and resumes it from the Postgres checkpoint", async () => {
    const { customers, c } = await newCustomer("-r");
    // Tables come from supabase/migrations; mq_app may not run setup() (it creates schemas).
    const checkpointer = new PostgresSaver(pool, undefined, { schema: "mq" });
    const taskStore = new PgTaskStore(pool, LANE);
    const questionStore = new PgQuestionRepository(pool);
    const events = new PgEventQueue(pool, LANE);
    const channel = new FakeChannel();
    const messenger = new Messenger({ customers, channels: new ChannelRegistry([channel]), transcript: new PgTranscript(pool), log: silentLogger });
    const questions = new QuestionService({ questions: questionStore, tasks: taskStore, events, messenger, askCap: 3, log: silentLogger });
    const catalog = new SubagentCatalog([researcherSpec()]);
    const finds = new FindService({
      finds: new PgFindRepository(pool),
      events,
      messenger,
      poster: new FakePoster(),
      errands: new Errands(silentLogger),
      outbox: new Outbox({ store: new PgOutbox(pool, LANE), errands: new Errands(silentLogger), online: () => true, off: () => false, clock: systemClock, log: silentLogger }),
      places: new PgPlaceRepository(pool),
      cardsAtOnce: 3,
      clock: systemClock,
      log: silentLogger,
    });
    const service = new TaskService({ tasks: taskStore, questions: questionStore, answerer: questions, catalog });
    const researcher = fakeModel()
      .respondWithTools([{ name: "ask_human", args: { question: "Who buys it?", options: ["Teams", "Solo"] } }])
      .respond(new AIMessage("Report: solo founders."));
    const runner = new TaskRunner(
      { queue: taskStore, tasks: taskStore, questions, events, catalog, models: { modelFor: () => researcher }, reach: new FakeReach(new FakeReader(), new FakePostSearch()), customers, finds, places: new PgPlaceRepository(pool), memory: new PgMemoryRepository(pool), checkpointer, log: silentLogger },
      { worker: `it-${chat}`, concurrency: 1, perCustomer: 5, leaseMs: 60_000, pollMs: 10, maxAttempts: 2, modelRetryDelayMs: 1 },
    );
    const task = await service.start(c.id, "researcher", "Read", "Read it.");
    // Claims are global: settle the earlier tests' tasks so this run gets the scripted model.
    await pool.query(
      `update mq.tasks set status = 'cancelled', finished_at = now()
        where customer_id = any($1::uuid[]) and id <> $2 and status in ('queued', 'running', 'waiting')`,
      [created, task.id],
    );

    for (let i = 0; i < 20 && (await taskStore.get(task.id))?.status === "queued"; i++) await runner.runNext();
    expect((await taskStore.get(task.id))?.status).toBe("waiting");
    const [q] = await questions.open(c.id);
    await questions.ask(c.id, [q!.id]);
    expect(channel.sent.at(-1)?.question?.options).toEqual(["Teams", "Solo"]);

    await questions.choose(c.id, q!.id, 1);
    for (let i = 0; i < 20 && (await taskStore.get(task.id))?.status === "queued"; i++) await runner.runNext();

    const done = await taskStore.get(task.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.result).toBe("Report: solo founders.");
    const toolResult = researcher.calls.at(-1)!.messages.find((m) => m instanceof ToolMessage) as ToolMessage;
    expect(String(toolResult.content)).toBe("The person answered: Solo");
  });
});
