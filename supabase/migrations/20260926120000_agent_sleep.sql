-- Messaging Quest v2: the agent sleeps when it has nothing to do.
--
-- The agent suspends its own Fly Machine when idle (apps/agent/src/lifecycle/
-- idle-sleeper.ts). A Telegram update wakes it through Fly's proxy. Work that
-- falls due later (a retry, a heartbeat, a lease to recover) wakes it through
-- the job below: every 30 seconds it asks when the next work is due and, if it
-- is due now, calls the agent's /wake.

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- When the earliest queued work falls due; null when there is none. The agent
-- asks the same question before it sleeps, so the two never disagree. Mirrors
-- the claims in PgEventQueue.claimCustomer, PgTaskStore.claim and
-- PgEventQueue.queueDue (heartbeats).
create or replace function mq.next_work_at(heartbeat interval)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select min(due) from (
    -- events waiting for a manager turn
    select min(e.available_at) as due from mq.events e where e.status = 'pending'
    union all
    -- events a turn took and did not finish: due when that turn's lease runs out
    select min(coalesce(c.manager_lease_until, now()))
      from mq.events e join mq.customers c on c.id = e.customer_id
     where e.status = 'processing'
    union all
    select min(t.available_at) from mq.tasks t where t.status = 'queued'
    -- a running task with nobody renewing its lease is recovered when the lease ends
    union all
    select min(t.lease_until) from mq.tasks t where t.status = 'running'
    union all
    select min(coalesce(c.last_heartbeat_at, c.created_at) + heartbeat)
      from mq.customers c
     where c.status = 'active'
       and not exists (
         select 1 from mq.events e
          where e.customer_id = c.id and e.kind = 'heartbeat' and e.status in ('pending', 'processing')
       )
  ) s
$$;

grant execute on function mq.next_work_at(interval) to mq_app;

-- Where the agent listens and how to wake it. One row. Only the functions below
-- touch it; the key is made here and never leaves the database except to the
-- agent that registers.
create table mq.wake (
  id boolean primary key default true check (id),
  url text,
  heartbeat interval,
  key text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  registered_at timestamptz
);
insert into mq.wake default values;
revoke all on mq.wake from mq_app, public, anon, authenticated;

-- The agent says where it listens and how often heartbeats fall due, and gets
-- back the key its /wake checks.
create or replace function mq.register_agent(wake_url text, heartbeat_every interval)
returns text
language sql
security definer
set search_path = ''
as $$
  update mq.wake
     set url = wake_url, heartbeat = heartbeat_every, registered_at = now()
   returning key
$$;

revoke all on function mq.register_agent(text, interval) from public, anon, authenticated;
grant execute on function mq.register_agent(text, interval) to mq_app;

-- Wakes the agent when work is due. Harmless when it is awake: /wake only nudges its loops.
create or replace function mq.wake_agent()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  w mq.wake;
  due timestamptz;
begin
  select * into w from mq.wake;
  if w.url is null or w.heartbeat is null then
    return;
  end if;
  due := mq.next_work_at(w.heartbeat);
  if due is null or due > now() then
    return;
  end if;
  perform net.http_post(
    url := w.url || '/wake',
    body := '{}'::jsonb,
    headers := jsonb_build_object('content-type', 'application/json', 'x-mq-wake', w.key),
    timeout_milliseconds := 10000
  );
end
$$;

revoke all on function mq.wake_agent() from public, anon, authenticated, mq_app;

select cron.schedule('mq-wake-agent', '30 seconds', 'select mq.wake_agent()');
