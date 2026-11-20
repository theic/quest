-- The onboarding starts in the thread (the founder, 2026-11-15: "The onboarding starts even before you get the link or
-- installed the extension: in a public thread or DM"). On Quest's own account, a link to messaging.quest in a reply or a
-- message gets a code of its own, which keeps where Quest met them (drafts/draft-service.ts, hand-off): the agent makes
-- that one invite, a use, with its note. Making any other invite stays the founder's.
grant insert (note, uses_left) on mq.invites to mq_app;
