-- The task queue goes by warmth, then by time (the founder, 2026-11-14: "With the order and a better management of the
-- queue"): 0 answers someone who is waiting, 1 is asked-for work and introductions, 2 is routine browsing. Before, a run
-- answering people who had written days ago waited behind whatever was queued first.
alter table mq.tasks add column if not exists priority smallint not null default 1;
create index if not exists tasks_queue_order on mq.tasks (priority, available_at) where status = 'queued';
