-- Find cards use the same durable sending boundary on every platform as drafts.
alter table mq.finds add column post_state text not null default 'open'
  check (post_state in ('open', 'posting', 'uncertain', 'posted'));
update mq.finds set post_state = 'posted' where sent_at is not null;
