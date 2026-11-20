-- The off switch (the founder, 2026-10-19: "an off switch in the main menu, so I could use my desktop without the
-- agent intervening"). `/off`, or the switch on their page, sets off_at; `/on` clears it. While it is set Quest does
-- nothing for them: the queues claim none of their work, no heartbeat or evening report is queued, and
-- mq.next_work_at() wakes nobody for them. What they write waits, pending, for `/on`.
alter table mq.customers add column if not exists off_at timestamptz;

create or replace function mq.next_work_at(heartbeat interval, in_lane text default 'live')
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select min(due) from (
    select min(greatest(e.available_at, case when e.kind <> 'day_report' then c.rest_until end)) as due
      from mq.events e join mq.customers c on c.id = e.customer_id
     where e.status = 'pending' and c.lane = in_lane and c.off_at is null
    union all
    select min(coalesce(c.manager_lease_until, now()))
      from mq.events e join mq.customers c on c.id = e.customer_id
     where e.status = 'processing' and c.lane = in_lane
    union all
    select min(greatest(t.available_at, c.rest_until))
      from mq.tasks t join mq.customers c on c.id = t.customer_id
     where t.status = 'queued' and c.lane = in_lane and c.off_at is null
    union all
    select min(t.lease_until)
      from mq.tasks t join mq.customers c on c.id = t.customer_id
     where t.status = 'running' and c.lane = in_lane
    union all
    select min(greatest(coalesce(c.last_heartbeat_at, c.created_at) + heartbeat, c.rest_until))
      from mq.customers c
     where c.status = 'active'
       and c.lane = in_lane
       and c.off_at is null
       and not exists (
         select 1 from mq.events e
          where e.customer_id = c.id and e.kind = 'heartbeat' and e.status in ('pending', 'processing')
       )
    union all
    select min(mq.next_report_at(c))
      from mq.customers c
     where c.status = 'active' and c.lane = in_lane and c.brief is not null and c.off_at is null
  ) s
$$;
