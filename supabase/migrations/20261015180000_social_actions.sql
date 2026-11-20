-- A like on a post, a follow of a person and new words on the customer's own profile are drafts too: one card
-- each, done in their Chrome on a tap, or by Quest alone once that kind on that platform has earned it (mq.trust,
-- "x.com likes"). A like and a follow put no words anywhere, so their body is empty; every other kind keeps words.
alter table mq.drafts drop constraint drafts_kind_check;
alter table mq.drafts add constraint drafts_kind_check check (kind in ('reply', 'post', 'message', 'like', 'follow', 'profile'));
alter table mq.drafts drop constraint drafts_body_check;
alter table mq.drafts add constraint drafts_body_check check (length(body) <= 10000 and (kind in ('like', 'follow') or length(body) >= 1));
