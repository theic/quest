-- Whoever asked to be left alone (the founder, 2026-11-18: "The agent must be very precise about opt outs: if someone
-- asks not to do it, don't"). Live, the same day: someone on Bluesky wrote "please don't tag me under anything using
-- generative AI", was kept as a warm conversation, and got a reply and a private message drafted after it. One row a
-- person, kept for good: nothing more is drafted or sent to them.
create table if not exists mq.said_no (
  id bigint generated always as identity primary key,
  customer_id uuid not null references mq.customers (id) on delete cascade,
  -- Where they said it, as contacts name a site: "bsky.app", "x.com".
  site text not null,
  -- Who, as the answer was read: a handle, or the name a list showed them by.
  person text not null check (length(person) <= 200),
  words text not null check (length(words) <= 500),
  url text,
  created_at timestamptz not null default now()
);
create index if not exists said_no_customer on mq.said_no (customer_id);
alter table mq.said_no disable row level security;

revoke all on mq.said_no from mq_app;
grant select, insert on mq.said_no to mq_app;

-- The answers already on record that say it.
insert into mq.said_no (customer_id, site, person, words, url, created_at)
select r.customer_id,
       regexp_replace(regexp_replace(lower(split_part(regexp_replace(r.url, '^https?://', ''), '/', 1)), '^(www|old|m|mobile)\.', ''), '^twitter\.com$', 'x.com'),
       left(r.person, 200),
       left(coalesce(substring(r.evidence from ': "(.*)"$'), r.evidence), 500),
       r.url,
       r.created_at
from mq.results r
where r.stage = 'conversation' and r.person is not null and r.url is not null
  and coalesce(substring(r.evidence from ': "(.*)"$'), '') ~* '(^|[^a-z])(don''?t|do not|stop|quit)( ever| please)? (tag|tagging|mention|mentioning|message|messaging|dm|reply|replying|contact|contacting|email|emailing|spam|spamming|bother|bothering)\M|\m(leave me (alone|out)|not interested|no,? thank(s| you)|unsubscribe|remove me|go away|get lost|f[u*]ck off|piss off|blocked|reported)\M|,\s*bot\s*[?!.]*$|\m(you''?re|you are|this is) (a )?(bot|spam|scam)\M'
  and not exists (select 1 from mq.said_no s where s.customer_id = r.customer_id and s.person = left(r.person, 200));
