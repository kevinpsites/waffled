-- Up Migration
-- Pantry staples: ingredients assumed in-house, so the grocery auto-build leaves
-- them off the list (the "Pantry check" card). list_items already carries
-- `category` (aisle), `source` (manual|auto), and `source_recipe_ids[]` for the
-- per-meal dots, so no list_items change is needed.

create table pantry_staples (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index uq_pantry_staple on pantry_staples (household_id, lower(name)) where deleted_at is null;
create trigger trg_pantry_staples_updated before update on pantry_staples for each row execute function set_updated_at();

-- Down Migration

drop table if exists pantry_staples cascade;
