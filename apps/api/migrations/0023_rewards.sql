-- Up Migration
-- Rewards catalog + redemption requests — the "spend" half of the stars loop.
-- Earning already exists (ledger_entries, written on chore completion). A kid
-- requests a reward (pending); a parent approves (writes a negative ledger entry,
-- reason 'reward_redeemed') or denies. Balances stay derived from the ledger, so
-- there's a single source of truth for every currency.

create table rewards (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  title        text not null,
  emoji        text,
  cost         int  not null default 0,
  currency     text not null default 'stars',
  sort_order   int  not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create index ix_rewards on rewards (household_id) where deleted_at is null;
create trigger trg_rewards_updated before update on rewards
  for each row execute function set_updated_at();

create table reward_redemptions (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  reward_id    uuid not null references rewards(id),
  person_id    uuid not null references persons(id),         -- who it's for
  title        text not null,                                -- snapshot at request time
  emoji        text,
  cost         int  not null,
  currency     text not null default 'stars',
  status       text not null default 'pending',              -- pending | approved | denied
  requested_by uuid references persons(id),
  decided_by   uuid references persons(id),
  decided_at   timestamptz,
  ledger_id    uuid references ledger_entries(id),           -- the debit, once approved
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create index ix_redemptions on reward_redemptions (household_id, status) where deleted_at is null;
create index ix_redemptions_person on reward_redemptions (household_id, person_id) where deleted_at is null;
create trigger trg_redemptions_updated before update on reward_redemptions
  for each row execute function set_updated_at();

-- Down Migration

drop table if exists reward_redemptions cascade;
drop table if exists rewards cascade;
