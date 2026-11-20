-- Messaging Quest v2: who the customer is, from the first-day questions.
--
-- Once a customer's first work runs, Quest asks a few one-tap questions about them
-- (where their product is, who is on it, who pays, what they tried and spend; for the
-- other quests the kind of work or hire, where, how soon). Each answer is kept by
-- question key: when it was asked and on which message, then what they tapped (an
-- option's id, 'own' for their own words, 'skip') and its words:
--   {"stage": {"askedAt": "...", "ref": "812", "answeredAt": "...", "choice": "launched",
--              "answer": "Launched, nobody pays yet"}}
-- The option ids are the comparable part: what is picked to show a customer later is
-- picked by them.
alter table mq.customers
  add column profile jsonb not null default '{}'::jsonb check (jsonb_typeof(profile) = 'object');
