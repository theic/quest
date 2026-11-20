-- Messaging Quest v2: the earlier web app (v1) retires.
--
-- messaging.quest stopped passing requests to v1's Next.js app at the cutover (2026-10-09), and a
-- full pg_dump of production was taken first. v1's tables and functions are kept, not dropped: they
-- move from `public` (what the Supabase API serves) to `legacy`, which nothing reaches, so the old
-- app's anon key can no longer read or call any of it. What v2 owes the people v1 signed up is in
-- mq.accounts. Only where v1 ran; elsewhere this does nothing.
do $$
declare
  r record;
begin
  if to_regclass('public.profiles') is null then
    return;
  end if;

  -- v1's clocks stop: the drains that called the old app, and the old engine's tick.
  perform cron.unschedule(jobid) from cron.job
   where jobname in ('quest-review-drain', 'broadcast-drain', 'watch-drain', 'quest-clock', 'quest-clock-history', 'quest-channels');

  -- A sign-up no longer makes a v1 profile; mq_account_for_user keeps mq.accounts whole.
  drop trigger if exists on_auth_user_created on auth.users;

  create schema if not exists legacy;
  revoke all on schema legacy from public, anon, authenticated;

  -- Tables take their own sequences, indexes, policies and triggers with them.
  for r in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
       and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
  loop
    execute format('alter table public.%I set schema legacy', r.relname);
  end loop;

  for r in
    select p.oid::regprocedure as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('alter function %s set schema legacy', r.fn);
  end loop;

  revoke all on all tables in schema legacy from anon, authenticated;
  revoke all on all sequences in schema legacy from anon, authenticated;
  revoke all on all functions in schema legacy from public, anon, authenticated;
end
$$;
