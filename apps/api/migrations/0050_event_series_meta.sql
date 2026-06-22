-- Up Migration
-- Series-level Nook metadata for a GOOGLE-sourced recurring event. Google sync uses
-- singleEvents=true, so each instance arrives as its own events row, all sharing one
-- ical_uid (each with its own google_event_id). Nook-owned links (goal_id/goal_step_id)
-- set on those rows are preserved across sync, but a NEW instance streaming in later
-- has no link — so a "link the series to a goal" choice would only stick on the
-- instances that existed at link time. This per-series row (keyed by ical_uid) is the
-- durable home for that choice: linking writes it here and fans it out to every current
-- instance; sync reads it back when a fresh instance arrives so it inherits the goal.
-- Nook-only — never pushed to Google.

create table event_series_meta (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  ical_uid text not null,
  goal_id uuid references goals(id) on delete set null,
  goal_step_id uuid references goal_steps(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
-- One live meta row per (household, series). Partial so a soft-deleted row doesn't
-- block re-linking the same series later.
create unique index uq_series_meta on event_series_meta (household_id, ical_uid)
  where deleted_at is null;

create trigger trg_event_series_meta_updated before update on event_series_meta
  for each row execute function set_updated_at();

-- Down Migration

drop table if exists event_series_meta cascade;
