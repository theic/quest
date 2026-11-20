-- A post on Reddit has a title and a message a subject; a like, a follow and new words for their own profile have
-- neither. The check from 2026-10-06 asked a title of every Reddit draft but a reply, so a Reddit profile change
-- failed its insert and took the manager's turn down with it (live on dev, 2026-10-17, the profile set-up after the
-- where card).
alter table mq.drafts drop constraint drafts_check;
alter table mq.drafts add constraint drafts_check check (platform <> 'reddit' or kind in ('reply', 'like', 'follow', 'profile') or title is not null);
