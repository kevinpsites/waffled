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
  accessExpiresAt: Date | null
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
    access_expires_at: Date | null
  }>(
    `select p.household_id, h.name as household_name, p.id as person_id, p.is_admin,
            p.member_type, p.access_expires_at
       from persons p
       join households h on h.id = p.household_id and h.deleted_at is null
      where p.account_id = $1 and p.deleted_at is null
        and (p.access_expires_at is null or p.access_expires_at > now())
      order by h.name`,
    [accountId]
  )
  return rows.map((r) => ({
    householdId: r.household_id,
    householdName: r.household_name,
    personId: r.person_id,
    isAdmin: r.is_admin,
    memberType: r.member_type,
    accessExpiresAt: r.access_expires_at,
  }))
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

// Active account for an email (case-insensitive). Null when none exists.
export async function findAccountByEmail(
  email: string
): Promise<{ id: string; email: string; lastHouseholdId: string | null } | null> {
  const { rows } = await query<{ id: string; email: string; last_household_id: string | null }>(
    `select id, email, last_household_id from accounts
      where lower(email) = lower($1) and deleted_at is null limit 1`,
    [email]
  )
  const r = rows[0]
  return r ? { id: r.id, email: r.email, lastHouseholdId: r.last_household_id } : null
}

// Return the id of an active SSO-only account for this email, creating one
// (password_hash = null) if none. Same select-for-update-in-a-txn pattern as
// ensureAccountForLogin to avoid racing the partial unique index. Does NOT set
// last_household_id — the membership creation / login picks it.
export async function ensureSsoAccount(email: string): Promise<string> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const existing = await client.query<{ id: string }>(
      `select id from accounts where lower(email) = lower($1) and deleted_at is null for update`,
      [email]
    )
    let accountId: string
    if (existing.rows[0]) {
      accountId = existing.rows[0].id
    } else {
      const ins = await client.query<{ id: string }>(
        `insert into accounts (email, password_hash) values ($1, null) returning id`,
        [email]
      )
      accountId = ins.rows[0].id
    }
    await client.query('commit')
    return accountId
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// Backfill a legacy email-only person onto an account (only if not already linked).
export async function linkPersonAccount(personId: string, accountId: string): Promise<void> {
  await query(`update persons set account_id = $1 where id = $2 and account_id is null`, [accountId, personId])
}

// Earliest pending (un-accepted, un-revoked) invite for an email, or null.
export async function firstPendingInviteForEmail(
  email: string
): Promise<{ id: string; householdId: string; memberType: string; isAdmin: boolean; accessExpiresAt: Date | null } | null> {
  const { rows } = await query<{ id: string; household_id: string; member_type: string; is_admin: boolean; access_expires_at: Date | null }>(
    `select id, household_id, member_type, is_admin, access_expires_at from household_invites
      where lower(email) = lower($1) and accepted_at is null and revoked_at is null
        and (access_expires_at is null or access_expires_at > now())
      order by created_at limit 1`,
    [email]
  )
  const r = rows[0]
  return r ? { id: r.id, householdId: r.household_id, memberType: r.member_type, isAdmin: r.is_admin, accessExpiresAt: r.access_expires_at } : null
}

// Create the membership for an accepted invite + mark it accepted, atomically.
// Idempotent: if the account is already an active member of the target household,
// just mark the invite accepted and return that person with created:false. Else
// derive a display name (the account's canonical person name, else the email
// local-part), insert the person, and return created:true.
export async function createMembershipFromInvite(
  accountId: string,
  accountEmail: string,
  invite: { id: string; householdId: string; memberType: string; isAdmin: boolean; accessExpiresAt: Date | null }
): Promise<{ personId: string; householdId: string; memberType: string; isAdmin: boolean; accessExpiresAt: Date | null; created: boolean }> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const existing = await client.query<{ id: string; member_type: string; is_admin: boolean; access_expires_at: Date | null }>(
      `select id, member_type, is_admin, access_expires_at from persons
        where household_id = $1 and account_id = $2 and deleted_at is null
        order by created_at limit 1`,
      [invite.householdId, accountId]
    )
    if (existing.rows[0]) {
      await client.query(`update household_invites set accepted_at = now() where id = $1`, [invite.id])
      await client.query('commit')
      const m = existing.rows[0]
      return { personId: m.id, householdId: invite.householdId, memberType: m.member_type, isAdmin: m.is_admin, accessExpiresAt: m.access_expires_at, created: false }
    }
    const nameRow = await client.query<{ name: string }>(
      `select name from persons where account_id = $1 and deleted_at is null order by created_at limit 1`,
      [accountId]
    )
    const name = nameRow.rows[0]?.name ?? accountEmail.split('@')[0]
    const personRow = await client.query<{ id: string }>(
      `insert into persons (household_id, name, member_type, is_admin, account_id, show_on_kiosk, access_expires_at)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [invite.householdId, name, invite.memberType, invite.isAdmin, accountId,
        !['caregiver', 'guest'].includes(invite.memberType), invite.accessExpiresAt]
    )
    await client.query(`update household_invites set accepted_at = now() where id = $1`, [invite.id])
    await client.query('commit')
    return { personId: personRow.rows[0].id, householdId: invite.householdId, memberType: invite.memberType, isAdmin: invite.isAdmin, accessExpiresAt: invite.accessExpiresAt, created: true }
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// Pending (un-accepted, un-revoked) invites for an email, enriched with the
// household name so callers (login response, GET /api/auth/invites) can render them.
export async function pendingInvitesForEmail(
  email: string
): Promise<Array<{ id: string; householdId: string; householdName: string; memberType: string; isAdmin: boolean; accessExpiresAt: Date | null }>> {
  const { rows } = await query<{
    id: string
    household_id: string
    household_name: string
    member_type: string
    is_admin: boolean
    access_expires_at: Date | null
  }>(
    `select hi.id, hi.household_id, h.name as household_name, hi.member_type, hi.is_admin, hi.access_expires_at
       from household_invites hi join households h on h.id = hi.household_id
      where lower(hi.email) = lower($1) and hi.accepted_at is null and hi.revoked_at is null
        and (hi.access_expires_at is null or hi.access_expires_at > now())`,
    [email]
  )
  return rows.map((r) => ({
    id: r.id,
    householdId: r.household_id,
    householdName: r.household_name,
    memberType: r.member_type,
    isAdmin: r.is_admin,
    accessExpiresAt: r.access_expires_at,
  }))
}
