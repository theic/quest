-- Invite-only (the founder, 2026-10-26: "you connect to the bot and it suggests you to ask someone else for an invite or
-- wait in the queue ... it won't do any work/onboarding before you share a valid invite or the account is activated
-- remotely"). Someone new is a customer from their first message, but nothing is done for them until activated_at is
-- set: by an invite's code (sent in the chat, or the link t.me/<bot>?start=<code>), or by hand here.
alter table mq.customers add column if not exists activated_at timestamptz;
-- The invite's code they came in with; null when let in by hand, or before invites.
alter table mq.customers add column if not exists invite text;
-- Everyone already here is in.
update mq.customers set activated_at = created_at where activated_at is null;

-- The codes the founder hands out. A new one, for one person:
--   insert into mq.invites (note) values ('Anna, early tester') returning 'https://t.me/messagingquestbot?start=' || code;
-- uses_left is how many more people it lets in (one code for a group: uses_left 20). A code is what a Telegram start
-- link can carry, and matched in any case.
create table if not exists mq.invites (
  code text primary key default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)) check (code ~ '^[A-Za-z0-9_-]{4,64}$'),
  note text,
  uses_left integer not null default 1 check (uses_left >= 0),
  created_at timestamptz not null default now()
);
create unique index if not exists invites_code_any_case on mq.invites (lower(code));
-- Like every table the agent uses in mq (closed to anon and authenticated), no row level security: Supabase's SQL
-- editor turns it on for a table it makes, and mq_app, which does not bypass it, then saw no invite at all (dev,
-- 2026-10-27).
alter table mq.invites disable row level security;

-- The agent reads a code and uses it; making invites is the founder's (the schema's default privileges would give it
-- the table in full).
revoke all on mq.invites from mq_app;
grant select on mq.invites to mq_app;
grant update (uses_left) on mq.invites to mq_app;

-- Let in by hand (activated_at set here, with no invite): a let_in event wakes the agent, which welcomes them in the
-- chat by code, with no model call (manager-turn.ts). One let in by an invite was welcomed in the chat already.
create or replace function mq.let_in()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into mq.events (customer_id, kind, payload)
  values (new.id, 'system', jsonb_build_object(
    'kind', 'system',
    'topic', 'let_in',
    'text', 'They were let in from the waitlist just now. Quest''s welcome and the choice of language went out by code; write nothing about it.'));
  return new;
end;
$$;

drop trigger if exists customers_let_in on mq.customers;
create trigger customers_let_in
  after update of activated_at on mq.customers
  for each row
  when (old.activated_at is null and new.activated_at is not null and new.invite is null)
  execute function mq.let_in();

-- Who waits, oldest first, with what they wrote. To let one in: update mq.customers set activated_at = now() where id = '<id>';
create or replace view mq.waitlist with (security_invoker = true) as
select c.id, c.display_name, c.language, c.created_at as joined,
       (select string_agg(t.body, ' | ' order by t.id) from mq.transcript t where t.customer_id = c.id and t.direction = 'in') as said
  from mq.customers c
 where c.activated_at is null and c.lane = 'live'
 order by c.created_at;
