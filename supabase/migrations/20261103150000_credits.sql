-- Pay as you go (the founder, 2026-11-03: "we are switching back to pay as you go ... you purchase one of the credit
-- packs, the ladder goes from $20 to $420. Each pack gives you a bonus for the very first topup ... no subscriptions").
-- A customer's credits are dollars of the AI Quest uses for them: what they bought (first top-up bonus included) less
-- what their model calls cost since, drawn from mq.model_calls by the agent (billing/energy.ts), each call once.
create table if not exists mq.wallets (
  customer_id uuid primary key references mq.customers (id) on delete cascade,
  -- Dollars credited, bonuses included, and dollars drawn; what is left is paid - spent, never below zero.
  paid numeric(12, 6) not null default 0,
  spent numeric(12, 6) not null default 0,
  -- The model calls made before this were drawn (or passed over, while their own key paid).
  counted_to timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Each pack paid for, once per Stripe Checkout session (Stripe may send its event twice).
create table if not exists mq.topups (
  session text primary key,
  customer_id uuid not null references mq.customers (id) on delete cascade,
  -- Dollars paid, and the bonus that came with it (only on their very first top-up).
  paid numeric(10, 2) not null,
  bonus numeric(10, 2) not null default 0,
  at timestamptz not null default now()
);
create index if not exists topups_customer on mq.topups (customer_id);

-- Like every table the agent uses in mq (closed to anon and authenticated), no row level security.
alter table mq.wallets disable row level security;
alter table mq.topups disable row level security;

revoke all on mq.wallets from mq_app;
revoke all on mq.topups from mq_app;
grant select, insert, update on mq.wallets to mq_app;
grant select, insert on mq.topups to mq_app;

-- Someone waiting who buys credits is let in by the purchase and welcomed in the chat by code: 'pack' keeps mq.let_in quiet.
comment on column mq.customers.invite is 'The invite''s code they came in with, ''own key'' when their OpenRouter key let them in, or ''pack'' when credits they bought did; null when let in by hand, or before invites.';

-- mq.subscriptions and mq.offers (Senior, 2026-10-16) are no longer used: kept, with their rows, until they can go.
comment on table mq.subscriptions is 'Unused since 2026-11-03 (pay as you go, mq.wallets): Senior as Stripe last said it was.';
comment on table mq.offers is 'Unused since 2026-11-03 (pay as you go, mq.wallets): the Senior offers made when an Intern''s day ran out.';
