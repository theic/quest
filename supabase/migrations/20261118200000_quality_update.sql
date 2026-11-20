-- The quality update (the founder, 2026-11-18).

-- A maker's page counts who opened it and who went on to Quest from it, so the page can be judged as a way in.
alter table mq.match_pages add column if not exists views integer not null default 0;
alter table mq.match_pages add column if not exists clicks integer not null default 0;
create or replace function public.match_page_seen(code text, what text) returns void
language sql volatile security definer set search_path = '' as $$
  update mq.match_pages p
     set views = p.views + (match_page_seen.what = 'view')::int,
         clicks = p.clicks + (match_page_seen.what = 'click')::int
   where p.code = upper(match_page_seen.code) and match_page_seen.what in ('view', 'click')
$$;
revoke all on function public.match_page_seen(text, text) from public;
grant execute on function public.match_page_seen(text, text) to anon, authenticated;

-- Their own behaviour decides what Quest does alone: whether they changed a draft's words before it went, and whether
-- the checks sent it back to the writer, are kept on the draft.
alter table mq.drafts add column if not exists edited boolean not null default false;
alter table mq.drafts add column if not exists sent_back boolean not null default false;

-- A brake: a kind of thing on a platform stopped by a bad sign (someone asked if they are a bot, a reply taken down,
-- answers dropping sharply), until it passes or they lift it.
create table if not exists mq.brakes (
  customer_id uuid not null references mq.customers (id) on delete cascade,
  platform text not null,
  kind text not null,
  reason text not null check (length(reason) <= 300),
  until timestamptz not null,
  created_at timestamptz not null default now(),
  lifted_at timestamptz,
  primary key (customer_id, platform, kind, created_at)
);
alter table mq.brakes disable row level security;
revoke all on mq.brakes from mq_app;
grant select, insert, update on mq.brakes to mq_app;

-- "Here's what I'm sending": the one message a day that lists what goes up by itself, edited in place.
alter table mq.customers add column if not exists out_list jsonb;

-- A link Quest gave someone in a thread carries a code whose note says where they met. Quest's own account runs on dev
-- and the people it meets arrive on production, which asks for the note here, by a code nobody can guess.
create or replace function public.invite_note(code text) returns text
language sql stable security definer set search_path = '' as $$
  select i.note from mq.invites i where lower(i.code) = lower(invite_note.code) and i.note is not null
$$;
revoke all on function public.invite_note(text) from public;
grant execute on function public.invite_note(text) to anon, authenticated;

-- A page made for someone who never asked to be introduced (they left a link under a thread, or said yes to a page):
-- nobody was sent their link, so the page says "found", not "got your link".
alter table mq.match_pages add column if not exists sent boolean not null default true;
create or replace function public.match_page(code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('maker', p.maker, 'made', p.made, 'launch', p.launch_url, 'people', p.people, 'at', p.created_at, 'sent', p.sent)
  from mq.match_pages p where p.code = upper(match_page.code)
$$;
