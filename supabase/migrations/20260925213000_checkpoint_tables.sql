-- LangGraph's Postgres checkpointer tables, created here rather than by its
-- setup(): setup() starts with CREATE SCHEMA IF NOT EXISTS, which needs CREATE on
-- the whole database, and mq_app deliberately does not have it. These mirror
-- @langchain/langgraph-checkpoint-postgres 1.0.5 migrations 0-4; a library upgrade
-- that adds a migration needs a matching migration here (see FACTS.md).
create table if not exists mq.checkpoint_migrations (
  v integer primary key
);

create table if not exists mq.checkpoints (
  thread_id text not null,
  checkpoint_ns text not null default '',
  checkpoint_id text not null,
  parent_checkpoint_id text,
  type text,
  checkpoint jsonb not null,
  metadata jsonb not null default '{}',
  primary key (thread_id, checkpoint_ns, checkpoint_id)
);

create table if not exists mq.checkpoint_blobs (
  thread_id text not null,
  checkpoint_ns text not null default '',
  channel text not null,
  version text not null,
  type text not null,
  blob bytea,
  primary key (thread_id, checkpoint_ns, channel, version)
);

create table if not exists mq.checkpoint_writes (
  thread_id text not null,
  checkpoint_ns text not null default '',
  checkpoint_id text not null,
  task_id text not null,
  idx integer not null,
  channel text not null,
  type text,
  blob bytea not null,
  primary key (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

insert into mq.checkpoint_migrations (v) values (0), (1), (2), (3), (4) on conflict do nothing;

grant select, insert, update, delete on mq.checkpoint_migrations, mq.checkpoints, mq.checkpoint_blobs, mq.checkpoint_writes to mq_app;
