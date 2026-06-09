-- Up Migration
-- Domain 4: Goals (DATA_MODEL §4) — MVP slice. goal_lists (grouping/privacy unit),
-- goals (count/total/habit/checklist), goal_participants (who tracks), goal_logs
-- (append-only progress; SUM gives progress). Milestones, achievements, checklist
-- items, and list membership/privacy come with later depth.

create table goal_lists (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  name text not null,
  emoji text,
  color_hex text,
  is_private boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table goals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  goal_list_id uuid references goal_lists(id),
  title text not null,
  emoji text,
  category text,                                     -- physical | intellectual | spiritual | creative | social
  goal_type text not null,                          -- count | total | habit | checklist
  unit text,
  target_value numeric,
  habit_period text,
  habit_target_per_period int,
  tracking_mode text not null,                      -- shared_total | each_tracks
  log_method text not null default 'quick_log',
  deadline date,
  is_featured boolean not null default false,
  has_rewards boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index ix_goals_household on goals (household_id) where deleted_at is null;

create table goal_participants (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  goal_id uuid not null references goals(id),
  person_id uuid not null references persons(id),
  target_override numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index uq_goal_participant on goal_participants (goal_id, person_id) where deleted_at is null;

create table goal_logs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  goal_id uuid not null references goals(id),
  person_id uuid references persons(id),
  amount numeric not null,                          -- 1 book, 1.5 hours
  logged_at timestamptz not null default now(),
  source text not null default 'manual',            -- manual | quick_log | auto_calendar | checklist_item
  ref_type text,
  ref_id uuid,
  note text,
  rating int,
  created_by uuid references persons(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index ix_goal_logs on goal_logs (household_id, goal_id, person_id) where deleted_at is null;

create trigger trg_goal_lists_updated before update on goal_lists for each row execute function set_updated_at();
create trigger trg_goals_updated before update on goals for each row execute function set_updated_at();
create trigger trg_goal_participants_updated before update on goal_participants for each row execute function set_updated_at();
create trigger trg_goal_logs_updated before update on goal_logs for each row execute function set_updated_at();

-- Down Migration

drop table if exists goal_logs cascade;
drop table if exists goal_participants cascade;
drop table if exists goals cascade;
drop table if exists goal_lists cascade;
