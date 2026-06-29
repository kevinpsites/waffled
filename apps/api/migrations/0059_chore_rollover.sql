-- Up Migration
-- One-off chores (rrule null) can now carry forward when missed. `rollover`
-- (default true) only means anything for one-offs: at read time the Today list +
-- per-person summary also pull a one-off's single pending instance from a past
-- day (keeping its original due_on, so the UI can show "overdue · since Mon")
-- until it's done. Recurring chores ignore the flag — they're unchanged.

alter table chores add column if not exists rollover boolean not null default true;

-- Down Migration

alter table chores drop column if exists rollover;
