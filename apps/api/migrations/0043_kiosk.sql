-- Kiosk device pairing + per-person PIN (M3.3). A shared tablet is "paired" once to
-- a household (kiosk_devices); it then shows a Netflix-style profile picker and mints
-- a real, person-scoped session when someone taps a profile — so attribution and the
-- existing admin/role gates apply unchanged. PINs are optional per person.

-- Per-person kiosk PIN (optional). Hashed with the same scrypt scheme as passwords.
-- pin_failed_count / pin_locked_until throttle brute force on the shared device.
alter table persons add column if not exists pin_hash         text;
alter table persons add column if not exists pin_failed_count int not null default 0;
alter table persons add column if not exists pin_locked_until timestamptz;

-- A paired kiosk device. token_hash is sha256 of the long-lived device secret (which
-- behaves like a refresh token): the device presents the secret to mint short-lived
-- device access tokens. A device is NOT a person and has no identity row, so its token
-- is automatically rejected by requireTenant on every data route.
create table if not exists kiosk_devices (
  id                   uuid primary key default gen_random_uuid(),
  household_id         uuid not null references households(id),
  label                text not null default 'Kiosk',
  token_hash           text not null,
  created_by_person_id uuid references persons(id),
  last_seen_at         timestamptz,
  created_at           timestamptz not null default now(),
  revoked_at           timestamptz
);
create index if not exists ix_kiosk_devices_token     on kiosk_devices (token_hash)   where revoked_at is null;
create index if not exists ix_kiosk_devices_household on kiosk_devices (household_id)  where revoked_at is null;

-- Short-lived, one-time pairing codes (template: oidc_login_states). An admin mints a
-- code in Settings; it's typed on the tablet to claim a device secret.
create table if not exists kiosk_pairing_codes (
  code         text primary key,
  household_id uuid not null references households(id),
  created_by   uuid references persons(id),
  created_at   timestamptz not null default now(),
  consumed_at  timestamptz
);
