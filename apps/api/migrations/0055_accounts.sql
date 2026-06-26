-- Up Migration
-- P1 of the multi-household identity refactor (docs/design/multi-household-identity.md
-- §4, §7). PURELY ADDITIVE: introduces a global `accounts` layer (the human login,
-- keyed by email across households) and links existing persons/identities to it.
-- It does not alter or drop any existing table/column and does not change runtime
-- behaviour. The backfill is idempotent so re-running is safe.

-- The global human login. Email is the cross-household identity.
create table if not exists accounts (
  id                uuid primary key default gen_random_uuid(),
  email             text not null,
  password_hash     text,                              -- null = SSO-only account
  last_household_id uuid references households(id),    -- land here on next login
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
-- One active account per email (case-insensitive); soft-deleted rows free the email.
create unique index if not exists uq_accounts_email on accounts (lower(email)) where deleted_at is null;

create trigger trg_accounts_updated before update on accounts
  for each row execute function set_updated_at();

alter table persons    add column if not exists account_id uuid references accounts(id);
alter table identities add column if not exists account_id uuid references accounts(id);
create index if not exists ix_persons_account on persons (account_id) where deleted_at is null;
-- An account is in a household at most once.
create unique index if not exists uq_person_account_household on persons (account_id, household_id)
  where account_id is not null and deleted_at is null;

-- ---------------------------------------------------------------------------
-- Backfill (idempotent)
-- ---------------------------------------------------------------------------

-- 1. One account per active credential email, carrying the password hash.
--    distinct on collapses any (unexpected) duplicate emails; not exists keeps
--    the whole step safe to re-run.
insert into accounts (email, password_hash)
select c.email, c.password_hash
from (
  select distinct on (lower(email)) email, password_hash
  from credentials
  where deleted_at is null
  order by lower(email), created_at
) c
where not exists (
  select 1 from accounts a where lower(a.email) = lower(c.email) and a.deleted_at is null
);

-- 2. Link each password person to its credential's account.
update persons p
set account_id = a.id
from credentials c
join accounts a on lower(a.email) = lower(c.email) and a.deleted_at is null
where c.person_id = p.id
  and c.deleted_at is null
  and p.account_id is null;

-- 3. Account for each active SSO identity (provider <> 'password') that has an
--    email but no account yet. Password hash stays null (SSO-only).
insert into accounts (email, password_hash)
select i.email, null
from (
  select distinct on (lower(email)) email
  from identities
  where deleted_at is null
    and email is not null
    and provider <> 'password'
  order by lower(email)
) i
where not exists (
  select 1 from accounts a where lower(a.email) = lower(i.email) and a.deleted_at is null
);

-- 4. Link every active identity with an email to its account (password
--    identities carry the login email too, so they link by email as well).
update identities i
set account_id = a.id
from accounts a
where i.account_id is null
  and i.deleted_at is null
  and i.email is not null
  and lower(a.email) = lower(i.email)
  and a.deleted_at is null;

-- 5. Link SSO-only persons (no credential) to their identity's account.
update persons p
set account_id = i.account_id
from identities i
where i.person_id = p.id
  and i.deleted_at is null
  and i.account_id is not null
  and p.account_id is null
  and p.deleted_at is null;

-- Down Migration

alter table identities drop column if exists account_id;
alter table persons    drop column if exists account_id;
drop table if exists accounts cascade;
