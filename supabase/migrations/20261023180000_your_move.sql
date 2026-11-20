-- Your move (asks/deck.ts): the one message in their chat that shows what waits on them, one ask at a time. Where it
-- is, the ask it shows and where that stood in the line, the asks it held when last drawn, and the day's notices.
alter table mq.customers add column if not exists deck jsonb;
