-- A promise for a time the customer asked for carries its answer: written when the turn had it, sent at
-- that time without another model call. Live on Telegram, 2026-10-08, "Ping me in 3 min with the first
-- line I should send them" was promised for 3 min, then answered and settled ten seconds later.
alter table mq.commitments add column held text check (held is null or length(held) between 1 and 4000);

-- "asked": the code heard a time in what the customer asked for ("get back to me in 5 min").
alter table mq.commitments drop constraint commitments_source_check;
alter table mq.commitments add constraint commitments_source_check check (source in ('manager', 'said', 'asked'));
