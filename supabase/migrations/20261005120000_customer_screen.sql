-- Messaging Quest v2: whether Quest shows the customer its reading window.
--
-- While the extension reads, it can send a picture of Quest's own window (never another
-- window or tab); the agent shows it as one silent message in the chat, edited in place,
-- and keeps nothing. On unless they say `/screen off`.
alter table mq.customers
  add column screen boolean not null default true;
