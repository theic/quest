-- Pictures of people's posts, each cut to the post's box, attached to the reply that lists them (the founder,
-- 2026-11-20: "each reply ... that includes the match page link must also include cropped screenshots of the posts").
-- A draft's assets name them by id, beside the pictures the customer sent (mq.assets). Kept 14 days.
create table if not exists mq.shots (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references mq.customers (id) on delete cascade,
  url text not null,
  data text not null,
  created_at timestamptz not null default now()
);
create index if not exists shots_customer on mq.shots (customer_id, created_at desc);
alter table mq.shots enable row level security;
grant select, insert, delete on mq.shots to mq_app;
