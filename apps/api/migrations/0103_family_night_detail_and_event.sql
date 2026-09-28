-- Up Migration
-- Family Night, two things the weekly-planning step needs and the module never had.
--
-- 1. A part can say WHAT it is, not only who has it: `occurrences.notes` is one note for
--    the whole gathering, so three parts sharing it means three answers in one field.
-- 2. This week's gathering can point at an existing calendar event. `settings.familyNight
--    .eventId` is the standing recurring series for all weeks; the per-week answer belongs
--    on the occurrence, for the same reason a pinned person does.
--
-- `on delete set null`, not cascade: deleting the calendar event must not delete the
-- gathering or its assignments.

alter table family_night_assignments
  add column detail text,
  -- Whether anybody has stated WHO has this part. `person_id IS NULL` already means
  -- "explicitly nobody yet" (a pin taken back off), which the module keeps distinct from
  -- snapping back to the rotation's guess — so it cannot also mean "unset". Defaults TRUE
  -- because every existing row was created by a person write and must still read as pinned.
  add column person_set boolean not null default true;

comment on column family_night_assignments.detail is
  'What this part IS this week ("the good ice cream", "charades"), free text, alongside person_id which says who has it. Null = nobody has said; the API clears it with an empty string, since a null on the way in means "leave it alone".';

comment on column family_night_assignments.person_set is
  'False = this row holds only a detail and WHO still comes from the rotation. Needed because person_id IS NULL already means "pinned to nobody".';

alter table family_night_occurrences
  add column event_id uuid references events(id) on delete set null;

comment on column family_night_occurrences.event_id is
  'The calendar event for THIS dated gathering — created for it, or an event that already existed and was adopted. Distinct from settings.familyNight.eventId, which is the standing recurring series. Null = this week is not on the calendar.';

-- Finding the gathering that adopted a given event. Partial: almost every row is null.
create index ix_fn_occ_event on family_night_occurrences (event_id) where event_id is not null and deleted_at is null;

-- Down Migration

drop index if exists ix_fn_occ_event;
alter table family_night_occurrences drop column if exists event_id;
alter table family_night_assignments
  drop column if exists person_set,
  drop column if exists detail;
