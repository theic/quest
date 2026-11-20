-- When the first sweep ended: once someone new has a brief and their Chrome, Quest reads the sites where their people
-- ask, by code, in about ten minutes, and shows what it found before it asks anything more (the founder, 2026-10-23:
-- "We have to provide a real value first, making the first use of it unforgettable"). Null until then; the first-day
-- cards wait for it. Everyone who already has a brief or answered a card is past their first use: marked swept.
alter table mq.customers add column if not exists swept_at timestamptz;
update mq.customers set swept_at = coalesce(swept_at, now()) where brief is not null or profile <> '{}'::jsonb;
