-- Up Migration
-- Weekly Planning — the session record (docs/product/weekly-planning-plan.md).
--
-- The module is a *sequencer*, not a store: every decision its steps take lands in the
-- module that owns it, so the only thing with no other home is the session itself.
-- Parked items arrive with step 1, so the shell ships no unused schema.

create table planning_sessions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,

  -- The week being PLANNED, always a household week start — the SERVER snaps it. A client
  -- that computes its own boundary writes rows nothing will read again.
  week_start date not null,

  status text not null default 'active' check (status in ('active','completed')),

  -- A step key from the server-owned catalog, not an index: steps a household turned off
  -- are skipped over, so ordinals would drift between households.
  current_step text,

  -- Single-driver by design; this column is the seam for multi-device presence later.
  driver_person_id uuid references persons(id) on delete set null,

  started_at timestamptz not null default now(),
  completed_at timestamptz,

  -- One session per household per planned week: re-running it resumes this row rather
  -- than accumulating half-finished duplicates.
  unique (household_id, week_start)
);

create index planning_sessions_household_week_idx on planning_sessions (household_id, week_start desc);

create table planning_session_steps (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references planning_sessions(id) on delete cascade,

  -- Validated in the service against STEPS, not by a check constraint: the catalog grows
  -- one step per commit, and a new step key must not need a migration.
  step_key text not null,

  -- 'skipped' is a real answer, not a failure — the design leans on that.
  status text not null check (status in ('pending','done','skipped')),

  -- The rare crumb a step decides that no module owns. Never a copy of module data: the
  -- recap reads through to the modules, so duplicating here would let the two disagree.
  data jsonb not null default '{}'::jsonb,

  decided_at timestamptz not null default now(),

  unique (session_id, step_key)
);

-- Down Migration
drop table if exists planning_session_steps;
drop table if exists planning_sessions;
