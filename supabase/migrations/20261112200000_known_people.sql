-- Everyone Quest comes across, for any customer, kept once (the founder, 2026-11-12: "Quest must have a central
-- database, so every person it finds, from any of its users, it puts into so-called cache with public background
-- information; this way we could find a match even quicker"). Only what is public: who they are and what they build as
-- their own profile and site say, where else they can be reached, what they last said they made and what they last asked
-- for, each with the post that said it. Nothing of a customer's is here: what passed between a customer and someone
-- stays in mq.contacts. The matcher (finds/pair-finder.ts) reads the asks and the launches of the last days from it, so a
-- pair is found across runs and customers and not only inside one run's searches.
create table if not exists mq.known_people (
  -- '<site>:<handle>', the handle bare and in lower case, as mq.contacts keys them.
  key text primary key check (length(key) <= 200),
  site text not null,
  handle text not null,
  name text,
  profile_url text,
  site_url text,
  about text check (length(about) <= 1000),
  -- Where else they can be reached, as their pages say: an email, an X, LinkedIn or Telegram handle.
  reach text check (length(reach) <= 500),
  telegram boolean not null default false,
  makes text check (length(makes) <= 600),
  makes_url text,
  makes_at timestamptz,
  wants text check (length(wants) <= 600),
  wants_url text,
  wants_at timestamptz,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists known_people_makes on mq.known_people (makes_at desc) where makes_at is not null;
create index if not exists known_people_wants on mq.known_people (wants_at desc) where wants_at is not null;
-- Like every table the agent uses in mq (closed to anon and authenticated), no row level security.
alter table mq.known_people disable row level security;

revoke all on mq.known_people from mq_app;
grant select, insert, update on mq.known_people to mq_app;

-- When they were last one side of a pair handed to a run: the same two are not brought together run after run.
alter table mq.known_people add column if not exists paired_at timestamptz;
