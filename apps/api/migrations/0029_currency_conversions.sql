-- Up Migration
-- Currency conversions / tiers (rewards economy, phase B). Lets a household trade
-- one currency for another at a fixed rate (e.g. 10 ⭐ → 1 Family Dollar). A
-- conversion just defines the rate; applying it writes two ledger entries
-- (debit from_currency, credit to_currency, reason 'conversion') so balances stay
-- derived from the single ledger. from_currency/to_currency are currency keys
-- (matching ledger_entries.currency).

create table currency_conversions (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  from_currency text not null,
  to_currency   text not null,
  from_amount   int  not null check (from_amount > 0),
  to_amount     int  not null check (to_amount > 0),
  sort_order    int  not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index ix_conversions on currency_conversions (household_id) where deleted_at is null;
create trigger trg_conversions_updated before update on currency_conversions
  for each row execute function set_updated_at();

-- Down Migration
drop table if exists currency_conversions cascade;
