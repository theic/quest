-- Their own OpenRouter key (the founder, 2026-11-03: "the free option is immediately available if you provide your own
-- Open Router key"). Someone on the waitlist who sends one in the chat is let in at once, and every model call made for
-- them goes on it, with no day's budget from Quest. Kept sealed (AES-256-GCM, with a key made from the bot's token:
-- billing/own-keys.ts), never in the transcript; one per customer, a new one replaces the old.
create table if not exists mq.own_keys (
  customer_id uuid primary key references mq.customers (id) on delete cascade,
  sealed text not null,
  -- The key's name at OpenRouter, as its check answered.
  label text,
  added_at timestamptz not null default now(),
  -- Why calls on it are turned down ('invalid': OpenRouter refused the key; 'no_credits': its account ran dry), and
  -- since when; cleared when one goes through again, or a new key comes.
  failure text check (failure in ('invalid', 'no_credits')),
  failed_at timestamptz
);
-- Like every table the agent uses in mq (closed to anon and authenticated), no row level security.
alter table mq.own_keys disable row level security;

revoke all on mq.own_keys from mq_app;
grant select, insert, update on mq.own_keys to mq_app;

-- One let in by their key was welcomed in the chat already: their row says how they came in ('own key'), which keeps
-- mq.let_in quiet as an invite's code does.
comment on column mq.customers.invite is 'The invite''s code they came in with, or ''own key'' when their OpenRouter key let them in; null when let in by hand, or before invites.';
