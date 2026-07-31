import type { PoolClient } from 'pg'
import { HouseholdReferenceError } from './household-refs'

// Balances are derived from ledger rows, so there is no single balance record to
// lock. Every balance-checked debit must instead lock the same household-scoped
// person row before reading and writing the ledger. PostgreSQL then serializes
// competing decisions across processes and app instances.
export async function lockLedgerSubject(
  client: PoolClient,
  householdId: string,
  personId: string
): Promise<void> {
  const locked = await client.query(
    `select id from persons
      where household_id=$1 and id=$2 and deleted_at is null
      for update`,
    [householdId, personId]
  )
  if (!locked.rowCount) throw new HouseholdReferenceError('person not found')
}
