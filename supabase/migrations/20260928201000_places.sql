-- Where a customer's people ask, as the explorer found it, with what each
-- place's rules say about a message like theirs:
--   search  the scout searches it first
--   avoid   its rules forbid such messages: nothing found there is saved
--   login   members only: worth joining, not searched
create table mq.places (
  customer_id uuid not null references mq.customers (id) on delete cascade,
  -- one spelling per place: "reddit:r/nocode", or a site's host
  key text not null,
  name text not null,
  url text not null,
  verdict text not null check (verdict in ('search', 'avoid', 'login')),
  rules text,
  why text not null,
  found_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (customer_id, key)
);

grant select, insert, update, delete on mq.places to mq_app;
