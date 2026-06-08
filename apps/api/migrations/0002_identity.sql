-- Up Migration
-- Domain 1: Identity & household (see docs/DATA_MODEL.md §1).
-- <base> columns are expanded inline: id / household_id / created_at / updated_at / deleted_at.

create table households (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  timezone        text not null,                  -- IANA, e.g. 'America/Chicago'
  week_start      text not null default 'sunday', -- sunday | monday
  owner_person_id uuid,                           -- the single owner (FK added after persons)
  settings        jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create table persons (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id),
  name          text not null,
  member_type   text not null,                    -- adult | teen | kid
  is_admin      boolean not null default false,   -- full management rights
  avatar_type   text not null default 'emoji',    -- emoji | image
  avatar_emoji  text,
  avatar_url    text,
  color_hex     text,
  palette_slot  text,
  birthday      date,
  dietary_notes text,
  reward_style  text not null default 'stars',    -- stars | stickers | jar | levels (UI only)
  show_on_kiosk boolean not null default true,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create table identities (                         -- only members who log in (kids have none)
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references households(id),
  person_id      uuid not null references persons(id),
  provider       text not null,                   -- google | apple | password
  auth0_user_id  text not null unique,            -- the JWT 'sub'
  email          text,
  email_verified boolean not null default false,
  is_primary     boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

-- households.owner_person_id → persons (added now that persons exists).
alter table households
  add constraint fk_households_owner
  foreign key (owner_person_id) references persons(id);

-- Tenant boundary + lookups; partial so soft-deleted rows are skipped.
create index idx_persons_household on persons (household_id) where deleted_at is null;
create index idx_identities_household on identities (household_id) where deleted_at is null;
create index idx_identities_person on identities (person_id) where deleted_at is null;

-- updated_at triggers
create trigger trg_households_updated before update on households
  for each row execute function set_updated_at();
create trigger trg_persons_updated before update on persons
  for each row execute function set_updated_at();
create trigger trg_identities_updated before update on identities
  for each row execute function set_updated_at();

-- Down Migration

drop table if exists identities cascade;
drop table if exists persons cascade;
drop table if exists households cascade;
