-- The cut before open source (docs/next-goal-open-source.md, phase 1): what no code reads or writes any more.

-- A newcomer's trial is now a free start on credits (conversation/way-in.ts): anyone on a trial keeps going on $1.
insert into mq.wallets (customer_id, paid) select id, 1 from mq.customers where invite = 'trial' on conflict (customer_id) do nothing;
update mq.customers set invite = 'pack' where invite = 'trial';

drop view if exists mq.waitlist;
drop function if exists mq.finish_setup cascade;

drop table if exists mq.experiments cascade;     -- folded into the daily report
drop table if exists mq.journal cascade;         -- the Log page was its only reader
drop table if exists mq.own_keys cascade;        -- their own OpenRouter key
drop table if exists mq.subscriptions cascade;   -- the Senior plan
drop table if exists mq.offers cascade;
drop table if exists mq.setup_sessions cascade;  -- v1's setup, unused
drop table if exists mq.surfaces cascade;
drop table if exists mq.platform_state cascade;
drop table if exists mq.link_codes cascade;
drop table if exists mq.web_items cascade;
drop table if exists mq.telegram_inbox cascade;

alter table mq.customers
  drop column if exists screen,      -- live screen pictures
  drop column if exists switch_ref,  -- the pinned switch
  drop column if exists quest,       -- one playbook since 2026-10-29
  drop column if exists guest,
  drop column if exists tasted_at;

-- v1's tables and functions, kept unused since the cutover (production only).
drop schema if exists legacy cascade;
