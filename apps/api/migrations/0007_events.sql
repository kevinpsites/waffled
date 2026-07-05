-- Up Migration
-- Domain 2: Calendar — the events master table (see docs/DATA_MODEL.md §2). This
-- is Waffled-native part 1: single events read straight from here. The Google-sync
-- bookkeeping columns and recurrence fields are included now so M5 layers on
-- without an ALTER; the read-model (event_occurrences), overrides, and
-- participants tables come with recurrence/Google. calendar_id has no FK yet
-- (the calendars table arrives with the Google work).

create table events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  calendar_id uuid,                                  -- → calendars(id) once Google lands
  -- google-owned (inbound sync overwrites)
  title text not null,
  description text,
  location text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  all_day boolean not null default false,
  timezone text not null,
  rrule text,
  rdate timestamptz[],
  exdate timestamptz[],
  recurrence_end_at timestamptz,
  status text not null default 'confirmed',          -- confirmed | tentative | cancelled
  reminders jsonb,
  -- waffled-owned (sync never overwrites)
  person_id uuid references persons(id),             -- assignee → color
  origin text not null default 'manual',             -- manual | google | meal_plan | task | ai_capture
  origin_ref_id uuid,
  -- google sync bookkeeping
  google_event_id text,
  ical_uid text,
  etag text,
  sequence int,
  google_updated timestamptz,
  sync_state text not null default 'local_only',     -- local_only | pending_push | synced | push_failed
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index ix_events_household_start on events (household_id, starts_at) where deleted_at is null;
create unique index uq_events_google on events (calendar_id, google_event_id)
  where google_event_id is not null;
create index ix_events_recurrence on events (household_id, recurrence_end_at) where rrule is not null;

create trigger trg_events_updated before update on events
  for each row execute function set_updated_at();

-- Down Migration

drop table if exists events cascade;
