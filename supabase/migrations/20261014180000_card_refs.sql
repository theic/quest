-- A card can be more than one chat message: a rewritten card comes back under the customer's note, and Edit
-- asks "what should change?" under the card. A reply to any of them is a reply to the card (draft-service.ts,
-- find-service.ts applyNote), so the older messages are kept with it.
alter table mq.drafts add column other_refs text[] not null default '{}';
alter table mq.finds add column other_refs text[] not null default '{}';
