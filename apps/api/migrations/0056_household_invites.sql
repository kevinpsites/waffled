-- Up Migration
-- P1 of the multi-household identity refactor (docs/design/multi-household-identity.md
-- §4, §5.5). PURELY ADDITIVE: introduces the `household_invites` table. Adding an
-- existing account's email to another household creates a *pending* invite that the
-- account accepts on next login, so no one is attached to a household without their
-- OK. This migration only adds the table; the accept flow lands in P2. It does not
-- alter or drop any existing table/column.

create table if not exists household_invites (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  email        text not null,                       -- the invited login email
  member_type  text not null default 'adult',
  is_admin     boolean not null default false,
  invited_by   uuid references persons(id),
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  revoked_at   timestamptz
);
-- Fast lookup of still-pending invites by email (case-insensitive).
create index if not exists ix_household_invites_email on household_invites (lower(email))
  where accepted_at is null and revoked_at is null;

-- Down Migration

drop table if exists household_invites cascade;
