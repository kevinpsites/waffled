-- Up Migration
-- Recurrence read model (DATA_MODEL.md §2). The events.rrule/rdate/exdate columns
-- (0007) are the source of truth for a Nook-native recurring series; the expansion
-- worker materializes them into event_occurrences for a rolling window so clients
-- (kiosk/iOS) render plain dated rows and never run an RRULE engine. event_overrides
-- carries per-occurrence edits/cancellations (Google's originalStartTime model).
--
-- Google-sourced recurrences are NOT modeled here: Google sync expands them itself
-- (singleEvents) into individual events rows, so only Nook-native masters expand.

create table event_overrides (                       -- per-occurrence edits/cancellations
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  event_id uuid not null references events(id),
  original_start timestamptz not null,               -- which occurrence (Google originalStartTime)
  is_cancelled boolean not null default false,
  starts_at timestamptz,                             -- nullable → inherit from master
  ends_at timestamptz,
  title text,
  description text,
  location text,
  status text,
  google_event_id text,
  etag text,
  google_updated timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index uq_overrides on event_overrides (event_id, original_start)
  where deleted_at is null;

create trigger trg_event_overrides_updated before update on event_overrides
  for each row execute function set_updated_at();

create table event_occurrences (                     -- READ model; clients render these
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  event_id uuid not null references events(id),       -- the master/series
  override_id uuid references event_overrides(id),
  original_start timestamptz not null,               -- rule-generated slot; stable identity for upsert
  person_id uuid,                                    -- denormalized for filter/color
  title text,
  location text,
  starts_at timestamptz not null,                    -- effective start (override may move it)
  ends_at timestamptz,
  all_day boolean not null default false,
  starts_on date,                                    -- local day, for fast day/month bucketing
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
-- Stable per-occurrence identity so re-materialization upserts in place (keeps the
-- row id steady → PowerSync doesn't re-stream the whole series every tick).
create unique index uq_occ_slot on event_occurrences (event_id, original_start);
create index ix_occ_household_start on event_occurrences (household_id, starts_at)
  where deleted_at is null;

create trigger trg_event_occurrences_updated before update on event_occurrences
  for each row execute function set_updated_at();

-- Down Migration

drop table if exists event_occurrences cascade;
drop table if exists event_overrides cascade;
