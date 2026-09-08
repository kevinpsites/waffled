import type { PoolClient } from 'pg'
import { HouseholdReferenceError } from './household-refs'

// Balances are derived from ledger rows, so there is no single balance record to
// lock. Every balance-checked debit must instead lock the same household-scoped
// person row before reading and writing the ledger. PostgreSQL then serializes
// competing decisions across processes and app instances. NO KEY UPDATE still
// conflicts with another spender, while allowing the KEY SHARE locks PostgreSQL
// takes to validate person foreign keys on new ledger/redemption rows.
// Lock order: operation/advisory lock → owning row (reward_redemptions or
// chore_instances, FOR UPDATE) → existing ledger rows → persons (NO KEY UPDATE)
// → currencies (FOR SHARE, sorted by key). Skip unneeded stages; never reverse
// them. In particular, refunds/decisions must lock redemption before person.
export async function lockLedgerSubject(
  client: PoolClient,
  householdId: string,
  personId: string
): Promise<void> {
  const locked = await client.query(
    `select id from persons
      where household_id=$1 and id=$2 and deleted_at is null
      for no key update`,
    [householdId, personId]
  )
  if (!locked.rowCount) throw new HouseholdReferenceError('person not found')
}

// Lock both sides of a conversion in stable order, or the single reward currency.
// Call only after lockLedgerSubject; a concurrent disable/delete must finish before
// validation, and a successful read must remain valid until the debit commits.
export async function lockSpendableCurrencies(client: PoolClient, householdId: string, currencies: string[]): Promise<boolean> {
  const keys = [...new Set(currencies)].sort()
  const { rowCount } = await client.query(
    `select key from currencies
      where household_id=$1 and key=any($2::text[]) and spendable=true and deleted_at is null
      order by key for share`,
    [householdId, keys]
  )
  return rowCount === keys.length
}
