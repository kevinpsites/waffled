-- Up Migration
-- One Mealie connection per household; the token is encrypted (platform/crypto.ts).
-- connected_by uses the composite FK pattern (see 0104).

create table mealie_connections (
  household_id uuid primary key references households(id) on delete cascade,
  base_url text not null,
  token_encrypted text not null,
  shopping_list_id text,
  shopping_list_name text,
  public_url text,
  mealie_version text,
  connected_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (household_id, connected_by) references persons (household_id, id) on delete set null (connected_by)
);

-- Down Migration
drop table if exists mealie_connections;
