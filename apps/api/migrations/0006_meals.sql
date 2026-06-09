-- Up Migration
-- Domain 5: Meals & recipes (see docs/DATA_MODEL.md §5). This migration covers
-- the recipe header + weekly meal plan needed by the kiosk meal card and the
-- Meals/Recipes screens. Structured ingredients/steps (recipe_ingredients,
-- recipe_steps, recipe_step_ingredients) come with the recipe-detail screen.

create table recipes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  title text not null,
  emoji text,
  description text,
  category text,                                     -- breakfast | lunch | dinner | snack | dessert
  tags text[],
  prep_time_minutes int,
  cook_time_minutes int,
  servings int not null default 4,
  image_url text,
  notes text,
  source_type text not null default 'manual',        -- manual | url_import | photo_scan | markdown_import
  source_name text,                                  -- cookbook / author / site
  source_url text,
  source_markdown text,                              -- original .md kept verbatim
  is_favorite boolean not null default false,
  cooked_count int not null default 0,
  last_cooked_at timestamptz,
  rating numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table meal_plans (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  start_date date not null,
  end_date date not null,
  status text not null default 'active',             -- draft | active | archived
  constraints jsonb,
  created_by uuid references persons(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table meal_plan_entries (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  meal_plan_id uuid not null references meal_plans(id),
  date date not null,
  meal_type text not null,                           -- breakfast | lunch | dinner | snack
  recipe_id uuid references recipes(id),             -- null = "leftovers"/"takeout"
  title text,
  reason text,
  is_locked boolean not null default false,
  is_ai_picked boolean not null default false,
  cook_person_id uuid references persons(id),
  servings_override int,
  status text not null default 'planned',            -- planned | cooked | skipped
  event_id uuid,                                     -- FK to events(id) added when calendar lands
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index uq_meal_entry on meal_plan_entries (meal_plan_id, date, meal_type);
create index ix_recipes_household on recipes (household_id) where deleted_at is null;
create index ix_meal_entries on meal_plan_entries (household_id, date) where deleted_at is null;

create trigger trg_recipes_updated before update on recipes
  for each row execute function set_updated_at();
create trigger trg_meal_plans_updated before update on meal_plans
  for each row execute function set_updated_at();
create trigger trg_meal_plan_entries_updated before update on meal_plan_entries
  for each row execute function set_updated_at();

-- Down Migration

drop table if exists meal_plan_entries cascade;
drop table if exists meal_plans cascade;
drop table if exists recipes cascade;
