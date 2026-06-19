-- Up Migration
-- Calendar → goal auto-counting, Phase 1 (single events). Two links + a
-- confirmation record (see ROADMAP "auto-from-calendar bridge"):
--   1. goals.auto_from_calendar (0031) = the goal ACCEPTS calendar contributions.
--   2. events.goal_id = "this event counts toward [goal]" — explicit per-event tag.
--   3. event_goal_logs = the idempotent confirmation: one row per
--      (event_id, occurrence_date, goal_id) once a person has confirmed or skipped
--      the recap. The unique key is what stops a sync re-run / double-confirm from
--      double-counting; goal_log_id points at the progress row that was written.
-- occurrence_date is carried now (single events use the start date) so Phase 2's
-- per-occurrence recurrence reuses the same record without a schema change.
alter table events add column goal_id uuid references goals(id) on delete set null;

create table event_goal_logs (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null references households(id) on delete cascade,
  event_id        uuid not null references events(id) on delete cascade,
  occurrence_date date not null,
  goal_id         uuid not null references goals(id) on delete cascade,
  status          text not null,                       -- 'logged' | 'skipped'
  goal_log_id     uuid references goal_logs(id) on delete set null,
  created_by      uuid references persons(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index ux_event_goal_logs on event_goal_logs (event_id, occurrence_date, goal_id);
create index ix_event_goal_logs_hh on event_goal_logs (household_id);
create trigger trg_event_goal_logs_updated before update on event_goal_logs
  for each row execute function set_updated_at();

-- Down Migration
drop table if exists event_goal_logs cascade;
alter table events drop column if exists goal_id;
