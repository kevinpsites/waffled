-- Up Migration
-- Scratch store for AI recipe ingestion. When a user imports a recipe by photo,
-- we persist the source photo(s) to the blob store and record them here so a
-- background sweep can delete them after a short retention window (default 1 day,
-- households.settings.meals.recipePhotoTtlDays). These are throwaway source images
-- of a physical/printed recipe — NOT the recipe's hero image (that lives on the
-- recipes row and is kept). Rows are hard-deleted by the sweep once their blob is
-- gone, so there's no deleted_at / soft-delete here.
create table recipe_ingest_photos (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  storage_key text not null,
  content_type text not null,
  created_at timestamptz not null default now()
);

-- The sweep filters by age; the household index keeps per-household deletes cheap.
create index recipe_ingest_photos_created_idx on recipe_ingest_photos (created_at);
create index recipe_ingest_photos_household_idx on recipe_ingest_photos (household_id);

-- Down Migration
drop table if exists recipe_ingest_photos;
