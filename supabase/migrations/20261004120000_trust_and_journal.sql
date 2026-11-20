-- Trust is earned per platform. Quest asks before its first posts on one (Post it, Edit, Skip);
-- once the customer approved a few there, it posts there by itself. A reply taken down starts
-- the count over. Private messages always wait for a tap.
create table mq.trust (
  customer_id uuid not null references mq.customers (id) on delete cascade,
  platform text not null,
  approved int not null default 0 check (approved >= 0),
  updated_at timestamptz not null default now(),
  primary key (customer_id, platform)
);

-- What went up without a tap.
alter table mq.drafts add column alone boolean not null default false;
alter table mq.finds add column sent_alone boolean not null default false;

-- Everything Quest and its team did, a line each, for the customer's own page: nothing is hidden.
create table mq.journal (
  id bigint generated always as identity primary key,
  customer_id uuid not null references mq.customers (id) on delete cascade,
  at timestamptz not null default now(),
  who text not null,
  what text not null check (length(what) <= 500)
);
create index journal_recent on mq.journal (customer_id, id desc);

grant select, insert, update, delete on mq.trust, mq.journal to mq_app;
