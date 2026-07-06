-- Up Migration
-- Rewards get an optional `category` (treats / screen / adventures / toys /
-- privileges, or null). Purely presentational — it groups the reward shop into
-- filterable chips on the kiosk. Nullable; existing rewards stay uncategorised.

alter table rewards add column category text;

-- Down Migration

alter table rewards drop column if exists category;
