-- Up Migration
-- Weekly Planning · step 1 "Loose ends" — the PARKED half of the step
-- (docs/product/weekly-planning-plan.md).
--
-- Of the step's two groups only one needs a table. "Not done" is COMPUTED from the
-- modules that already own the work, so there is no copy of it here. "Parked" is what
-- somebody WROTE DOWN and exists nowhere else — no owning module, and the one group where
-- Drop destroys nothing but the note. Deliberately general: step 3 parks notes here too.

create table planning_parked_items (
  id uuid primary key default gen_random_uuid(),

  -- Household-scoped, not session-scoped (see session_id): a note outlives any session.
  household_id uuid not null references households(id) on delete cascade,

  -- Free text on purpose — the whole point of the group is that the thing has no shape
  -- yet; giving it one would push it into a module.
  note text not null,

  -- Optional tag naming the STEP THAT SHOULD ACT ON THIS NOTE — always a DESTINATION,
  -- never the step that wrote it. Both producers write the same thing, so a consumer
  -- cannot tell them apart: it answers "which step is going to look at this?".
  --
  -- Deliberately NOT a foreign key or a check constraint: the step catalog (STEPS in
  -- weeklyPlanning.ts) grows one step per commit and is validated in the service, exactly
  -- as planning_session_steps.step_key is. Null = nobody has said yet.
  step_key text,

  -- 'open' until somebody answers it in step 1. 'dropped' is a real answer, not a failure
  -- — and only ever a real answer HERE, because dropping a computed "not done" item would
  -- mean deleting another module's data.
  --
  -- A ROUTED note stays 'open': routing only says which step will look at it. That is
  -- also what makes the card's "passed over N times" line true.
  status text not null default 'open' check (status in ('open','resolved','dropped')),

  -- NULLABLE, and `on delete set null` rather than cascade: "Start this week over" discards
  -- the session record, but everything the session produced stays where it landed — the
  -- event, the chore assignment, and a note somebody wrote down. Null also covers a note
  -- parked outside any session.
  session_id uuid references planning_sessions(id) on delete set null,

  created_by uuid references persons(id) on delete set null,
  created_at timestamptz not null default now(),

  -- No `updated_at` (and so no trigger): resolved_at/resolved_by is the only history
  -- anyone reads.
  resolved_at timestamptz,
  resolved_by uuid references persons(id) on delete set null
);

-- This household's open notes, oldest first. Partial on status so the index stays the size
-- of the open set rather than of every note ever answered.
create index planning_parked_items_open_idx
  on planning_parked_items (household_id, created_at)
  where status = 'open';

-- Down Migration
drop table if exists planning_parked_items;
