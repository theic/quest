-- Messaging Quest v2: work stays where the customer asked for it, and the team remembers which searches found people.
--
-- `mq.tasks.site`: the one site a task works on, when the customer named one ("on X" is x.com). The task's tools
-- refuse every other site (live, 2026-10-14: asked for people on X, a scout spent its run reading Reddit).
--
-- `mq.searches`: every search a run made (its words, or the search page's address when it ran in the browser), on
-- which site, and how many of the people the run saved or wrote to came from it. A task's opening lists the ones that
-- found people and the ones that found nobody, so the next run starts with what worked. Written best effort by the
-- agent (`infra/pg-searches.ts`) when a run ends; kept 90 days.

alter table mq.tasks add column site text;

create table mq.searches (
  id bigint generated always as identity primary key,
  customer_id uuid not null references mq.customers (id) on delete cascade,
  task_id uuid references mq.tasks (id) on delete set null,
  agent text not null,
  site text not null,
  query text not null,
  hits int not null default 0,
  at timestamptz not null default now()
);
create index searches_customer on mq.searches (customer_id, at desc);

grant select, insert on mq.searches to mq_app;

select cron.schedule('mq-forget-searches', '37 3 * * *', $$delete from mq.searches where at < now() - interval '90 days'$$);
