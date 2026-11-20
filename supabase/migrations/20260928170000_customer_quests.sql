-- Messaging Quest v2: what a customer is after.
--
-- A customer picks a quest when they first open the chat: work for themselves
-- (career), people for a role (recruiting), or customers for a product (founder).
-- Null until they pick. Everyone who already gave a site or has a brief came for
-- the founder quest, the only one there was.
alter table mq.customers
  add column quest text check (quest in ('career', 'recruiting', 'founder'));

update mq.customers set quest = 'founder' where site_url is not null or brief is not null;
