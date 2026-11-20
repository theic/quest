-- The people Quest gets to know for a customer, kept for good (the founder, 2026-11-04: "remembering people is the
-- most important. And get to know them slowly: connect first, warm them up, offer help or provide some feedback
-- immediately if possible"). One row per person on a site: what a check of them found (their profile and their
-- site), what they are after, what the customer could give them, what was given, and what passed, a line each. Every
-- later run, the writer and the People tab read it, so nobody is met cold twice. How close they are is not kept here:
-- it is read from what went up to them (mq.drafts) and what came back (mq.results).
create table if not exists mq.contacts (
  customer_id uuid not null references mq.customers (id) on delete cascade,
  -- '<site>:<handle>', the handle bare and in lower case: 'x.com:dana_builds'.
  key text not null check (length(key) <= 200),
  site text not null,
  handle text not null,
  name text,
  profile_url text,
  site_url text,
  about text not null check (length(about) <= 1000),
  needs text check (length(needs) <= 500),
  can_give text check (length(can_give) <= 500),
  -- What was given to them, a line each, newest last.
  given text[] not null default '{}',
  -- What passed, [{at, text}], newest last; the code keeps the last few.
  notes jsonb not null default '[]',
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (customer_id, key)
);
create index if not exists contacts_recent on mq.contacts (customer_id, updated_at desc);
-- Like every table the agent uses in mq (closed to anon and authenticated), no row level security.
alter table mq.contacts disable row level security;

revoke all on mq.contacts from mq_app;
grant select, insert, update on mq.contacts to mq_app;

-- Going alone on a platform starts with Quest's offer (the founder, 2026-11-04: "The transition to autopilot approve per
-- platform should start with the agent's suggestion"). Approvals still count to TRUST_AFTER (3); then Quest asks, and
-- only their yes (or "go ahead") lets it do that kind there by itself. A no starts the count over. Kinds that went alone
-- before this keep going.
alter table mq.trust add column if not exists granted boolean not null default false;
update mq.trust set granted = true where approved >= 3 and not ask_first;
comment on column mq.trust.granted is 'They said yes to Quest''s offer to do this kind here by itself, or "go ahead"; approvals alone only bring the offer.';

-- The teammate's run that drafted it, so an experiment counts what its run drafted: an outreach run saves no finds, and
-- its experiments read 0 of everything (live, 2026-11-04: one closed as failed with its six replies waiting on a tap).
alter table mq.drafts add column if not exists task_id uuid references mq.tasks (id) on delete set null;
create index if not exists drafts_task on mq.drafts (task_id) where task_id is not null;
