-- Up Migration
-- Meal Builder (docs/product/meal-builder-plan.md): a "plate" is a named, multi-recipe
-- meal — "BBQ Sunday" = BBQ Chicken (main) + Potato Salad + Coleslaw (sides) + Peach
-- Cobbler (dessert). A meal_plan_entries slot now points at EITHER a recipe or a meal;
-- the (meal_plan_id, date, meal_type) unique index is untouched.
create table if not exists meals (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  name          text not null,
  -- Stored + displayed only in v1; it does NOT rescale ingredient quantities
  -- (decision 4 — true unit/quantity reconciliation stays on the roadmap).
  servings      int  not null default 4,
  -- false = a one-off plate that lives only for its scheduled slot / grocery
  -- contribution; true = saved to the library and reusable.
  is_saved      boolean not null default false,
  created_by    uuid references persons(id),
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create table if not exists meal_recipes (
  meal_id        uuid not null references meals(id) on delete cascade,
  recipe_id      uuid not null references recipes(id) on delete cascade,
  -- The Main/Side/Dessert axis. Deliberately free text, not an enum, so Veggie/
  -- Bread/Appetizer can be added later without a migration. NEVER call this
  -- meal_type — that already means breakfast/lunch/dinner/snack elsewhere.
  role           text not null default 'side',
  sort_order     int  not null default 0,
  -- Per-dish cook: a four-dish plate has up to four cooks. The single
  -- meal_plan_entries.cook_person_id stays as-is for single-recipe entries.
  cook_person_id uuid references persons(id),
  primary key (meal_id, recipe_id)
);

alter table meal_plan_entries
  add column if not exists meal_id uuid references meals(id) on delete set null;

-- Which plate(s) a grocery row was added for, alongside the existing per-recipe
-- credit. Without this the board would have to GUESS which meal an off-plan row
-- belongs to by matching recipe sets — which invents phantom "unscheduled meal"
-- rows for any saved plate that happens to share those dishes.
alter table list_items add column if not exists source_meal_ids uuid[] not null default '{}';

-- Library list/search reads saved meals for a household, newest first.
create index if not exists meals_household_saved_idx
  on meals (household_id, is_saved)
  where deleted_at is null;

-- Grocery/calendar expansion walks meal → recipes; the board walks recipe → meals.
create index if not exists meal_recipes_recipe_idx on meal_recipes (recipe_id);

-- A week's plan expands meal-backed slots, so find them by meal.
create index if not exists meal_plan_entries_meal_idx
  on meal_plan_entries (meal_id)
  where deleted_at is null;

-- Down Migration
alter table list_items drop column if exists source_meal_ids;
drop index if exists meal_plan_entries_meal_idx;
alter table meal_plan_entries drop column if exists meal_id;
drop index if exists meal_recipes_recipe_idx;
drop table if exists meal_recipes;
drop index if exists meals_household_saved_idx;
drop table if exists meals;
