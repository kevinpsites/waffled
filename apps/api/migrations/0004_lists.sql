-- Up Migration
-- Domain 6: Lists (see docs/DATA_MODEL.md §6). One list_items table serves the
-- auto-built grocery list and custom lists.

create table lists (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  name text not null,
  emoji text,
  list_type text not null default 'custom',         -- grocery | custom
  is_auto_built boolean not null default false,
  sort_mode text not null default 'manual',         -- manual | aisle | meal
  auto_clear_checked interval,                       -- e.g. '24 hours'; null = never
  smart_suggestions boolean not null default true,
  created_by uuid references persons(id),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table list_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  list_id uuid not null references lists(id),
  name text not null,
  quantity text,                                     -- freeform: "2 bunches", "×4"
  status text not null default 'active',             -- active | suggested
  checked boolean not null default false,
  checked_at timestamptz,
  checked_by uuid references persons(id),
  category text,                                     -- aisle: Produce | Dairy | …
  source text not null default 'manual',             -- manual | auto | suggested | voice
  source_recipe_ids uuid[],
  assigned_to uuid references persons(id),
  sort_order int,
  created_by uuid references persons(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index ix_lists_household on lists (household_id) where deleted_at is null;
create index ix_list_items on list_items (household_id, list_id) where deleted_at is null;

create trigger trg_lists_updated before update on lists
  for each row execute function set_updated_at();
create trigger trg_list_items_updated before update on list_items
  for each row execute function set_updated_at();

-- Down Migration

drop table if exists list_items cascade;
drop table if exists lists cascade;
