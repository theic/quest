-- A no in the shared list of people holds for good (docs/next-goal-open-source.md, "A no is the end of it"): someone
-- who told any Quest to leave them alone is taken out of mq.known_people and never let back in, whichever install sees
-- them again. Only the key ('<site>:<handle>') is kept. Found by the end-to-end checks, 2026-11-20: mq_app could not
-- delete from the list, so every /people/no failed, and a delete alone would be undone by the next sighting.
create table if not exists mq.people_no (
  key text primary key check (length(key) <= 200),
  at timestamptz not null default now()
);
alter table mq.people_no disable row level security;
revoke all on mq.people_no from mq_app;
grant select, insert on mq.people_no to mq_app;
grant delete on mq.known_people to mq_app;

-- Nobody who said no is added again: an insert of their key is skipped (an update cannot happen, their row is gone).
create or replace function mq.known_people_not_no() returns trigger language plpgsql as $f$
begin
  if exists (select 1 from mq.people_no where key = new.key) then
    return null;
  end if;
  return new;
end
$f$;
drop trigger if exists known_people_not_no on mq.known_people;
create trigger known_people_not_no before insert on mq.known_people for each row execute function mq.known_people_not_no();
