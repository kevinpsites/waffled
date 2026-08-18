-- Up Migration
-- Rhythms — the things that should keep happening (docs/product/rhythms-plan.md).
-- Two shapes, discriminated by satisfied_by:
--   'completion' — you did the thing. Completion-anchored: next_due_at is measured from
--                  when you ACTUALLY did it, so being late shifts the next one.
--   'scheduling' — a calendar event exists for the period. We never ask whether it
--                  happened; getting the opportunity on the calendar IS the outcome.
--                  (That's the line between a rhythm and a goal.)
-- Deliberately NOT chores: no reward, no approval, no photo proof. And chores can't
-- express these schedules anyway — ensureTodayInstances handles only FREQ=DAILY and
-- FREQ=WEEKLY+BYDAY by SQL substring, with no MONTHLY and no INTERVAL.

create table rhythms (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  title text not null,
  emoji text,
  notes text,

  -- Who it's for. Null = the whole household. "My self-care day" is not "our self-care day".
  person_id uuid references persons(id) on delete set null,

  satisfied_by text not null check (satisfied_by in ('completion','scheduling')),

  -- The cadence, for both shapes. An interval so month-length arithmetic stays Postgres's
  -- problem. For 'completion' it is measured from last_completed_at; for 'scheduling' it
  -- is the width of one period.
  every interval not null,

  -- scheduling only: the anchor that makes "which period are we in?" answerable at all.
  -- Period N is [starts_on + N*every, starts_on + (N+1)*every). An rrule alone cannot
  -- define this (RFC5545 generates occurrences only relative to a DTSTART), and both the
  -- attention query and rhythm_skips need a well-defined boundary. The grid is derived
  -- from this anchor on read (generate_series stepping by `every`) rather than cached in
  -- a column — a cached "current period" would need advancing by something, and nothing
  -- here runs on a timer.
  starts_on date,

  -- scheduling only: can we pick the datetime ourselves, or must a human?
  auto_schedule boolean not null default false,
  -- Required only when auto_schedule = true: handed straight to the event we create
  -- ('FREQ=MONTHLY;BYDAY=3SA'). Deliberately NOT the source of period boundaries, so
  -- period math never needs rrule expansion in SQL.
  rrule text,

  -- The runway: how much warning you want, before the deadline in both shapes.
  --   completion → surfaces when now() >= next_due_at - lead_time
  --   scheduling → surfaces when now() >= period_end - lead_time (the booking runway).
  -- Measured from the period END, not its start: a quarterly item nagging from day one
  -- would nag for 90 days, which just trains you to ignore it.
  lead_time interval not null default '14 days',

  -- completion only. Denormalised so "what's due" is a plain index scan.
  last_completed_at timestamptz,
  next_due_at timestamptz,

  is_active boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Keeps the two shapes from bleeding into each other. A completion rhythm carrying an
  -- rrule, or a scheduling rhythm with no anchor, is nonsense the period math cannot
  -- recover from — so it never reaches the table.
  constraint rhythms_shape_is_coherent check (
    (satisfied_by = 'completion'
       and next_due_at is not null
       and starts_on is null
       and rrule is null and auto_schedule = false)
    or
    (satisfied_by = 'scheduling'
       and starts_on is not null
       and next_due_at is null and last_completed_at is null
       and (auto_schedule = false or rrule is not null))
  )
);

create index ix_rhythms_household on rhythms (household_id) where deleted_at is null;
create index ix_rhythms_due on rhythms (household_id, next_due_at)
  where deleted_at is null and is_active and satisfied_by = 'completion';

-- The back-reference. Mirrors events.goal_id (0033); an event may carry both, so a rhythm
-- and a goal can share one calendar entry without either owning it.
alter table events add column rhythm_id uuid references rhythms(id) on delete set null;
create index ix_events_rhythm on events (rhythm_id) where rhythm_id is not null;

-- The history, for completion-shape rhythms. "Filter last changed Mar 12" is the whole
-- point, and chores' completed instances don't give it cleanly.
create table rhythm_completions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  rhythm_id uuid not null references rhythms(id) on delete cascade,
  person_id uuid references persons(id) on delete set null,  -- nullable: nobody claimed it
  completed_at timestamptz not null default now(),
  notes text,
  created_at timestamptz not null default now()
);
create index ix_rhythm_completions_rhythm on rhythm_completions (rhythm_id, completed_at desc);

-- "Skip this quarter" for scheduling-shape rhythms — the only per-period state we store.
-- Without it a deliberately-skipped period nags forever. Note there is no per-period
-- SATISFACTION table: that is derived from events, since "does an event with this
-- rhythm_id fall in this period?" is idempotent by nature and a materialised copy would
-- only drift when an event is edited, moved, or deleted.
create table rhythm_skips (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  rhythm_id uuid not null references rhythms(id) on delete cascade,
  period_start date not null,
  skipped_by uuid references persons(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (rhythm_id, period_start)
);

create trigger trg_rhythms_updated before update on rhythms
  for each row execute function set_updated_at();

-- Down Migration
drop table if exists rhythm_skips cascade;
drop table if exists rhythm_completions cascade;
alter table events drop column if exists rhythm_id;
drop table if exists rhythms cascade;
