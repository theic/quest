-- Messaging Quest v2, milestone 2: what the scout finds, the customer's brief,
-- and lanes that keep test rows away from the running agent.

-- Lanes. Every customer is 'live' unless a test made it. The agent claims only
-- its own lane's events and tasks, and the wake job looks only at 'live', so
-- the integration tests can run while the deployed agent does.
alter table mq.customers add column lane text not null default 'live';

-- What Quest knows about the customer's offer, in the site's own facts: who it
-- is for, what it does, what they want and do not want. The manager keeps it
-- (save_brief); every teammate reads it, and the scout writes replies from it.
alter table mq.customers add column brief text;

-- People the scout found asking, in public, for what the customer offers. The
-- customer decides on each one; Quest never posts.
--
--   new ──show──▶ shown ──▶ kept | replied
--                   └────▶ skipped (with a reason, when they give one)
create table mq.finds (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references mq.customers (id) on delete cascade,
  task_id uuid references mq.tasks (id) on delete set null,
  source text not null,
  url text not null,
  author text,
  title text,
  -- the person's own words, checked against the page the scout read
  quote text not null,
  posted_at timestamptz,
  why text not null,
  reply text not null,
  strength text not null check (strength in ('strong', 'maybe')),
  status text not null default 'new' check (status in ('new', 'shown', 'kept', 'skipped', 'replied')),
  skip_reason text check (skip_reason in ('not_my_buyer', 'off_topic', 'too_old', 'other')),
  card_ref text,
  created_at timestamptz not null default now(),
  shown_at timestamptz,
  decided_at timestamptz,
  -- one card per post per customer, ever
  unique (customer_id, url)
);
create index finds_queue on mq.finds (customer_id, status, created_at);

-- The queue clock learns lanes: only the given lane's work counts.
drop function mq.next_work_at(interval);
create function mq.next_work_at(heartbeat interval, in_lane text default 'live')
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
  ) s
$$;

grant execute on function mq.next_work_at(interval, text) to mq_app;
