-- One report a day, as a page (docs/next-goal-open-source.md, phase 2): who answered, who waits, what went up and
-- where, what worked, a sample to skim, what is paused. Kept so their settings can list the past ones.
create table if not exists mq.reports (
  customer_id uuid not null references mq.customers (id) on delete cascade,
  day date not null,
  html text not null check (length(html) <= 200000),
  created_at timestamptz not null default now(),
  primary key (customer_id, day)
);
alter table mq.reports disable row level security;

revoke all on mq.reports from mq_app;
grant select, insert, update, delete on mq.reports to mq_app;
