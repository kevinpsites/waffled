-- Up Migration
-- "Added / bought" date — when the item actually entered the pantry/freezer, distinct
-- from created_at (when the row was logged in Nook) and from expiry. Backdatable, so
-- you can record something you bought a while ago. Powers item age + the "old" warning
-- (e.g. beef that's been in the freezer 6+ months). Default today; backfill existing
-- rows from created_at.

alter table pantry_items add column added_on date not null default current_date;
update pantry_items set added_on = created_at::date;

-- Down Migration

alter table pantry_items drop column if exists added_on;
