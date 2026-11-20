-- An explicit ask-first choice persists even after several manual approvals.
-- The approval counter still lets a platform recover from a removal where no such choice exists.
alter table mq.trust add column ask_first boolean not null default false;
