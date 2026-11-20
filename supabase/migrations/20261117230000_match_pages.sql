-- The page a maker gets once they said yes to being introduced (the founder, 2026-11-17: "generate a very simple web page
-- where you can see the list of people reached to and share it with the person. This way we don't have to mention
-- messaging quest, because there will be a branded link on the page"). One row a yes: who made what, and everyone their
-- link went to, each with their post and a few of their words. Only what is public already.
create table if not exists mq.match_pages (
  code text primary key check (code ~ '^[A-F0-9]{10}$'),
  customer_id uuid not null references mq.customers (id) on delete cascade,
  maker text not null check (length(maker) <= 120),
  made text check (length(made) <= 300),
  launch_url text not null,
  -- [{ author, quote, url }]
  people jsonb not null default '[]',
  created_at timestamptz not null default now()
);
alter table mq.match_pages disable row level security;

revoke all on mq.match_pages from mq_app;
grant select, insert on mq.match_pages to mq_app;

-- The page is a static file on messaging.quest; it reads its one row through the Data API, by a code nobody can guess.
-- The table stays closed to anon: this function gives one page and nothing else.
create or replace function public.match_page(code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('maker', p.maker, 'made', p.made, 'launch', p.launch_url, 'people', p.people, 'at', p.created_at)
  from mq.match_pages p where p.code = upper(match_page.code)
$$;
revoke all on function public.match_page(text) from public;
grant execute on function public.match_page(text) to anon, authenticated;
