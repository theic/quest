// The end-to-end checks' "brakes and a no" and "the model limit", fed by script (docs/next-goal-open-source.md):
// a fresh local database (PGlite, every migration), one customer, and the real classes the agent wires in main.ts.
// Prints each check and what it saw; nothing leaves this computer.
//   node --experimental-strip-types scripts/try-brakes.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomerId } from "@mq/core";
import { startLocalDb } from "../apps/agent/src/infra/local-db.ts";
import { createPool } from "../apps/agent/src/infra/db.ts";
import { asksBot, Brakes } from "../apps/agent/src/drafts/brakes.ts";
import { Autopilot } from "../apps/agent/src/drafts/autopilot.ts";
import { PgTrustRepository } from "../apps/agent/src/infra/pg-trust.ts";
import { SaidNo, saysNo } from "../apps/agent/src/contacts/said-no.ts";
import { PgSaidNo } from "../apps/agent/src/infra/pg-said-no.ts";
import { PgKnownPeople } from "../apps/agent/src/infra/pg-known.ts";
import { peopleRoutes } from "../apps/agent/src/http/people-routes.ts";
import { ModelRest, limitError } from "../apps/agent/src/lib/model-rest.ts";
import { passedOver } from "../apps/agent/src/tasks/rotation.ts";
import { PLATFORMS } from "../apps/agent/src/platforms.ts";
import { contactSite } from "../apps/agent/src/contacts/handles.ts";

const dir = mkdtempSync(join(tmpdir(), "quest-brakes-"));
const db = await startLocalDb({ dataDir: join(dir, "db"), migrations: join(import.meta.dirname, "..", "supabase", "migrations"), port: 8899 });
const pool = createPool(db.url, 1);
const log = { info() {}, warn() {}, error() {}, debug() {} } as never;
const clock = { now: () => new Date() };
let failed = 0;
const check = (name: string, ok: boolean, saw: string): void => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${saw}`);
};

try {
  const { rows } = await pool.query<{ id: string }>(`insert into mq.customers default values returning id`);
  const id = rows[0]!.id as CustomerId;
  const told: string[] = [];
  const brakes = new Brakes({ db: pool, say: async (_c, text) => void told.push(text), clock, log });
  const autopilot = new Autopilot({ trust: new PgTrustRepository(pool), messenger: { say: async () => undefined } as never, clock, brakes });

  // 1. "Are you a bot?" under a reply: replies there pause for a day, and they hear it once.
  const answer = "lol are you a bot?";
  if (asksBot(answer)) await brakes.pull(id, "bsky.app", "reply", `someone asked if this is a bot ("${answer}")`);
  check("a bot question pauses that platform", Boolean(autopilot.braked(id, "bsky.app", "reply")) && !(await autopilot.alone(id, "bsky.app")), `braked=${Boolean(brakes.on(id, "bsky.app", "reply"))}, told: ${told.at(-1)?.slice(0, 70)}`);
  check("only that platform", !autopilot.braked(id, "x.com", "reply"), "x.com replies not braked");

  // 2. A reply taken down: back to asking there, and replies pause.
  await autopilot.removed(id, "linkedin.com");
  check("a reply taken down pauses that platform", Boolean(brakes.on(id, "linkedin.com", "reply")), `told: ${told.at(-1)?.slice(0, 70)}`);

  // 3. Answers dropping: 30 replies on X a week ago with 12 answers, 30 in the last 3 days with 1.
  for (let i = 0; i < 60; i++) {
    const old = i < 30;
    await pool.query(
      `insert into mq.drafts (customer_id, kind, platform, url, target, quote, body, status, sent_at, created_at)
       values ($1, 'reply', 'x.com', $2, $3, 'shipped it today', 'nice one', 'posted', now() - make_interval(days => $4), now() - make_interval(days => $4))`,
      [id, `https://x.com/p${i}/status/${1000 + i}`, `p${i}`, old ? 6 : 1],
    );
    if ((old && i < 12) || i === 30) await pool.query(`insert into mq.results (customer_id, stage, person, url, evidence, source, created_at) values ($1, 'conversation', $2, $3, 'they answered', 'system', now() - make_interval(days => $4))`, [id, `p${i}`, `https://x.com/p${i}/status/${2000 + i}`, old ? 6 : 1]);
  }
  await brakes.checkRates(id);
  check("answers dropping pause that platform", Boolean(brakes.on(id, "x.com", "reply")), `told: ${told.at(-1)?.slice(0, 90)}`);
  const kept = await pool.query(`select count(*)::int n from mq.brakes where customer_id = $1 and lifted_at is null`, [id]);
  check("brakes kept in the database", kept.rows[0].n === 3, `${kept.rows[0].n} rows`);
  const again = new Brakes({ db: pool, say: async () => undefined, clock, log });
  await again.load();
  check("brakes hold after a restart", again.list(id).length === 3, `${again.list(id).length} after load`);
  await brakes.lift(id, "x.com");
  check("their go-ahead lifts one platform", !brakes.on(id, "x.com", "reply") && Boolean(brakes.on(id, "bsky.app", "reply")), "x.com lifted, bsky.app still paused");

  // 4. A no: nothing again here, and out of the shared list for every install.
  const no = "please don't tag me in anything, not interested";
  const saidNo = new SaidNo(new PgSaidNo(pool));
  if (saysNo(no)) await saidNo.note(id, "https://bsky.app/profile/quiet.bsky.social/post/3abc", "quiet.bsky.social", no);
  const fresh = new SaidNo(new PgSaidNo(pool));
  check("a no is kept for that person", Boolean(await fresh.who(id, "https://bsky.app/profile/quiet.bsky.social/post/9xyz", [])), "found on another post of theirs, after a restart");
  check("a tag of them under someone else's post is refused", Boolean(await fresh.tagged(id, "@quiet.bsky.social you should see this")), "tagged");
  check("someone else is not caught", !(await fresh.who(id, "https://bsky.app/profile/loud.bsky.social/post/1", [])), "loud.bsky.social free");

  const known = new PgKnownPeople(pool);
  const post = { side: "launch" as const, source: "bluesky", url: "https://bsky.app/profile/quiet.bsky.social/post/3abc", author: "quiet.bsky.social", title: null, text: "shipped my habit tracker", postedAt: new Date(), replies: 0 };
  await known.saw([post]);
  const people = peopleRoutes({ known, log });
  const res = await people.request("/people/no", { method: "POST", headers: { "content-type": "application/json", "x-quest-install": "script-install-key-0001", "fly-client-ip": "9.9.9.9" }, body: JSON.stringify({ site: contactSite(post.url), handle: "quiet.bsky.social" }) });
  await known.saw([{ ...post, url: "https://bsky.app/profile/quiet.bsky.social/post/4def", text: "v2 of my habit tracker" }]);
  const left = await pool.query(`select count(*)::int n from mq.known_people where handle ilike '%quiet%'`);
  check("a no leaves the shared list and stays out", res.status === 200 && left.rows[0].n === 0, `/people/no ${res.status}, rows after a new sighting: ${left.rows[0].n}`);

  // 5. The model limit: a rest until the time it names, and no site rested for it.
  const rest = new ModelRest();
  const until = new Date(Date.now() + 40 * 60_000).toISOString();
  rest.heard(limitError(until));
  check("the limit is a rest until its time", rest.until()?.toISOString() === until, `resting until ${rest.until()?.toISOString().slice(11, 16)} UTC`);
  const x = PLATFORMS.find((p) => p.key === "x")!;
  const ago = (min: number) => new Date(Date.now() - min * 60_000);
  const run = (n: number) => ({ id: `t${n}`, site: "x.com", status: "failed", error: limitError(until).message, result: null, createdAt: ago(60 + n), finishedAt: ago(40 + n) });
  const why = passedOver(x, { tasks: [run(1), run(2), run(3)] as never, drafts: [], avoided: new Set(), now: new Date() });
  check("runs the limit ended do not rest the site", why === null, `passedOver: ${why ?? "nothing, a run may start"}`);
  const real = passedOver(x, { tasks: [run(1), run(2)].map((t) => ({ ...t, error: "page did not load" })) as never, drafts: [], avoided: new Set(), now: new Date() });
  check("two real failures still do", real === "its last two runs failed", `passedOver: ${real}`);
} finally {
  await pool.end();
  await db.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : "all held");
process.exit(failed ? 1 : 0);
