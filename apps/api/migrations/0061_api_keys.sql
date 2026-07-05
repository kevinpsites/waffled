-- Up Migration
-- Per-user API keys (Immich-style): a long random secret minted once, stored only
-- as a sha256 hash, scoped to a set of resource:action grants. A key authenticates
-- as its owner person (real role/capabilities still apply), and the scopes bound
-- the resource families it may touch. Sent as the `x-api-key` header. REST-only.

create table api_keys (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  person_id uuid not null references persons(id),
  name text not null,                       -- human label ("Home Assistant", "grocery script")
  key_hash text not null unique,            -- sha256(secret) hex; the secret itself is never stored
  key_prefix text not null,                 -- first chars of the secret, shown to identify it ("waffled_AbC…")
  scopes text[] not null default '{}',      -- ["lists:read","chores:write", …]
  last_used_at timestamptz,
  expires_at timestamptz,                   -- null = never expires
  revoked_at timestamptz,                   -- soft revoke
  created_at timestamptz not null default now()
);
create index ix_api_keys_person on api_keys (person_id) where revoked_at is null;

-- Down Migration

drop table if exists api_keys cascade;
