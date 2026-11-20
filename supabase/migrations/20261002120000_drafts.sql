-- Drafts: what Quest writes for the customer to post as themselves, each on a card
-- with a Post button. A reply under someone's post or comment (with a short quote of
-- what they said), a new post in a community, or a private message to a person. It
-- goes up only on their tap, from their own account, in their own Chrome.
create table mq.drafts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references mq.customers (id) on delete cascade,
  kind text not null check (kind in ('reply', 'post', 'message')),
  platform text not null check (platform in ('reddit')),
  -- the page it belongs to: what a reply answers, the community, the person's post
  url text not null,
  -- where it goes: "t3_…"/"t1_…" for a reply, the community for a post, the person for a message
  target text not null,
  -- a post's title, or a message's subject
  title text,
  author text,
  -- their words, checked against what Quest had read when it wrote the draft
  quote text,
  body text not null check (length(body) between 1 and 10000),
  status text not null default 'open' check (status in ('open', 'posted', 'skipped')),
  card_ref text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  sent_url text,
  sent_as text,
  sent_at timestamptz,
  -- a post has a title and a message a subject; a reply answers words Quest read
  check (kind = 'reply' or title is not null),
  check (kind <> 'reply' or quote is not null)
);
create index drafts_latest on mq.drafts (customer_id, created_at desc);
-- The daily limit on posts counts these with the finds posted.
create index drafts_sent on mq.drafts (customer_id, sent_at) where sent_at is not null;

grant select, insert, update, delete on mq.drafts to mq_app;
