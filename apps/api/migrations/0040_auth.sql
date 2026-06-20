-- Built-in username/password auth + rotating refresh tokens, for self-hosted
-- deployments (alongside optional OIDC later). A password user reuses the
-- identities table (provider='password', auth0_user_id = the credential id, which
-- is also the JWT subject), so the whole sub→identity→person→household chain is
-- unchanged downstream.

create table if not exists credentials (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id),
  person_id     uuid not null references persons(id),
  email         text not null,
  password_hash text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
-- One active login per email (case-insensitive).
create unique index if not exists uq_credentials_email on credentials (lower(email)) where deleted_at is null;

create table if not exists refresh_tokens (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references persons(id),
  subject     text not null,            -- the identity subject this token authenticates as
  token_hash  text not null,            -- sha256(opaque token); the raw token is never stored
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists ix_refresh_token_hash on refresh_tokens (token_hash) where revoked_at is null;
