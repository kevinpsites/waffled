-- Up Migration
-- Mark a pantry item as a ready-to-eat "meal" (frozen leftovers, a pre-made dinner,
-- or a protein you want to remember). These surface in "Cook from your pantry" →
-- "Use these up", alongside soon-to-expire items, even without a recipe.

alter table pantry_items add column is_meal boolean not null default false;

-- Down Migration

alter table pantry_items drop column if exists is_meal;
