-- Up Migration
-- Structured per-person allergens (e.g. a gluten-free member). These roll up into
-- the pantry's effective avoid set, so items containing them get a red warning and
-- can be attributed to who they affect. Distinct from the free-text dietary_notes.

alter table persons add column allergens text[] not null default '{}';

-- Down Migration

alter table persons drop column if exists allergens;
