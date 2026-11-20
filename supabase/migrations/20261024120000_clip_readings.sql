-- What Quest made of a video they gave it (the founder, 2026-10-24: "The bot must be able to process any video I send
-- below one GB"). A video larger than Telegram lets a bot take (20 MB) comes from the upload button on their page and
-- is kept on the agent's own disk (channel 'upload', file_ref the upload's name there); either way, once it is read,
-- what it says (each word with its time), where it goes quiet and what the sampled frames show is kept here, so the
-- manager can plan an edit from the words and the edit can cut and caption by them.
alter table mq.assets add column if not exists reading jsonb;
