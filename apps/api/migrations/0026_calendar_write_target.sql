-- Up Migration
-- M5.4 outbound sync ("write-back"). A person may map several Google calendars,
-- but events authored in Nook must land in exactly one of them — the write target.
-- Resolution at write time prefers this flag, then the primary, then the first
-- writable calendar (see resolveWriteTarget in src/calendar-sync.ts), so most
-- households need no configuration; the flag is the override when there's a choice.

alter table calendars add column is_write_target boolean not null default false;

-- At most one write target per person within a household.
create unique index uq_calendars_write_target
  on calendars (household_id, person_id)
  where is_write_target and person_id is not null and deleted_at is null;

-- Down Migration

drop index if exists uq_calendars_write_target;
alter table calendars drop column if exists is_write_target;
