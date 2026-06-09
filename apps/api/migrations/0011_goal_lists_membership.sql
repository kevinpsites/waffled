-- Up Migration
-- Goals depth (matches the handoff Goals mocks): goal-list membership (the
-- SHARED LISTS / INDIVIDUAL sidebar) and milestones (the detail milestone track
-- + bonus-reward thresholds). goal_lists/goals already exist (0010); this adds
-- who belongs to each list and the per-goal milestone definitions.

create table goal_list_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  goal_list_id uuid not null references goal_lists(id),
  person_id uuid not null references persons(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index uq_goal_list_member on goal_list_members (goal_list_id, person_id) where deleted_at is null;
create index ix_goal_list_members on goal_list_members (household_id, goal_list_id) where deleted_at is null;

create table goal_milestones (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  goal_id uuid not null references goals(id),
  threshold numeric not null,                         -- progress value that unlocks it
  emoji text,
  label text,                                         -- "500 hrs"
  reward_text text,                                   -- "Family movie night"
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index ix_goal_milestones on goal_milestones (household_id, goal_id) where deleted_at is null;

create trigger trg_goal_list_members_updated before update on goal_list_members for each row execute function set_updated_at();
create trigger trg_goal_milestones_updated before update on goal_milestones for each row execute function set_updated_at();

-- Down Migration

drop table if exists goal_milestones cascade;
drop table if exists goal_list_members cascade;
