-- Whether Quest's tab may come to the front of their screen (the founder, 2026-10-23: "It is ok to keep raising the
-- window, but ensure it is controllable"). The switch on their page sets it; off, their Chrome works in the
-- background only (it reads what a background tab shows, and does nothing by sight). The popup has its own switch.
alter table mq.customers add column if not exists chrome_front boolean not null default true;
