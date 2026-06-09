-- Up Migration
-- Structured recipe ingredients (DATA_MODEL §5). Powers recipe detail and the
-- grocery auto-build (dedup planned recipes' ingredients → list_items). `display`
-- keeps the original line verbatim (parse fallback / "to taste"); `section`
-- groups them (Protein / Breading / Sauce …). Steps + per-step links come later.

create table recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  recipe_id uuid not null references recipes(id),
  name text not null,
  amount numeric,                                    -- nullable for "to taste"
  unit text,
  prep_note text,                                    -- "diced", "to taste"
  display text,                                      -- raw original string (truth / fallback)
  section text,                                      -- "Protein" | "Breading" | "Sauce" | …
  sort_order int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index ix_recipe_ingredients on recipe_ingredients (household_id, recipe_id)
  where deleted_at is null;

create trigger trg_recipe_ingredients_updated before update on recipe_ingredients
  for each row execute function set_updated_at();

-- Down Migration

drop table if exists recipe_ingredients cascade;
