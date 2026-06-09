-- Up Migration
-- Recipe depth for the grocery auto-build + recipe detail: an `aisle` on each
-- ingredient (grocery aisle: Produce / Dairy & Chilled / Meat & Seafood / Pantry
-- / Bakery / Frozen / Other) and a recipe_steps table (numbered instructions
-- parsed from the markdown). `section` stays the recipe's own grouping
-- (Pasta / Sauce / Garnish); `aisle` is where you buy it.

alter table recipe_ingredients add column aisle text;
alter table recipe_ingredients add column is_staple boolean not null default false;

create table recipe_steps (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  recipe_id uuid not null references recipes(id),
  step_number int not null,
  instruction text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index ix_recipe_steps on recipe_steps (household_id, recipe_id) where deleted_at is null;
create trigger trg_recipe_steps_updated before update on recipe_steps for each row execute function set_updated_at();

-- Down Migration

drop table if exists recipe_steps cascade;
alter table recipe_ingredients drop column if exists is_staple;
alter table recipe_ingredients drop column if exists aisle;
