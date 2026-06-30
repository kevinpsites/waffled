-- Up Migration
-- Per-item "running low" threshold override. Null = use the household default
-- (settings.pantry.lowThreshold, itself defaulting to 1). An item counts as
-- running low when its numeric amount is <= the effective threshold.

alter table pantry_items add column low_at numeric;

-- Down Migration

alter table pantry_items drop column if exists low_at;
