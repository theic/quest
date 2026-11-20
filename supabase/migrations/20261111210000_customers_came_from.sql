-- Where someone new came from: the platform a landing visit's utm_source named, passed to the bot as
-- ?start=from_<platform> and kept once (inbound-service.ts). Dev's database had the column already.
alter table mq.customers add column if not exists came_from text;
