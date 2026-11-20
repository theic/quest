-- The progress board: one message pinned at the top of a customer's chat while their tasks run, edited as they go
-- and taken down when the work is over. Where it is pinned is kept so a restart (a deploy) edits that board rather
-- than pinning a second one, and takes down a board whose work ended while the agent was down.
create table mq.task_boards (
  customer_id uuid primary key references mq.customers (id) on delete cascade,
  channel text not null,
  address text not null,
  ref text not null,
  created_at timestamptz not null default now()
);

grant select, insert, update, delete on mq.task_boards to mq_app;
