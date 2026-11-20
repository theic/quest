-- Quest's switch in their chat (apps/agent/src/lifecycle/switch-board.ts): one message, pinned, that says whether Quest
-- is on and what runs now, with the button that switches it. Kept so it is redrawn in place, never sent twice.
alter table mq.customers add column if not exists switch_ref text;
