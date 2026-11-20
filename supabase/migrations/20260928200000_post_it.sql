-- One-tap "Post it": a find on a Reddit thread knows what its reply would go
-- under (the post, t3_…, or the comment whose words it quotes, t1_…). When the
-- customer taps Post it, the reply goes up from their own account in their own
-- Chrome, and the find records where it went and as whom. Quest never posts
-- without that tap.
alter table mq.finds
  add column reply_to text,
  add column sent_url text,
  add column sent_as text,
  add column sent_at timestamptz;

-- The daily limit on posts counts these.
create index finds_sent on mq.finds (customer_id, sent_at) where sent_at is not null;
