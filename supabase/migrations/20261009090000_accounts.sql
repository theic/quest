-- Messaging Quest v2: the people who signed up on the website.
--
-- v1 (the web app, July to September 2026) signed people up by email: 372 accounts by the
-- cutover. Their logins stay in auth.users. This keeps what v2 owes each of them, so nothing
-- depends on v1's own tables (moved to the `legacy` schema at the cutover):
--   email, and whether they confirmed it
--   news_opt_out: they asked for no product news, which must hold for anything we send later;
--     unsubscribe_token is the one their old emails' unsubscribe links carry
--   site_url: the site they gave v1, if any
-- An account that starts a Quest in Telegram and signs in on the web links through
-- mq.customers.user_id. Nobody is written to from here.
create table mq.accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  email_confirmed boolean not null default false,
  news_opt_out boolean not null default false,
  unsubscribe_token uuid unique,
  site_url text,
  joined_at timestamptz not null,
  source text not null check (source in ('v1', 'web'))
);

-- The agent reads an unsubscribe link's token and records the opt-out; nothing else (the
-- schema's default privileges would give it every table in full).
revoke all on mq.accounts from mq_app;
grant select on mq.accounts to mq_app;
grant update (news_opt_out) on mq.accounts to mq_app;

-- Every account is here, whoever made it: a sign-up after the cutover gets its row as it is made.
create or replace function mq.account_for_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into mq.accounts (user_id, email, email_confirmed, joined_at, source)
  values (new.id, new.email, new.email_confirmed_at is not null, new.created_at, 'web')
  on conflict (user_id) do update
    set email = excluded.email, email_confirmed = excluded.email_confirmed;
  return new;
end
$$;
revoke all on function mq.account_for_user() from public, anon, authenticated, mq_app;

create trigger mq_account_for_user
  after insert or update of email, email_confirmed_at on auth.users
  for each row execute function mq.account_for_user();

-- The accounts v1 collected, with the consent and the site it kept for each. Only where v1's
-- tables are (production before the cutover); a database without them starts empty.
do $$
begin
  if to_regclass('public.profiles') is null then
    return;
  end if;
  execute $copy$
    insert into mq.accounts (user_id, email, email_confirmed, news_opt_out, unsubscribe_token, site_url, joined_at, source)
    select u.id,
           coalesce(p.email, u.email),
           u.email_confirmed_at is not null,
           coalesce(p.broadcast_opt_out, false),
           p.broadcast_token,
           (select s.url from (
              select qp.url, qp.updated_at as at from public.quest_projects qp
               where qp.owner = u.id and nullif(qp.url, '') is not null
              union all
              select sp.kit_url, sp.updated_at from public.signal_prefs sp
               where sp.owner = u.id and nullif(sp.kit_url, '') is not null
            ) s order by s.at desc nulls last limit 1),
           coalesce(p.created_at, u.created_at),
           'v1'
      from auth.users u
      left join public.profiles p on p.id = u.id
    on conflict (user_id) do nothing
  $copy$;
end
$$;
