-- Up Migration
-- Split the overloaded is_featured flag into a clear tier hierarchy. `is_featured` used to
-- be both a tag (any number of goals) AND the hero slot (exactly one), so the 2nd+ featured
-- goals silently did nothing. Now:
--   • is_spotlight  — the ONE hero goal per list (max 1 per goal_list). Setting a new one
--                     demotes the list's previous spotlight to Featured (service-enforced).
--   • is_featured   — the elevated band (0–N), unchanged.
--   • neither       — "More goals", the compact A–Z rows.
-- A goal's tier is derived spotlight > featured > normal.
alter table goals add column is_spotlight boolean not null default false;

-- Safety net: at most one spotlight per (household, list) among live goals. NULL list_ids
-- are treated as distinct by the index (ungrouped goals aren't constrained), so the service
-- also clears siblings explicitly — this just guards the common grouped case.
create unique index goals_one_spotlight_per_list
  on goals (household_id, goal_list_id)
  where is_spotlight and deleted_at is null;

-- Down Migration
drop index if exists goals_one_spotlight_per_list;
alter table goals drop column if exists is_spotlight;
