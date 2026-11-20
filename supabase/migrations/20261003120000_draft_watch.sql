-- Drafts that went up on the customer's tap are looked at again for answers, like a
-- find's reply: a reply's answers are the comments under it, a post's the comments on it.
-- A private message is not watched (its answers go to the customer's inbox).
alter table mq.drafts
  add column watch_next_at timestamptz,
  add column watch_checks int not null default 0,
  -- the answers already told, by Reddit's ids
  add column watch_seen text[] not null default '{}';

create index drafts_watch on mq.drafts (watch_next_at) where watch_next_at is not null;
