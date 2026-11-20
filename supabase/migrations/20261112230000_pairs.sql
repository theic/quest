-- Two people who need each other, kept once found (the founder, 2026-11-12: "don't stop ... until Quest will be able to
-- find a match for 100 people"). The matcher (finds/pair-finder.ts) found pairs and handed them to one run, which got
-- through one or two; the rest were lost and matched again later. Kept here, like mq.known_people for every customer and
-- only from public posts, they are a line of work: code writes the introduction to whoever can be answered where they
-- posted (finds/introducer.ts), and a run reaches the others where else they are.
create table if not exists mq.pairs (
  id bigint generated always as identity primary key,
  -- The post that asks and the post that made it: { source, url, author, title, text, postedAt }.
  ask jsonb not null,
  launch jsonb not null,
  ask_url text not null,
  launch_url text not null,
  -- '<site>:<handle>' as mq.known_people keys them; null with no author.
  ask_key text,
  launch_key text,
  why text check (length(why) <= 400),
  found_at timestamptz not null default now(),
  -- The customer whose account brought them together, and what came of it, a line.
  taken_by uuid references mq.customers (id) on delete set null,
  taken_at timestamptz,
  note text check (length(note) <= 400),
  -- When a run was handed the pair, to reach whoever cannot be answered where they posted.
  run_at timestamptz,
  unique (ask_url, launch_url)
);
create index if not exists pairs_open on mq.pairs (found_at desc) where taken_at is null;
alter table mq.pairs disable row level security;

revoke all on mq.pairs from mq_app;
grant select, insert, update on mq.pairs to mq_app;
