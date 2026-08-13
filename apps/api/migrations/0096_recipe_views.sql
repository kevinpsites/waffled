-- Up Migration
-- Recently-viewed recipes. One row per (person, recipe) whose `viewed_at` MOVES on
-- each open, rather than an append-only log: the question this answers is "what did
-- I look at last", so a recipe opened fifty times is still one entry — which is also
-- what keeps this table bounded by (people × recipes) instead of growing forever.
--
-- Per-person, because two people sharing a kitchen browse for different reasons; the
-- household's combined history is derived at read time (max(viewed_at) per recipe)
-- rather than stored twice.
--
-- household_id is denormalized so the read path can scope by tenant without joining
-- persons, matching how the other per-person tables in this schema are shaped.

create table recipe_views (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  person_id uuid not null references persons(id) on delete cascade,
  recipe_id uuid not null references recipes(id) on delete cascade,
  viewed_at timestamptz not null default now()
);

-- The upsert target: one row per person+recipe.
create unique index uq_recipe_views_person_recipe on recipe_views (person_id, recipe_id);

-- The read path: newest-first within a household, for both the per-person and the
-- whole-household query.
create index ix_recipe_views_household_viewed on recipe_views (household_id, viewed_at desc);

-- Down Migration

drop index if exists ix_recipe_views_household_viewed;
drop index if exists uq_recipe_views_person_recipe;
drop table if exists recipe_views;
