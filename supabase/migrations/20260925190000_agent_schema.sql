-- Messaging Quest v2: the agent's own schema.
--
-- Server-only. Nothing in `mq` is exposed through the Supabase API: the Node
-- services log in as `mq_app` and talk to Postgres directly. Auth (auth.users)
-- stays Supabase's; a customer links to an account only when they sign in on
-- the web, which a Telegram-first customer may never do.

create schema if not exists mq;

-- The role the services log in as. Its password is set outside migrations
-- (scripts/db-role.ts computes a SCRAM verifier locally, so the password never
-- leaves the machine that generated it).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mq_app') then
    create role mq_app login noinherit;
  end if;
end
$$;

grant usage, create on schema mq to mq_app;

-- One person Quest works for.
create table mq.customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  display_name text,
  language text,
  site_url text,
  status text not null default 'onboarding' check (status in ('onboarding', 'active', 'paused')),
  created_at timestamptz not null default now(),
  -- At most one manager turn per customer at a time: whoever holds the lease runs it.
  manager_worker text,
  manager_lease_until timestamptz,
  last_heartbeat_at timestamptz
);

-- Where a customer can be reached. One customer, many chats (Telegram now, web later).
create table mq.channels (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references mq.customers (id) on delete cascade,
  kind text not null check (kind in ('telegram', 'web')),
  address text not null,
  user_ref text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (kind, address)
);
create index channels_by_customer on mq.channels (customer_id, last_seen_at desc);

-- The conversation as it happened, both ways.
create table mq.transcript (
  id bigint generated always as identity primary key,
  customer_id uuid not null references mq.customers (id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  channel text not null,
  ref text,
  body text not null,
  created_at timestamptz not null default now()
);
-- A channel may deliver the same message twice; it is recorded once.
create unique index transcript_incoming_once on mq.transcript (customer_id, channel, ref)
  where direction = 'in' and ref is not null;
create index transcript_recent on mq.transcript (customer_id, id desc);

-- The manager's inbox: everything that should wake it, per customer.
create table mq.events (
  id bigint generated always as identity primary key,
  customer_id uuid not null references mq.customers (id) on delete cascade,
  kind text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed')),
  attempts int not null default 0,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);
create index events_due on mq.events (customer_id, available_at) where status in ('pending', 'processing');

-- Background work: one row per subagent task. The subagent's own state (its
-- messages, its files) lives in the LangGraph checkpoint under thread `task:<id>`.
create table mq.tasks (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references mq.customers (id) on delete cascade,
  agent text not null,
  title text not null,
  instructions text not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  next_input jsonb not null default '{"kind":"start"}',
  result text,
  error text,
  attempts int not null default 0,
  cancel_requested boolean not null default false,
  interrupt_requested boolean not null default false,
  worker text,
  lease_until timestamptz,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index tasks_claimable on mq.tasks (available_at) where status in ('queued', 'running');
create index tasks_by_customer on mq.tasks (customer_id, created_at desc);

-- Questions subagents need a human to answer. The manager decides when the person is asked.
create table mq.questions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references mq.customers (id) on delete cascade,
  task_id uuid not null references mq.tasks (id) on delete cascade,
  agent text not null,
  body text not null,
  options jsonb not null default '[]',
  why text,
  status text not null default 'pending' check (status in ('pending', 'asked', 'answered', 'dismissed')),
  answer text,
  answered_by text check (answered_by in ('user', 'manager')),
  asked_ref text,
  created_at timestamptz not null default now(),
  asked_at timestamptz,
  answered_at timestamptz
);
create index questions_open on mq.questions (customer_id, created_at) where status in ('pending', 'asked');
create index questions_by_ref on mq.questions (customer_id, asked_ref) where asked_ref is not null;

grant select, insert, update, delete on all tables in schema mq to mq_app;
grant usage, select on all sequences in schema mq to mq_app;
alter default privileges in schema mq grant select, insert, update, delete on tables to mq_app;
alter default privileges in schema mq grant usage, select on sequences to mq_app;

-- Server-only: nothing in mq is reachable through the public API.
revoke all on schema mq from public, anon, authenticated;
