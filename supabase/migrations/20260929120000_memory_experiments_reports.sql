-- Messaging Quest v2: what Quest keeps for good, the experiment it runs each day,
-- and the report it sends every evening.
--
-- The manager used to carry its memory in its LangGraph thread: every turn sent the
-- whole conversation again (160 KB of messages by the second day, measured 2026-09-29),
-- and its notes file lived inside that thread's state, where a summary could drop it.
-- Now every turn starts fresh from the database: the plan, what Quest keeps for good,
-- the chat's last messages, the experiments and the board. The old manager threads go.

-- The customer's day: where they are, when their report goes out, and the last one sent.
-- A time zone Postgres does not know would break every query that reads the local time,
-- so the column only takes names it knows.
create or replace function mq.known_timezone(tz text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from pg_catalog.pg_timezone_names where name = tz)
$$;

alter table mq.customers
  add column plan text,
  add column timezone text check (timezone is null or mq.known_timezone(timezone)),
  add column report_hour int not null default 20 check (report_hour between 0 and 23),
  add column last_report_on date;

-- What Quest keeps for good, whatever happens to the chat:
--   decision  what the customer decided, wants or does not want
--   lesson    what went wrong or worked, and what to do differently
--   fact      about them, beyond the brief (where they are, their constraints)
-- A memory is retired, never deleted, when it stops being true.
create table mq.memories (
  id bigint generated always as identity primary key,
  customer_id uuid not null references mq.customers (id) on delete cascade,
  kind text not null check (kind in ('decision', 'lesson', 'fact')),
  body text not null check (length(body) between 3 and 500),
  source text not null check (source in ('manager', 'system')),
  created_at timestamptz not null default now(),
  retired_at timestamptz
);
create index memories_live on mq.memories (customer_id, created_at desc) where retired_at is null;
create unique index memories_once on mq.memories (customer_id, lower(body)) where retired_at is null;

-- One change tried on purpose, with the run that tries it and how it is judged.
-- Its numbers come from the finds that run saved; the verdict is Quest's, when they are in.
create table mq.experiments (
  id bigint generated always as identity primary key,
  customer_id uuid not null references mq.customers (id) on delete cascade,
  task_id uuid references mq.tasks (id) on delete set null,
  hypothesis text not null,
  change text not null,
  measure text not null,
  status text not null default 'running' check (status in ('running', 'closed')),
  verdict text check (verdict in ('worked', 'failed', 'unclear')),
  result text,
  started_at timestamptz not null default now(),
  closed_at timestamptz,
  check ((status = 'closed') = (verdict is not null))
);
create index experiments_recent on mq.experiments (customer_id, started_at desc);

grant select, insert, update, delete on mq.memories, mq.experiments to mq_app;
grant usage, select on all sequences in schema mq to mq_app;
grant execute on function mq.known_timezone(text) to mq_app;

-- When a customer's next evening report falls due: their report hour on the day after
-- the last one, in their time zone (UTC until Quest knows it). Never within six hours of
-- their first message, so nobody gets a report from a Quest they met an hour ago.
create or replace function mq.next_report_at(c mq.customers)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select greatest(
    (coalesce(c.last_report_on + 1, (now() at time zone coalesce(c.timezone, 'UTC'))::date)::timestamp
      + make_interval(hours => c.report_hour)) at time zone coalesce(c.timezone, 'UTC'),
    c.created_at + interval '6 hours'
  )
$$;

grant execute on function mq.next_report_at(mq.customers) to mq_app;

-- The queue clock learns reports: a sleeping agent is woken for one like for a heartbeat.
create or replace function mq.next_work_at(heartbeat interval, in_lane text default 'live')
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select min(due) from (
    select min(e.available_at) as due
      from mq.events e join mq.customers c on c.id = e.customer_id
     where e.status = 'pending' and c.lane = in_lane
    union all
    select min(coalesce(c.manager_lease_until, now()))
      from mq.events e join mq.customers c on c.id = e.customer_id
     where e.status = 'processing' and c.lane = in_lane
    union all
    select min(t.available_at)
      from mq.tasks t join mq.customers c on c.id = t.customer_id
     where t.status = 'queued' and c.lane = in_lane
    union all
    select min(t.lease_until)
      from mq.tasks t join mq.customers c on c.id = t.customer_id
     where t.status = 'running' and c.lane = in_lane
    union all
    select min(coalesce(c.last_heartbeat_at, c.created_at) + heartbeat)
      from mq.customers c
     where c.status = 'active'
       and c.lane = in_lane
       and not exists (
         select 1 from mq.events e
          where e.customer_id = c.id and e.kind = 'heartbeat' and e.status in ('pending', 'processing')
       )
    union all
    select min(mq.next_report_at(c))
      from mq.customers c
     where c.status = 'active' and c.lane = in_lane and c.brief is not null
  ) s
$$;

-- The manager's threads are no longer its memory: each turn runs on a thread of its own
-- that is never saved. What the old ones held is gone with them; the brief, the places,
-- the finds and the transcript stay.
delete from mq.checkpoint_writes where thread_id like 'manager:%';
delete from mq.checkpoint_blobs where thread_id like 'manager:%';
delete from mq.checkpoints where thread_id like 'manager:%';
