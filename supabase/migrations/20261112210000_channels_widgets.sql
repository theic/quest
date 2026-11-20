-- Whether a chat's app draws widgets: known once a widget of Quest's asked from it. It was kept in memory only, so
-- after every restart Your move went back to a plain message until the pinned switch was on screen again (the founder,
-- 2026-11-12: "bring back the widget cards ... right now I see the old reply keyboard").
alter table mq.channels add column if not exists widgets boolean not null default false;
grant select, update on mq.channels to mq_app;
