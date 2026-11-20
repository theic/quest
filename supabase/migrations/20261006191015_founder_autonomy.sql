-- Existing founders with a settled product brief get the same mandate as newly onboarded founders.
-- Existing platform-specific choices (including ask-first after a removal) remain authoritative.
insert into mq.trust (customer_id, platform, approved)
select id, '*', 3 from mq.customers where quest = 'founder' and brief is not null
on conflict (customer_id, platform) do nothing;
