-- Up Migration
-- Per-goal ignored words for calendar suggestions. Dismissing a suggestion hides one
-- event, but a generated series (a weekly reminder) is a new event each time, so the
-- household can also say "never suggest events containing <word> for this goal".
-- `word` is what the person picked (shown back in Settings); `token` is its stem, which
-- is what the matcher compares. REST-only, like the other suggestion tables.
create table goal_suggestion_ignores (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  goal_id      uuid not null references goals(id) on delete cascade,
  word         text not null,
  token        text not null,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  -- Composite, like every persons reference since 0104: the creator must be in this household.
  foreign key (household_id, created_by) references persons (household_id, id)
);
create unique index ux_goal_suggestion_ignores on goal_suggestion_ignores (goal_id, token);
create index ix_goal_suggestion_ignores_hh on goal_suggestion_ignores (household_id);

-- Down Migration
drop table if exists goal_suggestion_ignores cascade;
