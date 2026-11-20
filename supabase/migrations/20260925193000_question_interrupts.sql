-- A task's run stops on LangGraph interrupts, one per question it asked. The
-- answer resumes that exact interrupt, so each question remembers which one.
alter table mq.questions add column interrupt_id text not null default '';
alter table mq.questions alter column interrupt_id drop default;
create unique index questions_by_interrupt on mq.questions (task_id, interrupt_id);
