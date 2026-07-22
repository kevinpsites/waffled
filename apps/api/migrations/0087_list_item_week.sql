-- Up Migration
-- Week dimension for grocery items so the list can be viewed/built a week at a time.
-- Meal-derived rows (source='auto') and off-plan recipe adds (source='recipe') carry
-- the week they belong to; manually-typed rows (source='manual') stay NULL = global,
-- shown on every week. A NULL row is treated as "global" by the board read; existing
-- rows are intentionally left NULL (no computed backfill) — a current-week rebuild
-- folds legacy auto rows into that week, avoiding any fragile date-matching on deploy.
alter table list_items add column if not exists week_start date;

-- The board reads items for a given week OR the global (NULL) rows, so index both the
-- per-list week lookups and the household scope.
create index if not exists list_items_list_week_idx
  on list_items (list_id, week_start)
  where deleted_at is null;

-- Down Migration
drop index if exists list_items_list_week_idx;
alter table list_items drop column if exists week_start;
