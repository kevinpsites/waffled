-- Up Migration
-- Which plate CREATED a grocery row, as opposed to which plates merely want it.
--
-- `source_meal_ids` answers the display question — "should this row appear under
-- that plate's shelf?" — and is stamped onto every row a plate's dishes overlap,
-- including rows that were already on the list. That makes it the wrong fact to
-- delete by: a row you added yourself from a recipe page, days before building a
-- plate that happens to share the dish, ends up credited to the plate and
-- indistinguishable from one the plate created.
--
-- So record creation separately. A row is created once, by at most one plate, which
-- is why this is a single id rather than an array. Taking a plate off the list then
-- deletes only what that plate actually put there.
--
-- Deliberately NOT backfilled. The only rows that could be guessed at are ones with
-- exactly one crediting plate — which is precisely the shape of the bug above, so a
-- best-guess backfill would mark the user-added rows it is meant to protect. Rows
-- predating this migration are simply never auto-deleted: taking a plate off leaves
-- them behind, which the shopper can undo by hand. Leaking a row is recoverable;
-- deleting one is not.
alter table list_items add column created_by_meal_id uuid references meals(id) on delete set null;

create index if not exists list_items_created_by_meal_idx
  on list_items (created_by_meal_id) where created_by_meal_id is not null;

-- Down Migration
drop index if exists list_items_created_by_meal_idx;
alter table list_items drop column if exists created_by_meal_id;
