/**
 * A fresh first run on the dev bot, as someone new: their Quest so far is set aside (switched off, and its Telegram
 * chat taken off it, kept as `<chat id>:set-aside-<time>`), so the next /start is a newcomer's. Nothing is deleted.
 * Prints the dev invite's start link: open it in Telegram, and the run goes from the invite onward.
 *
 *   node --experimental-strip-types scripts/fresh-start.ts [telegram chat id]
 *
 * Without a chat id, the dev chat seen last. Dev's database only (it stops on any other). Their Chrome pairs again in
 * the run (/connect, or the setup under Quest's first reply), since the pairing was the set-aside customer's.
 *
 * The invite is the reusable one whose note starts "dev:"; none left, the script prints the statement that makes one
 * (the agent's role may not write invites: run it with the Supabase connector).
 */
import pg from "pg";
import { checkStage, ENV_PATH, readEnvFile } from "./env-file.ts";
import { DEV } from "../apps/agent/src/environments.ts";

const env = readEnvFile();
await checkStage("dev", env, ENV_PATH);
const db = new pg.Client({ connectionString: env.get("DATABASE_URL") });
await db.connect();
try {
  const chat = process.argv[2];
  const { rows: found } = await db.query<{ customer_id: string; address: string }>(
    `select customer_id, address from mq.channels
      where kind = 'telegram' and address not like '%:set-aside%' and ($1::text is null or address = $1)
      order by last_seen_at desc nulls last limit 1`,
    [chat ?? null],
  );
  const current = found[0];
  if (current) {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    await db.query("begin");
    await db.query(`update mq.customers set off_at = coalesce(off_at, now()) where id = $1`, [current.customer_id]);
    await db.query(`update mq.channels set address = address || ':set-aside-' || $2 where customer_id = $1 and kind = 'telegram' and address = $3`, [current.customer_id, stamp, current.address]);
    await db.query("commit");
    console.log(`Set aside customer ${current.customer_id} (chat ${current.address}): switched off, its chat taken off it.`);
  } else console.log(chat ? `No dev customer on chat ${chat}: the next /start is a newcomer's already.` : "No dev customer to set aside.");

  const { rows: invites } = await db.query<{ code: string; uses_left: number }>(`select code, uses_left from mq.invites where note like 'dev:%' and uses_left > 0 order by created_at limit 1`);
  const invite = invites[0];
  if (invite) console.log(`Start as someone new (${invite.uses_left} uses left): https://t.me/${DEV.bot}?start=${invite.code}`);
  else console.log(`No dev invite left. Make one with the Supabase connector:\n  insert into mq.invites (code, note, uses_left) values ('DEVFRESH', 'dev: fresh onboarding runs', 500);`);
  console.log("A running dev agent picks the newcomer up as they write; the set-aside customer's work is off in the database.");
} finally {
  await db.end();
}
