-- Messaging Quest v2: Quest keeps time, owns its results, and changes course on its own.
--
-- The Telegram test of 2026-10-07 showed what was missing: Quest reported communities found and
-- replies posted when both replies had been taken down, kept proposing searches its own notes called
-- exhausted, and, asked to come back with a shortlist in two minutes, sent it in 13 seconds and said
-- it could not schedule anything. Four records fix that:
--   mq.commitments  what Quest owes, with a time on it, and the wake that holds it to that time
--   mq.results      what the work came to: conversations, trials, active users, paying customers
--   mq.routes       the ways Quest goes after results, and whether each still works
--   mq.transcript.reaction  the one emoji Quest put on a message of theirs, instead of a reply

-- A reaction Quest put on one of their messages (Telegram's setMessageReaction): one at most.
alter table mq.transcript add column reaction text check (reaction is null or length(reaction) between 1 and 16);

-- What Quest owes: a promise to the customer ("give me 5 min"), or the next step in a conversation
-- with someone it found. Each one has a pending `commitment_due` event in mq.events at `check_at`,
-- which mq.next_work_at already counts, so a sleeping agent is woken for it. Settled, never deleted.
create table mq.commitments (
  id bigint generated always as identity primary key,
  customer_id uuid not null references mq.customers (id) on delete cascade,
  kind text not null check (kind in ('promise', 'next_step')),
  what text not null check (length(what) between 3 and 500),
  words text check (words is null or length(words) <= 200),
  person text check (person is null or length(person) <= 200),
  url text check (url is null or length(url) <= 2000),
  task_id uuid references mq.tasks (id) on delete set null,
  due_at timestamptz not null,
  check_at timestamptz not null,
  on_time boolean not null default false,
  source text not null check (source in ('manager', 'said')),
  status text not null default 'open' check (status in ('open', 'kept', 'dropped')),
  moves int not null default 0,
  note text check (note is null or length(note) <= 500),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  check ((status = 'open') = (closed_at is null))
);
create index commitments_open on mq.commitments (customer_id, due_at) where status = 'open';
create index commitments_settled on mq.commitments (customer_id, closed_at desc) where status <> 'open';

-- What the work came to. A person at a stage, with what shows it; or a count (person null) as the
-- customer or a source gave it, where 0 is a real zero. A stage with neither is unknown.
create table mq.results (
  id bigint generated always as identity primary key,
  customer_id uuid not null references mq.customers (id) on delete cascade,
  stage text not null check (stage in ('conversation', 'trial', 'active', 'paying')),
  person text check (person is null or length(person) between 1 and 200),
  count int not null default 1 check (count >= 0),
  url text check (url is null or length(url) <= 2000),
  evidence text not null check (length(evidence) between 3 and 500),
  source text not null check (source in ('seen', 'told', 'system')),
  created_at timestamptz not null default now(),
  check (person is null or count = 1)
);
create unique index results_once on mq.results (customer_id, stage, lower(person)) where person is not null;
create index results_recent on mq.results (customer_id, created_at desc);

-- The ways Quest goes after results. `key` is the name with case and spacing aside (routes.ts routeKey);
-- `misses` counts tries in a row that did not work, and two make a route spent.
create table mq.routes (
  id bigint generated always as identity primary key,
  customer_id uuid not null references mq.customers (id) on delete cascade,
  key text not null,
  name text not null check (length(name) between 3 and 120),
  status text not null default 'trying' check (status in ('trying', 'working', 'spent')),
  tries int not null default 0,
  wins int not null default 0,
  misses int not null default 0,
  last_note text check (last_note is null or length(last_note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id, key)
);

-- The route an experiment tries: closing it logs the try on that route.
alter table mq.experiments add column route text check (route is null or length(route) between 3 and 120);

grant select, insert, update, delete on mq.commitments, mq.results, mq.routes to mq_app;
grant usage, select on all sequences in schema mq to mq_app;

-- What Reddit already did with each customer's posts, as the posting route the code now keeps:
-- every reply or post taken down is a miss, every one answered a win, and the misses since the
-- last win decide whether the route is spent.
with watch as (
  select customer_id, payload->>'topic' as topic, created_at
    from mq.events
   where kind = 'system' and payload->>'topic' in ('answers', 'removed')
),
tally as (
  select w.customer_id,
         count(*)::int as tries,
         count(*) filter (where w.topic = 'answers')::int as wins,
         count(*) filter (
           where w.topic = 'removed'
             and w.created_at > coalesce((select max(a.created_at) from watch a where a.customer_id = w.customer_id and a.topic = 'answers'), '-infinity')
         )::int as misses,
         max(w.created_at) as last_at
    from watch w
   group by w.customer_id
)
insert into mq.routes (customer_id, key, name, status, tries, wins, misses, last_note, updated_at)
select customer_id, 'reddit posts and replies', 'Reddit posts and replies',
       case when misses >= 2 then 'spent' when wins > 0 and misses = 0 then 'working' else 'trying' end,
       tries, wins, misses,
       format('%s taken down, %s answered, from the reply watch before routes were kept', tries - wins, wins),
       last_at
  from tally
on conflict (customer_id, key) do nothing;
