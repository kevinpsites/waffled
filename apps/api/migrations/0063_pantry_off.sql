-- Up Migration
-- Open Food Facts integration for the pantry.
--
-- `products` is a GLOBAL cache (one row per barcode, shared across households):
-- an OFF barcode identifies the same product everywhere, and a shared cache keeps
-- us under OFF's 15-req/min-per-IP limit on a self-hosted (single-IP) box. The
-- freshness window lives on `fetched_at` (see off.ts: 90d TTL, 30d stale-while-
-- revalidate). `not_found` is cached too so unknown barcodes don't re-hammer OFF.
--
-- pantry_items additionally SNAPSHOT the OFF fields at add time (frozen "as bought"
-- nutrition + the barcode link for fast re-scans). Manual items leave them null.

create table products (
  barcode text primary key,
  name text,
  brand text,
  image_url text,
  quantity_text text,                       -- "2-ct family size" / "950 g"
  serving_basis text,                       -- "per pie" | "per 100 g"
  nutrition jsonb not null default '{}'::jsonb,  -- {calories, protein_g, fat_g, carbs_g, sodium_mg, ...}
  allergens text[] not null default '{}',   -- normalized: gluten, milk, soy, egg, peanut, tree_nut, fish, shellfish, sesame
  dietary text[] not null default '{}',     -- vegan, vegetarian, palm_oil_free
  nutriscore text,                          -- a..e
  nova int,                                 -- 1..4
  raw jsonb,                                -- full OFF product (re-derive later without a refetch)
  status text not null default 'found',     -- found | not_found
  source text not null default 'openfoodfacts',
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table pantry_items
  add column barcode text,                   -- soft link to products(barcode)
  add column brand text,
  add column image_url text,                 -- OFF image or a user-replaced photo
  add column quantity_text text,
  add column serving_basis text,
  add column nutrition jsonb,                -- snapshot (null = no nutrition data)
  add column allergens text[],               -- snapshot (null = unknown; {} = none)
  add column dietary text[],
  add column source text;                    -- 'openfoodfacts' when populated from OFF

create index ix_pantry_items_barcode on pantry_items (barcode) where deleted_at is null;

-- Down Migration

drop index if exists ix_pantry_items_barcode;
alter table pantry_items
  drop column if exists barcode,
  drop column if exists brand,
  drop column if exists image_url,
  drop column if exists quantity_text,
  drop column if exists serving_basis,
  drop column if exists nutrition,
  drop column if exists allergens,
  drop column if exists dietary,
  drop column if exists source;
drop table if exists products cascade;
