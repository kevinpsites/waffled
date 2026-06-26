// Account/membership helpers (P2.2 of the multi-household identity refactor,
// docs/design/multi-household-identity.md §5.3). An `account` is the global human
// login (keyed by email); a `person` is that account's membership in one household.
// Password login authenticates the account, then these helpers enumerate its
// memberships and pick which household to land on.
import { getPool, query } from '../../platform/db'

export interface Membership {
  householdId: string
  householdName: string
  personId: string
  isAdmin: boolean
  memberType: string
}

// All of an account's memberships (one per household it belongs to), ordered by
// household name for a stable switcher.
export async function listMemberships(accountId: string): Promise<Membership[]> {
  const { rows } = await query<{
    household_id: string
    household_name: string
    person_id: string
    is_admin: boolean
    member_type: string
  }>(
    `select p.household_id, h.name as household_name, p.id as person_id, p.is_admin, p.member_type
       from persons p
       join households h on h.id = p.household_id and h.deleted_at is null
      where p.account_id = $1 and p.deleted_at is null
      order by h.name`,
    [accountId]
  )
  return rows.map((r) => ({
    householdId: r.household_id,
    householdName: r.household_name,
    personId: r.person_id,
    isAdmin: r.is_admin,
    memberType: r.member_type,
  }))
}

// Lazy account backfill on login: a member added via setPersonLogin before the
// accounts layer existed has a credential but a null person.account_id. Reuse an
// existing active account for this email (so we never duplicate), else create one,
// then link the person. Idempotent. Returns the resolved account id.
export async function ensureAccountForLogin(
  email: string,
  personId: string,
  householdId: string,
  passwordHash: string | null
): Promise<string> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    // Lock any existing active account for this email so concurrent logins don't
    // both insert (the partial unique index would otherwise race).
    const existing = await client.query<{ id: string }>(
      `select id from accounts where lower(email) = lower($1) and deleted_at is null for update`,
      [email]
    )
    let accountId: string
    if (existing.rows[0]) {
      accountId = existing.rows[0].id
    } else {
      const ins = await client.query<{ id: string }>(
        `insert into accounts (email, password_hash, last_household_id) values ($1, $2, $3) returning id`,
        [email, passwordHash, householdId]
      )
      accountId = ins.rows[0].id
    }
    await client.query(
      `update persons set account_id = $1 where id = $2 and account_id is null`,
      [accountId, personId]
    )
    await client.query('commit')
    return accountId
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// Land the account on its last-active household if that membership still exists,
// else the first membership. Callers guarantee a non-empty membership list.
export async function pickActiveHousehold(
  accountId: string,
  memberships: Membership[]
): Promise<string> {
  const { rows } = await query<{ last_household_id: string | null }>(
    `select last_household_id from accounts where id = $1`,
    [accountId]
  )
  const last = rows[0]?.last_household_id
  if (last && memberships.some((m) => m.householdId === last)) return last
  return memberships[0].householdId
}

export async function setLastHousehold(accountId: string, householdId: string): Promise<void> {
  await query(`update accounts set last_household_id = $1 where id = $2`, [householdId, accountId])
}

// Pending (un-accepted, un-revoked) invites for an email, enriched with the
// household name so callers (login response, GET /api/auth/invites) can render them.
export async function pendingInvitesForEmail(
  email: string
): Promise<Array<{ id: string; householdId: string; householdName: string; memberType: string; isAdmin: boolean }>> {
  const { rows } = await query<{
    id: string
    household_id: string
    household_name: string
    member_type: string
    is_admin: boolean
  }>(
    `select hi.id, hi.household_id, h.name as household_name, hi.member_type, hi.is_admin
       from household_invites hi join households h on h.id = hi.household_id
      where lower(hi.email) = lower($1) and hi.accepted_at is null and hi.revoked_at is null`,
    [email]
  )
  return rows.map((r) => ({
    id: r.id,
    householdId: r.household_id,
    householdName: r.household_name,
    memberType: r.member_type,
    isAdmin: r.is_admin,
  }))
}
