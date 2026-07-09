-- Up Migration
-- Apple Health auto-fill (iPhone), Tier 1. Mirrors the auto_from_calendar (0031) +
-- event_goal_logs (0033) pattern:
--   1. goals.health_metric = which Apple Health metric this goal auto-fills its
--      progress from (null = logged manually). Free-text, enum-ish like goal_type:
--      'steps' | 'flights' | 'exercise_minutes' | 'active_energy'.
--   2. health_goal_logs = the idempotent per-day record. goal_logs is append-only and
--      progress is SUM(amount), so a naive re-sync would double-count; this keeps ONE
--      progress row per (goal, person, metric, day) and REPLACES the day's amount on
--      re-sync. goal_log_id points at the goal_logs row that carries the number.
alter table goals add column health_metric text;

create table health_goal_logs (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  goal_id       uuid not null references goals(id) on delete cascade,
  person_id     uuid references persons(id) on delete cascade,
  metric        text not null,
  day           date not null,
  goal_log_id   uuid references goal_logs(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
-- One row per person/metric/day (person_id is always the syncing person, never null,
-- so NULL-distinctness in the unique index isn't a concern here).
create unique index ux_health_goal_logs on health_goal_logs (goal_id, person_id, metric, day);
create index ix_health_goal_logs_hh on health_goal_logs (household_id);
create trigger trg_health_goal_logs_updated before update on health_goal_logs
  for each row execute function set_updated_at();

-- Down Migration
drop table if exists health_goal_logs cascade;
alter table goals drop column if exists health_metric;
