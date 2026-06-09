-- Up Migration
-- Rich recipe metadata from the markdown frontmatter, so recipes can be browsed,
-- filtered, sorted (and later fed to the AI planner) by everything the vault
-- already encodes. `collection` is the source folder (Noodles / Favorites / Rice
-- / Mexican / …). `category` stays the meal-plan slot (breakfast|lunch|dinner|…).

alter table recipes add column meal_type text;           -- full-meal | main | side | dessert | …
alter table recipes add column protein text;             -- chicken | beef | pork | tofu | none | …
alter table recipes add column base text;                -- rice | noodle | potato | none | …
alter table recipes add column cuisine text;             -- American | Asian | Italian | Mexican | …
alter table recipes add column effort text;              -- weeknight | weekend | …
alter table recipes add column cook_method text;         -- oven | stovetop | sous-vide | …
alter table recipes add column flavor_profile text;
alter table recipes add column dietary text[];           -- vegetarian | gluten-free | …
alter table recipes add column vegetables text[];
alter table recipes add column collection text;          -- source folder

create index ix_recipes_collection on recipes (household_id, collection) where deleted_at is null;
create index ix_recipes_cuisine on recipes (household_id, cuisine) where deleted_at is null;
create index ix_recipes_protein on recipes (household_id, protein) where deleted_at is null;

-- Down Migration

drop index if exists ix_recipes_protein;
drop index if exists ix_recipes_cuisine;
drop index if exists ix_recipes_collection;
alter table recipes drop column if exists collection;
alter table recipes drop column if exists vegetables;
alter table recipes drop column if exists dietary;
alter table recipes drop column if exists flavor_profile;
alter table recipes drop column if exists cook_method;
alter table recipes drop column if exists effort;
alter table recipes drop column if exists cuisine;
alter table recipes drop column if exists base;
alter table recipes drop column if exists protein;
alter table recipes drop column if exists meal_type;
