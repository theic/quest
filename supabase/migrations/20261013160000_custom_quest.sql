-- Messaging Quest v2: a quest for anything else.
--
-- Besides work (career), people for a role (recruiting) and customers for a product
-- (founder), a customer can now pick the custom quest: whatever else they want done
-- (answering comments on their Instagram, posting for them on X), in their own words.
alter table mq.customers drop constraint customers_quest_check;
alter table mq.customers
  add constraint customers_quest_check check (quest in ('career', 'recruiting', 'founder', 'custom'));
