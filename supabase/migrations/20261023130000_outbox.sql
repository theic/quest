-- One line for everything that goes out as the customer, from a draft or a find's card (the founder, 2026-10-23: "a
-- single common outbound queue for when chrome is inactive or something else is happening, it picks it up when it gets
-- back to work"). A row waits while their Chrome is closed and goes when it is back, under every rule that holds for a
-- post; it outlives a restart or a deploy. `updated_at` is when it was taken to be sent, for one sending or done: what
-- paces the next thing Quest sends by itself.
create table mq.outbox (
  id bigint generated always as identity primary key,
  customer_id uuid not null references mq.customers (id) on delete cascade,
  draft_id uuid references mq.drafts (id) on delete cascade,
  find_id uuid references mq.finds (id) on delete cascade,
  target text,
  site text not null,
  approved text not null check (approved in ('tap', 'trust', 'words')),
  status text not null default 'queued' check (status in ('queued', 'sending', 'done', 'dropped')),
  due_at timestamptz not null default now(),
  tries integer not null default 0,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint outbox_one_source check (num_nonnulls(draft_id, find_id) = 1)
);

-- One line at a time for a draft or a find.
create unique index outbox_draft_active on mq.outbox (draft_id) where status in ('queued', 'sending');
create unique index outbox_find_active on mq.outbox (find_id) where status in ('queued', 'sending');
create index outbox_due on mq.outbox (due_at) where status = 'queued';
create index outbox_customer on mq.outbox (customer_id, updated_at);

grant select, insert, update, delete on mq.outbox to mq_app;
