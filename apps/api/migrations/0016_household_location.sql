-- Up Migration
-- Household location — captured now for the kiosk topbar weather (a weather
-- provider is wired later; this just stores where "here" is).

alter table households add column location text;

-- Down Migration

alter table households drop column if exists location;
