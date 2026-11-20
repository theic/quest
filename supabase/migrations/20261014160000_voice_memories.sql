-- A fourth kind of memory: their word on how their words sound ("short, like 'keep it up'", "never say founder"),
-- kept from their asks and their edits to cards. The writer (drafts/writer.ts) reads every one before it writes
-- anything that goes out as them; until now these sat among a hundred search lessons.
alter table mq.memories drop constraint memories_kind_check;
alter table mq.memories add constraint memories_kind_check check (kind in ('decision', 'lesson', 'fact', 'voice'));
