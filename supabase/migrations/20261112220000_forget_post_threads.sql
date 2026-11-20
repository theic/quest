-- A post's LangGraph thread ('publish:<session>', the poster's run) was never deleted: nothing reads it once the post
-- ended, and on dev 316 of them held most of 450 MB (measured 2026-11-12; the Free plan holds 500 MB). They go an hour
-- after their last step, with finished tasks' threads. pg_cron's own log of runs (the wake job runs every 30 s:
-- 137,000 rows) is kept a day.

create or replace function mq.forget_finished_tasks()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  forgotten integer;
begin
  create temporary table done_threads on commit drop as
    select distinct c.thread_id
      from mq.checkpoints c
      left join mq.tasks t on c.thread_id = 'task:' || t.id
      left join mq.customers cu on c.thread_id = 'manager:' || cu.id
     where (c.thread_id like 'task:%'
            and (t.id is null
                 or (t.status in ('succeeded', 'failed', 'cancelled')
                     and coalesce(t.finished_at, t.updated_at) < now() - interval '1 hour')))
        or (c.thread_id like 'manager:%' and cu.id is null)
        or (c.thread_id like 'publish:%'
            and not exists (select 1 from mq.checkpoints n
                             where n.thread_id = c.thread_id
                               and (n.checkpoint ->> 'ts')::timestamptz > now() - interval '1 hour'));
  delete from mq.checkpoint_writes w using done_threads d where w.thread_id = d.thread_id;
  delete from mq.checkpoint_blobs b using done_threads d where b.thread_id = d.thread_id;
  delete from mq.checkpoints c using done_threads d where c.thread_id = d.thread_id;
  select count(*) into forgotten from done_threads;
  return forgotten;
end
$$;

revoke all on function mq.forget_finished_tasks() from public, anon, authenticated, mq_app;

select cron.schedule('mq-forget-cron-runs', '47 3 * * *', $$delete from cron.job_run_details where end_time < now() - interval '1 day'$$);
