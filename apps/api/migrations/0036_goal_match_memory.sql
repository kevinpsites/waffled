-- Up Migration
-- Phase B learning cache: each household's matcher gets smarter over time. When a
-- person links/picks a goal for an event, or the LLM resolves a novel phrasing, we
-- record per-token → goal weights here. Future suggestions consult this FIRST
-- (instant, free) before the keyword matcher and before paying for another LLM
-- call — so the family's own vocabulary ("mow"/"grass" → Outside) builds up and the
-- LLM is needed less and less. Household-scoped configuration, kept in its own
-- table (not settings jsonb) because it accumulates rows and is ranked per query.
create table goal_match_memory (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  token        text not null,
  goal_id      uuid not null references goals(id) on delete cascade,
  weight       int  not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index ux_goal_match_memory on goal_match_memory (household_id, token, goal_id);
create index ix_goal_match_memory_hh on goal_match_memory (household_id);
create trigger trg_goal_match_memory_updated before update on goal_match_memory
  for each row execute function set_updated_at();

-- Down Migration
drop table if exists goal_match_memory cascade;
