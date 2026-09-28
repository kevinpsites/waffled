// Account/membership helpers (P2.2 of the multi-household identity refactor,
// docs/design/multi-household-identity.md §5.3). An `account` is the global human
// login (keyed by email); a `person` is that account's membership in one household.
// Password login authenticates the account, then these helpers enumerate its
// memberships and pick which household to land on.
import { getPool, query } from '../../platform/db'
import { AuthError } from '../../platform/auth'

export interface Membership {
  householdId: string
  householdName: string
  personId: string
  isAdmin: boolean
  memberType: string
  accessEndsOn: string | null
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
    access_ends_on: string | null
    access_expires_at: Date | null
  }>(
    `select p.household_id, h.name as household_name, p.id as person_id, p.is_admin,
            p.member_type, p.access_ends_on, p.access_expires_at
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
    accessEndsOn: r.access_ends_on,
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
): Promise<{ id: string; householdId: string; memberType: string; isAdmin: boolean; accessEndsOn: string | null; accessExpiresAt: Date | null } | null> {
  const { rows } = await query<{ id: string; household_id: string; member_type: string; is_admin: boolean; access_ends_on: string | null; access_expires_at: Date | null }>(
    `select hi.id, hi.household_id, hi.member_type, hi.is_admin,
            hi.access_ends_on, hi.access_expires_at
       from household_invites hi
       join households h on h.id = hi.household_id and h.deleted_at is null
      where lower(hi.email) = lower($1) and hi.accepted_at is null and hi.revoked_at is null
        and (hi.access_expires_at is null or hi.access_expires_at > now())
      order by hi.created_at limit 1`,
    [email]
  )
  const r = rows[0]
  return r ? { id: r.id, householdId: r.household_id, memberType: r.member_type, isAdmin: r.is_admin, accessEndsOn: r.access_ends_on, accessExpiresAt: r.access_expires_at } : null
}

// Create the membership for an accepted invite + mark it accepted, atomically.
// Idempotent: if the account is already an active member of the target household,
// just mark the invite accepted and return that person with created:false. Else
// derive a display name (the account's canonical person name, else the email
// local-part), insert the person, and return created:true.
export async function createMembershipFromInvite(
  accountId: string,
  accountEmail: string,
  invite: { id: string }
): Promise<{ personId: string; householdId: string; memberType: string; isAdmin: boolean; accessEndsOn: string | null; accessExpiresAt: Date | null; created: boolean }> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    // Discover only enough to establish the lock order. Timezone changes lock the
    // household before refreshing invites and people, so acceptance must take the
    // same parent-first order before it locks either child row.
    const discovered = await client.query<{ household_id: string }>(
      `select household_id from household_invites where id = $1`,
      [invite.id]
    )
    const candidateHouseholdId = discovered.rows[0]?.household_id
    if (!candidateHouseholdId) throw new AuthError('Invite not found.', 404)
    const household = await client.query<{ id: string }>(
      `select id from households where id = $1 and deleted_at is null for share`,
      [candidateHouseholdId]
    )
    if (!household.rows[0]) throw new AuthError('Invite not found.', 404)

    // Discovery is not authorization. Re-read and lock the invite only after the
    // parent lock: an admin may revoke it, its deadline may pass, or an out-of-band
    // writer may move it while this transaction waits. A household mismatch means
    // we do not hold the correct parent lock, so fail safely and let the caller retry.
    const invitation = await client.query<{
      id: string
      household_id: string
      email: string
      member_type: string
      is_admin: boolean
      access_ends_on: string | null
      access_expires_at: Date | null
      accepted_at: Date | null
      revoked_at: Date | null
    }>(
      `select id, household_id, email, member_type, is_admin, access_ends_on, access_expires_at,
              accepted_at, revoked_at
         from household_invites
        where id = $1
        for update`,
      [invite.id]
    )
    const lockedInvite = invitation.rows[0]
    if (!lockedInvite) throw new AuthError('Invite not found.', 404)
    if (lockedInvite.household_id !== candidateHouseholdId) {
      throw new AuthError('The invite changed while it was being accepted. Please try again.', 409)
    }
    if (lockedInvite.email.toLowerCase() !== accountEmail.toLowerCase()) {
      throw new AuthError('This invite is addressed to a different email.', 403)
    }
    if (lockedInvite.revoked_at) throw new AuthError('This invite is no longer pending.', 403)
    // Date.now() is evaluated after FOR UPDATE returns. PostgreSQL now() is fixed at
    // transaction start and could otherwise bless an invite while waiting on the lock.
    if (lockedInvite.access_expires_at && lockedInvite.access_expires_at.getTime() <= Date.now()) {
      throw new AuthError('This invite has expired.', 403)
    }

    const existing = await client.query<{ id: string; member_type: string; is_admin: boolean; access_ends_on: string | null; access_expires_at: Date | null; has_active_access: boolean }>(
      `select id, member_type, is_admin, access_ends_on, access_expires_at,
              (access_expires_at is null or access_expires_at > clock_timestamp()) as has_active_access
         from persons
        where household_id = $1 and account_id = $2 and deleted_at is null
        order by created_at limit 1
        for update`,
      [lockedInvite.household_id, accountId]
    )
    // A concurrent duplicate that arrives after the first transaction committed may
    // return the already-active membership. An old accepted invite must never revive
    // a membership that subsequently expired.
    if (lockedInvite.accepted_at) {
      const current = existing.rows[0]
      if (!current?.has_active_access) throw new AuthError('This invite is no longer pending.', 403)
      await client.query('commit')
      return {
        personId: current.id,
        householdId: lockedInvite.household_id,
        memberType: current.member_type,
        isAdmin: current.is_admin,
        accessEndsOn: current.access_ends_on,
        accessExpiresAt: current.access_expires_at,
        created: false,
      }
    }

    let result: { personId: string; memberType: string; isAdmin: boolean; accessEndsOn: string | null; accessExpiresAt: Date | null; created: boolean }
    if (existing.rows[0]) {
      const current = existing.rows[0]
      // A fresh invite restores an expired membership in place. Reusing the row
      // preserves its person identity and history while applying the new role and
      // deadline. An already-active membership remains untouched for idempotency.
      let membership = current
      if (!current.has_active_access) {
        const reactivated = await client.query<{ id: string; member_type: string; is_admin: boolean; access_ends_on: string | null; access_expires_at: Date | null; has_active_access: boolean }>(
          `update persons
              set member_type = $3, is_admin = $4, access_ends_on = $5,
                  access_expires_at = $6, show_on_kiosk = $7, updated_at = now()
            where household_id = $1 and account_id = $2 and deleted_at is null
            returning id, member_type, is_admin, access_ends_on, access_expires_at, true as has_active_access`,
          [lockedInvite.household_id, accountId, lockedInvite.member_type, lockedInvite.is_admin,
            lockedInvite.access_ends_on, lockedInvite.access_expires_at,
            !['caregiver', 'guest'].includes(lockedInvite.member_type)]
        )
        membership = reactivated.rows[0]
      }
      const m = membership
      result = {
        personId: m.id,
        memberType: m.member_type,
        isAdmin: m.is_admin,
        accessEndsOn: m.access_ends_on,
        accessExpiresAt: m.access_expires_at,
        created: false,
      }
    } else {
      const nameRow = await client.query<{ name: string }>(
        `select name from persons where account_id = $1 and deleted_at is null order by created_at limit 1`,
        [accountId]
      )
      const name = nameRow.rows[0]?.name ?? accountEmail.split('@')[0]
      const personRow = await client.query<{ id: string }>(
        `insert into persons (household_id, name, member_type, is_admin, account_id, show_on_kiosk, access_ends_on, access_expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [lockedInvite.household_id, name, lockedInvite.member_type, lockedInvite.is_admin, accountId,
          !['caregiver', 'guest'].includes(lockedInvite.member_type), lockedInvite.access_ends_on,
          lockedInvite.access_expires_at]
      )
      result = {
        personId: personRow.rows[0].id,
        memberType: lockedInvite.member_type,
        isAdmin: lockedInvite.is_admin,
        accessEndsOn: lockedInvite.access_ends_on,
        accessExpiresAt: lockedInvite.access_expires_at,
        created: true,
      }
    }

    // Re-check against wall-clock time at the commit decision. If a very short
    // deadline passed while this transaction worked, rowCount=0 and the membership
    // insert/reactivation above is rolled back with the thrown error.
    const accepted = await client.query(
      `update household_invites
          set accepted_at = clock_timestamp()
        where id = $1 and accepted_at is null and revoked_at is null
          and (access_expires_at is null or access_expires_at > clock_timestamp())
        returning id`,
      [lockedInvite.id]
    )
    if (!accepted.rows.length) throw new AuthError('This invite has expired.', 403)
    await client.query('commit')
    return { ...result, householdId: lockedInvite.household_id }
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
): Promise<Array<{ id: string; householdId: string; householdName: string; memberType: string; isAdmin: boolean; accessEndsOn: string | null; accessExpiresAt: Date | null }>> {
  const { rows } = await query<{
    id: string
    household_id: string
    household_name: string
    member_type: string
    is_admin: boolean
    access_ends_on: string | null
    access_expires_at: Date | null
  }>(
    `select hi.id, hi.household_id, h.name as household_name, hi.member_type, hi.is_admin, hi.access_ends_on, hi.access_expires_at
       from household_invites hi
       join households h on h.id = hi.household_id and h.deleted_at is null
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
    accessEndsOn: r.access_ends_on,
    accessExpiresAt: r.access_expires_at,
  }))
}
