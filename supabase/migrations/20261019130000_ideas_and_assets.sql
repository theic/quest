-- The customer steers (the founder, 2026-10-19: "Even though it is full autopilot, I still want to be in charge of the
-- direction: I want to share assets and my ideas for posts, as well as hear ideas from the agent").
--
-- mq.assets: what they share for their posts. A picture, a video or a file they send in the chat is kept by its
-- Telegram file id (the bytes stay with Telegram, read again when a post needs them), with what it shows; a link
-- by its address. Dropped, never deleted.
create table mq.assets (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references mq.customers (id) on delete cascade,
  kind text not null check (kind in ('image', 'video', 'file', 'link')),
  channel text,
  file_ref text,
  mime text,
  name text,
  size integer,
  url text,
  about text not null,
  created_at timestamptz not null default now(),
  dropped_at timestamptz
);
create index assets_customer on mq.assets (customer_id, created_at desc);

-- mq.ideas: ideas for posts, theirs (to do, before Quest's own) and Quest's (a card they say yes or no to).
-- new: Quest's, waiting for their word; yes: theirs, or Quest's they said yes to; no: not this one; done: drafted.
create table mq.ideas (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references mq.customers (id) on delete cascade,
  source text not null check (source in ('customer', 'quest')),
  text text not null,
  platform text,
  assets uuid[] not null default '{}',
  status text not null default 'new' check (status in ('new', 'yes', 'no', 'done')),
  card_ref text,
  draft_id uuid references mq.drafts (id) on delete set null,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index ideas_customer on mq.ideas (customer_id, created_at desc);

-- A post goes up with the pictures it names (their assets), attached in their Chrome.
alter table mq.drafts add column if not exists assets uuid[] not null default '{}';

grant select, insert, update, delete on mq.assets, mq.ideas to mq_app;
