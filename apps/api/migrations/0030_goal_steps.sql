-- Up Migration
-- Checklist goals become real named steps you tick off, instead of reusing the
-- numeric milestone thresholds. A step is stateful (done/undone) — progress for a
-- checklist goal = done steps / total steps. Ticking a step also writes a
-- goal_logs row (source 'checklist_item', ref_id = step id) so the activity feed
-- and streaks keep working uniformly; unticking soft-deletes that log.

create table goal_steps (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  goal_id      uuid not null references goals(id) on delete cascade,
  label        text not null,
  sort_order   int  not null default 0,
  done_at      timestamptz,
  done_by      uuid references persons(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create index ix_goal_steps_goal on goal_steps (goal_id) where deleted_at is null;
create trigger trg_goal_steps_updated before update on goal_steps
  for each row execute function set_updated_at();

-- Down Migration
drop table if exists goal_steps cascade;
