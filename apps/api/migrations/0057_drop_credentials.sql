-- Up Migration
-- Retire the legacy `credentials` table. Every active credential has been mirrored
-- into `accounts` (same email + password_hash, person linked via persons.account_id)
-- — verified by `./nook admin audit-credentials` before this cutover. Login, member
-- management, OIDC invite-gating and the operator CLI now read/write `accounts`
-- exclusively, so the table is dead weight. DESTRUCTIVE: drops the table for good.
drop table if exists credentials;

-- Down Migration
-- Recreate the (now empty) credentials table so the schema can roll back. Data is
-- NOT restored — accounts is the source of truth after the cutover.
create table if not exists credentials (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id),
  person_id     uuid not null references persons(id),
  email         text not null,
  password_hash text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index if not exists uq_credentials_email on credentials (lower(email)) where deleted_at is null;
