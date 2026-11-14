-- Up Migration
-- OAuth 2.1 for MCP connectors (docs/product/mcp-plan.md section 4). A connector's
-- refresh tokens live here, never in refresh_tokens, so /api/auth/refresh cannot turn
-- one into a full user session.

-- Dynamically registered (RFC 7591) public clients. Claude registers a fresh one per
-- connection, so a row nobody ever authorized with is pruned after a few days.
-- Client ID Metadata Document clients are fetched by URL and not stored.
create table oauth_clients (
  id            uuid primary key default gen_random_uuid(),
  client_id     text not null unique,
  client_name   text not null,
  redirect_uris text[] not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index ix_oauth_clients_unused on oauth_clients (created_at) where last_used_at is null;

-- One approved connection: which client may act as which person in which household,
-- with which scopes. client_id is text, not an FK: a CIMD client has no row, and the
-- name shown in Settings is a snapshot taken at consent.
create table oauth_grants (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  person_id    uuid not null,
  client_id    text not null,
  client_name  text not null,
  redirect_uri text not null,
  resource     text not null,
  scopes       text[] not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  foreign key (household_id, person_id) references persons (household_id, id) on delete cascade
);
create index ix_oauth_grants_person on oauth_grants (person_id) where revoked_at is null;

-- One-time authorization codes (hashed), bound to everything the token request must repeat.
create table oauth_codes (
  code_hash      text primary key,
  grant_id       uuid not null references oauth_grants(id) on delete cascade,
  client_id      text not null,
  redirect_uri   text not null,
  code_challenge text not null,
  resource       text not null,
  expires_at     timestamptz not null,
  consumed_at    timestamptz,
  created_at     timestamptz not null default now()
);

-- Rotated on every use. A presented token whose used_at is set is a replay, and
-- revokes the whole grant.
create table oauth_refresh_tokens (
  id         uuid primary key default gen_random_uuid(),
  grant_id   uuid not null references oauth_grants(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index ix_oauth_refresh_tokens_grant on oauth_refresh_tokens (grant_id);

-- 0107 left grant_id without a target; an audit row outlives a deleted grant.
alter table mcp_audit
  add constraint mcp_audit_grant_id_fkey foreign key (grant_id) references oauth_grants(id) on delete set null;

-- Down Migration
alter table mcp_audit drop constraint if exists mcp_audit_grant_id_fkey;
drop table if exists oauth_refresh_tokens;
drop table if exists oauth_codes;
drop table if exists oauth_grants;
drop table if exists oauth_clients;
