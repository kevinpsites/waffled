-- Up Migration
-- Per-household currency catalog (rewards economy, phase A). The ledger already
-- keys balances by a free-text `currency` (default 'stars'); this table gives each
-- key a label / symbol / color so the UI stops hardcoding stars and families can
-- rename it or run several currencies. `key` is the stable slug stored in
-- ledger_entries / chores / rewards (immutable once created); label/symbol are
-- presentation only, so renaming never rewrites history. Conversions/tiers (trade
-- 10 ⭐ for 1 💵) come in a follow-up table.

create table currencies (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  key          text not null,                  -- slug used in ledger/chores/rewards
  label        text not null,                  -- "Stars"
  symbol       text,                           -- emoji or character, e.g. ⭐ / $
  color        text,
  is_default   boolean not null default false, -- default earn currency for new chores
  spendable    boolean not null default true,  -- usable to buy rewards
  sort_order   int     not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create unique index uq_currency_key on currencies (household_id, key) where deleted_at is null;
create index ix_currencies on currencies (household_id) where deleted_at is null;
create trigger trg_currencies_updated before update on currencies
  for each row execute function set_updated_at();

-- Backfill: a default Stars currency for every existing household. key 'stars'
-- matches the historical ledger value so all existing balances carry over.
insert into currencies (household_id, key, label, symbol, color, is_default, spendable, sort_order)
select id, 'stars', 'Stars', '⭐', '#7A5AF8', true, true, 0 from households;

-- Down Migration
drop table if exists currencies cascade;
