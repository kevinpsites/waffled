-- Up Migration
-- Family Night — a recurring family gathering with a small, customizable agenda of
-- "parts" (roles) that auto-rotate among members week to week (override anytime).
-- Config (parts, day-of-week, rotation order, linked calendar event) lives in
-- households.settings.familyNight; these two tables record each actual gathering
-- and who was assigned to what. See docs/DATA_MODEL.md §Family Night.

create table family_night_occurrences (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  date date not null,
  theme text,
  notes text,
  -- planned = upcoming/materialized; done = it happened; skipped = called off.
  status text not null default 'planned',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
-- One gathering per household per date.
create unique index ux_fn_occ_household_date on family_night_occurrences (household_id, date) where deleted_at is null;
create index ix_fn_occ_household on family_night_occurrences (household_id, date) where deleted_at is null;
create trigger trg_fn_occ_updated before update on family_night_occurrences for each row execute function set_updated_at();

create table family_night_assignments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  occurrence_id uuid not null references family_night_occurrences(id) on delete cascade,
  -- The part's stable slug (matches a part id in settings.familyNight.parts).
  part_id text not null,
  person_id uuid references persons(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One assignment per part within a gathering.
create unique index ux_fn_assign_occ_part on family_night_assignments (occurrence_id, part_id);
create index ix_fn_assign_household on family_night_assignments (household_id);
create trigger trg_fn_assign_updated before update on family_night_assignments for each row execute function set_updated_at();

-- Down Migration

drop table if exists family_night_assignments cascade;
drop table if exists family_night_occurrences cascade;
