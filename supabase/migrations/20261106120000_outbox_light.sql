-- A like or a follow in the outbox: it keeps a shorter gap than words do, and words are paced from words.
alter table mq.outbox add column if not exists light boolean not null default false;
