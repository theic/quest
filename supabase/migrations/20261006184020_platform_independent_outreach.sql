-- Any browser-accessible destination; no supported-platform enum. The mq schema stays private.
alter table mq.drafts drop constraint drafts_platform_check;
alter table mq.drafts add constraint drafts_platform_check check (length(platform) between 1 and 253);
alter table mq.drafts drop constraint drafts_status_check;
alter table mq.drafts add constraint drafts_status_check check (status in ('open', 'posting', 'uncertain', 'posted', 'skipped'));
-- Web messengers and many forums have no subject/title. Keep Reddit's existing requirements.
alter table mq.drafts drop constraint drafts_check;
alter table mq.drafts add constraint drafts_check check (platform <> 'reddit' or kind = 'reply' or title is not null);
-- Durable posting/uncertain states prevent retries after a lost send acknowledgement.
create index drafts_held on mq.drafts (customer_id, decided_at) where status in ('posting', 'uncertain');
