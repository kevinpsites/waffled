-- Up Migration
-- Pantry module: on-hand food inventory (freezer/fridge/pantry + custom locations),
-- separate from grocery lists and the "expected staples" list. Quantity is split
-- amount + unit like recipe ingredients (amount is free text so "half" works). The
-- per-household location list lives in households.settings.pantry.locations (jsonb,
-- no schema). This table is REST-only (not in the PowerSync publication).

create table pantry_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  name text not null,
  amount text,                                  -- "2" | "half" | "1.5" (free text)
  unit text,                                    -- "pounds" | "bag" | ""
  location text not null default 'Pantry',      -- one of the household's configured locations
  expires_on date,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index ix_pantry_items on pantry_items (household_id) where deleted_at is null;
create trigger trg_pantry_items_updated before update on pantry_items for each row execute function set_updated_at();

-- Down Migration

drop table if exists pantry_items cascade;
