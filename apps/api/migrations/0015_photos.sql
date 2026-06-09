-- Up Migration
-- Photos / memories domain (matches the handoff Photos mocks: the family wall →
-- screensaver, the "NEW MEMORY · Lake Day" banner, add-photos, and the photo
-- detail with reactions). Household-scoped, soft-deleted, with an updated_at
-- trigger — mirrors 0011_goal_lists_membership.sql.
--
-- NOTE ON THE DATA MODEL: Nook has no blob-storage / file-upload infra yet, so a
-- photo is EITHER an image URL (image_url) OR an emoji + color tile (emoji +
-- color_hex). The handoff mock itself renders colored emoji tiles, so this is the
-- intended fallback, not a simplification — the wall, screensaver and detail all
-- draw the emoji-on-gradient tile when image_url is null.

create table photos (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  image_url text,                                     -- when a real image exists; null → emoji tile
  caption text not null,                              -- wall label: "Beach day"
  emoji text,                                         -- tile glyph when image_url is null
  color_hex text,                                     -- tile gradient base (e.g. #7fc1e8)
  memory text,                                        -- album / memory grouping: "Lake Day"
  taken_at timestamptz,                               -- when the photo was taken (sorts the wall)
  is_favorite boolean not null default false,         -- the heart corner badge on the wall
  reactions jsonb not null default '{}'::jsonb,       -- {"heart":3} reaction counts (detail view)
  uploaded_by uuid references persons(id),            -- "Added by" in the detail
  created_by uuid references persons(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index ix_photos_household on photos (household_id) where deleted_at is null;
create index ix_photos_memory on photos (household_id, memory) where deleted_at is null;

create trigger trg_photos_updated before update on photos for each row execute function set_updated_at();

-- Down Migration

drop table if exists photos cascade;
