-- Up Migration
-- Weekly Planning · step 6 "Goals" — a target for ONE WEEK of a goal
-- (docs/product/weekly-planning-plan.md).
--
-- "750 hours this year, and 10 of them this week." The goal keeps its own target; a row
-- here is one week's slice of it, set during a planning session and read back in the next
-- week's recap. Progress against it is never stored: it is summed from goal_logs whose
-- household-local day falls inside the week.
--
-- `week_start` is always a session's snapped week start, taken from planning_sessions —
-- never computed here, so it follows the household's week_start rule and not Postgres's
-- Monday.

create table planning_goal_week_targets (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  goal_id uuid not null references goals(id) on delete cascade,
  week_start date not null,
  target numeric not null check (target > 0),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One target per goal per week; setting it again replaces it.
  unique (goal_id, week_start),
  foreign key (household_id, created_by) references persons (household_id, id) on delete set null (created_by)
);

create index planning_goal_week_targets_week_idx
  on planning_goal_week_targets (household_id, week_start);

-- Down Migration
drop table if exists planning_goal_week_targets;
