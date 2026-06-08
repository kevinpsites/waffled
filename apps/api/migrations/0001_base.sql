-- Up Migration

-- gen_random_uuid() for client-mintable UUID PKs (also in compose init; idempotent here
-- so a bare database — e.g. a test container — is fully provisioned by migrations alone).
create extension if not exists pgcrypto;

-- Shared trigger: bump updated_at on every row update. Attached per mutable table.
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Down Migration

drop function if exists set_updated_at();
