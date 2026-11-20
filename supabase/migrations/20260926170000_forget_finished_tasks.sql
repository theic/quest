-- Messaging Quest v2: a finished task's LangGraph thread is deleted an hour after it ends.
--
-- Every step of a run writes the whole state again, pages read included, so one
-- scout or research task leaves about 5 MB of checkpoints (measured 2026-09-26:
-- 11 task threads, 54 MB; the Free plan holds 500 MB). Nothing reads a finished
-- task's thread: its report is in mq.tasks, and a finished task cannot be steered.
-- The manager's threads stay; they are its memory, and small. Threads whose task
-- or customer is gone (deleted tests, a deleted customer) are orphans and go too:
-- checkpoints have no foreign key to cascade from.

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
        or (c.thread_id like 'manager:%' and cu.id is null);
  delete from mq.checkpoint_writes w using done_threads d where w.thread_id = d.thread_id;
  delete from mq.checkpoint_blobs b using done_threads d where b.thread_id = d.thread_id;
  delete from mq.checkpoints c using done_threads d where c.thread_id = d.thread_id;
  select count(*) into forgotten from done_threads;
  return forgotten;
end
$$;

revoke all on function mq.forget_finished_tasks() from public, anon, authenticated, mq_app;

select cron.schedule('mq-forget-finished-tasks', '17 * * * *', 'select mq.forget_finished_tasks()');
