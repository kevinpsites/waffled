-- Up Migration
-- Domain 3: Chores & the economy (see docs/DATA_MODEL.md §3). Definitions +
-- materialized instances; one append-only ledger backs all currencies, balances
-- derived via a view.

create table chores (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  title text not null,
  emoji text,
  person_id uuid references persons(id),               -- null = up for grabs
  rrule text,                                           -- cadence (null = one-off)
  recurrence_end_at timestamptz,
  due_time time,
  reward_currency text,                                 -- stars | marbles | xp | null
  reward_amount int not null default 0,
  reminder_time time,
  requires_photo_proof boolean not null default false,
  requires_approval boolean not null default false,
  show_on_kiosk boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table chore_instances (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  chore_id uuid not null references chores(id),
  person_id uuid references persons(id),               -- assigned for this date
  due_on date not null,
  due_at timestamptz,
  status text not null default 'pending',              -- pending | done | skipped | expired
  claimed_by uuid references persons(id),
  completed_by uuid references persons(id),
  completed_at timestamptz,
  photo_url text,
  approval_status text,                                -- null | pending | approved | denied
  approved_by uuid references persons(id),
  approved_at timestamptz,
  reward_currency text,
  reward_amount int,                                   -- snapshot at generation
  awarded boolean not null default false,
  streak_count int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index uq_chore_inst on chore_instances (chore_id, due_on);
create index ix_chore_inst_due on chore_instances (household_id, due_on) where deleted_at is null;
create index ix_chore_inst_person on chore_instances (person_id, status);

create table ledger_entries (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  person_id uuid not null references persons(id),
  currency text not null,                              -- stars | marbles | xp
  amount int not null,                                 -- + earned, − spent
  reason text not null,                                -- chore_completed | reward_redeemed | …
  ref_type text,
  ref_id uuid,
  note text,
  created_by uuid references persons(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index ix_ledger on ledger_entries (household_id, person_id, currency) where deleted_at is null;

create view v_person_balances as
  select household_id, person_id, currency, sum(amount) as balance
  from ledger_entries where deleted_at is null
  group by household_id, person_id, currency;

create trigger trg_chores_updated before update on chores
  for each row execute function set_updated_at();
create trigger trg_chore_instances_updated before update on chore_instances
  for each row execute function set_updated_at();

-- Down Migration

drop view if exists v_person_balances;
drop table if exists ledger_entries cascade;
drop table if exists chore_instances cascade;
drop table if exists chores cascade;
