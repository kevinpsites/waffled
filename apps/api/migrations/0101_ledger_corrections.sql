-- Up Migration
-- Corrections are append-only compensating entries. The original ledger row is
-- never edited or hidden, so balances remain derivable and the audit trail says
-- who corrected what and why.

alter table ledger_entries
  add column reverses_entry_id uuid references ledger_entries(id),
  add column correction_of_id uuid references ledger_entries(id),
  add column correction_group_id uuid,
  add column correction_reason text,
  add column idempotency_key text;

create unique index uq_ledger_entry_reversal
  on ledger_entries (household_id, reverses_entry_id)
  where reverses_entry_id is not null;

create unique index uq_ledger_correction_idempotency
  on ledger_entries (household_id, idempotency_key)
  where idempotency_key is not null;

alter table reward_redemptions
  add column refund_ledger_id uuid references ledger_entries(id);

-- Down Migration

alter table reward_redemptions
  drop column if exists refund_ledger_id;

drop index if exists uq_ledger_correction_idempotency;
drop index if exists uq_ledger_entry_reversal;

alter table ledger_entries
  drop column if exists idempotency_key,
  drop column if exists correction_reason,
  drop column if exists correction_group_id,
  drop column if exists correction_of_id,
  drop column if exists reverses_entry_id;
