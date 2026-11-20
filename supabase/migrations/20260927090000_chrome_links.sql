-- Messaging Quest v2: the customer's Chrome.
--
-- Quest reads and searches the web in the customer's own Chrome, through the
-- Messaging Quest extension. The customer connects it with a one-time code
-- from the chat (a link, or typed into the extension); the extension then holds
-- a token for the agent's API. Only hashes of the code and the token are kept.
--
--   offered (code, 15 min) ──redeem──▶ paired (token) ──disconnect──▶ revoked
create table mq.chrome_links (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references mq.customers (id) on delete cascade,
  code_hash text unique,
  code_expires_at timestamptz,
  token_hash text unique,
  -- "Chrome 141 on Windows": what the customer sees when asked which Chrome
  device text,
  created_at timestamptz not null default now(),
  paired_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  check ((code_hash is null) = (code_expires_at is null)),
  check (paired_at is null or token_hash is not null)
);

-- One connected Chrome per customer: two would split the work between them
-- (measured in v1, 2026-09-07, with two Chrome profiles).
create unique index chrome_links_one_active on mq.chrome_links (customer_id)
  where paired_at is not null and revoked_at is null;
create index chrome_links_by_customer on mq.chrome_links (customer_id, created_at desc);

grant select, insert, update, delete on mq.chrome_links to mq_app;
