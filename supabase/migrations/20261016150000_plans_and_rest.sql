-- Messaging Quest v2: a day's work has a budget, and Senior buys a bigger one.
--
-- Every customer works on a plan: Intern (free, 200 credits a day) or Senior ($420 a month, 1,000 a day). A credit is
-- a cent of what their model calls cost (mq.model_calls), counted from midnight their time. When a day's credits are
-- spent, Quest rests until their next midnight (`mq.customers.rest_until`): their runs stop, and nothing of theirs is
-- claimed meanwhile but the evening report; what they send waits for the rest to end. The queue's clock
-- (`mq.next_work_at`) knows, so a sleeping agent is woken when a rest ends, not for work that has to wait.
--
-- `mq.subscriptions`: Senior as Stripe last said it is (its webhook keeps the row), one per customer. `told` is the
-- plan the customer last heard they are on, so an event Stripe delivers twice is said once.
-- `mq.offers`: what Quest offered when it ran out: Senior; the next time, a discount until `ends_at`.

alter table mq.customers add column rest_until timestamptz;

create table mq.subscriptions (
  customer_id uuid primary key references mq.customers (id) on delete cascade,
  plan text not null default 'senior',
  status text not null,
  stripe_customer text,
  stripe_subscription text unique,
  period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  told text,
  updated_at timestamptz not null default now()
);

grant select, insert, update on mq.subscriptions to mq_app;

create table mq.offers (
  id bigint generated always as identity primary key,
  customer_id uuid not null references mq.customers (id) on delete cascade,
  kind text not null check (kind in ('upgrade', 'discount')),
  percent_off int not null default 0 check (percent_off between 0 and 90),
  made_at timestamptz not null default now(),
  ends_at timestamptz,
  paid_at timestamptz
);
create index offers_customer on mq.offers (customer_id, made_at desc);

grant select, insert, update on mq.offers to mq_app;

-- The queue's clock learns rests: a resting customer's events and tasks fall due when the rest ends (their evening
-- report does not wait), and their heartbeat is not due before then either.
create or replace function mq.next_work_at(heartbeat interval, in_lane text default 'live')
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select min(due) from (
    select min(greatest(e.available_at, case when e.kind <> 'day_report' then c.rest_until end)) as due
      from mq.events e join mq.customers c on c.id = e.customer_id
     where e.status = 'pending' and c.lane = in_lane
    union all
    select min(coalesce(c.manager_lease_until, now()))
      from mq.events e join mq.customers c on c.id = e.customer_id
     where e.status = 'processing' and c.lane = in_lane
    union all
    select min(greatest(t.available_at, c.rest_until))
      from mq.tasks t join mq.customers c on c.id = t.customer_id
     where t.status = 'queued' and c.lane = in_lane
    union all
    select min(t.lease_until)
      from mq.tasks t join mq.customers c on c.id = t.customer_id
     where t.status = 'running' and c.lane = in_lane
    union all
    select min(greatest(coalesce(c.last_heartbeat_at, c.created_at) + heartbeat, c.rest_until))
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
