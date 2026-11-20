-- Answers to a posted reply: after the customer taps Post it, Quest looks at the
-- thread again (an hour, six hours, a day, three days and a week after) and tells
-- them when someone answered. Each look is read in their Chrome while it is open.
alter table mq.finds
  add column watch_next_at timestamptz,
  add column watch_checks int not null default 0,
  -- the answers already told, by Reddit's ids
  add column watch_seen text[] not null default '{}';

create index finds_watch on mq.finds (watch_next_at) where watch_next_at is not null;
