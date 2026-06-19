-- Up Migration
-- Phase B smart suggestions: when an untagged event looks like it could count
-- toward a goal, the Today review surface offers to link it. Dismissing a
-- suggestion must stick (across devices, permanently) so it stops nagging —
-- recorded here, keyed per event. REST-only (computed server-side like the recap),
-- so this table is deliberately NOT replicated through PowerSync.
create table event_suggestion_dismissals (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  event_id     uuid not null references events(id) on delete cascade,
  created_by   uuid references persons(id),
  created_at   timestamptz not null default now()
);
create unique index ux_event_suggestion_dismissals on event_suggestion_dismissals (event_id);
create index ix_event_suggestion_dismissals_hh on event_suggestion_dismissals (household_id);

-- Down Migration
drop table if exists event_suggestion_dismissals cascade;
