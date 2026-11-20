-- When the page showed they had answered there themselves, so nothing went up. It keeps a next draft from going to the
-- same post (live, 2026-11-05: the poster stopped a reply to Md Sikandar, and the manager drafted it three times more).
alter table mq.drafts add column if not exists answered_at timestamptz;
