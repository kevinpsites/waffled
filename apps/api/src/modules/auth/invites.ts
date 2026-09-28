// P2.4 of the multi-household identity refactor (docs/design/multi-household-identity.md
// §5.5, decision 1): invite-and-accept. An admin invites an existing account's email
// to their household → a PENDING household_invites row (NOT an instant membership).
// The invited account sees it on login + via GET /api/auth/invites and accepts →
// which creates their persons membership linked to their account. No one is attached
// without their explicit OK.
import createAPI, { type Request, type Response } from 'lambda-api'
import { getPool, query } from '../../platform/db'
import { requireTenant, requireAdmin } from '../households/households'
import { pendingInvitesForEmail, createMembershipFromInvite } from './accounts'
import { AccessEndDateError, canonicalAccessWindow } from '../../platform/access-expiry'

type Api = ReturnType<typeof createAPI>

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const MEMBER_TYPES = new Set(['adult', 'caregiver', 'guest', 'teen', 'kid'])
const TEMPORARY_MEMBER_TYPES = new Set(['caregiver', 'guest'])

// Resolve the caller's account (id + email) from their active membership person.
// Returns null when the session has no account (kiosk/device/legacy person).
async function accountForTenant(personId: string): Promise<{ id: string; email: string } | null> {
  const { rows } = await query<{ id: string; email: string }>(
    `select a.id, a.email
       from persons p
       join accounts a on a.id = p.account_id and a.deleted_at is null
      where p.id = $1`,
    [personId]
  )
  return rows[0] ?? null
}

export function registerInviteRoutes(api: Api): void {
  // ── Admin: manage the caller's household's invites ─────────────────────────
  // Invite an existing account by email → a pending invite (no membership yet).
  api.post('/api/households/invites', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const b = (req.body ?? {}) as { email?: string; memberType?: string; isAdmin?: boolean; accessEndsOn?: unknown; accessExpiresAt?: string | null }
    const email = b.email?.trim()
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'BadRequest', message: 'a valid email is required' })
    }
    if (b.memberType !== undefined && typeof b.memberType !== 'string') {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid memberType' })
    }
    if (b.isAdmin !== undefined && typeof b.isAdmin !== 'boolean') {
      return res.status(400).json({ error: 'BadRequest', message: 'isAdmin must be a boolean' })
    }
    const memberType = b.memberType?.trim() || 'adult'
    const isAdmin = b.isAdmin === true
    if (!MEMBER_TYPES.has(memberType)) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid memberType' })
    }
    if (isAdmin && memberType !== 'adult') {
      return res.status(400).json({ error: 'BadRequest', message: 'only an adult role can be an admin' })
    }
    if (b.accessEndsOn !== undefined && b.accessExpiresAt !== undefined) {
      return res.status(400).json({ error: 'BadRequest', message: 'send accessEndsOn instead of accessExpiresAt, not both' })
    }
    if ((b.accessEndsOn != null || b.accessExpiresAt != null) && !TEMPORARY_MEMBER_TYPES.has(memberType)) {
      return res.status(400).json({ error: 'BadRequest', message: 'access expiration is only available for caregiver and guest roles' })
    }

    // Serialize invitation creation per household. This makes the member/duplicate
    // checks and insert one decision, rather than three autocommit statements that
    // two concurrent requests can both pass. The 0103 unique index is the final
    // database invariant for out-of-band writers.
    const client = await getPool().connect()
    try {
      await client.query('begin')
      const household = await client.query<{ timezone: string }>(
        `select timezone from households where id = $1 and deleted_at is null for update`,
        [tenant.householdId]
      )
      if (!household.rows[0]) {
        await client.query('rollback')
        return res.status(404).json({ error: 'NotFound', message: 'household not found' })
      }

      // Normalize both the current civil-date contract and the legacy exact-instant
      // contract while holding the household lock. The database trigger derives the
      // paired instant from this canonical date in the same transaction.
      const accessWindow = canonicalAccessWindow(b, household.rows[0].timezone)
      const accessEndsOn = accessWindow?.accessEndsOn ?? null
      const accessExpiresAt = accessWindow?.accessExpiresAt ?? null

      // Already a member of this household — an active person linked to an account
      // with that email. (The legacy credentials table is retired; accounts is the
      // single source of truth for who has a login.)
      const member = await client.query(
        `select 1 where exists(
           select 1 from persons p join accounts a on a.id = p.account_id and a.deleted_at is null
            where p.household_id = $1 and p.deleted_at is null and lower(a.email) = lower($2)
              and (p.access_expires_at is null or p.access_expires_at > clock_timestamp()))`,
        [tenant.householdId, email]
      )
      if (member.rows.length) {
        await client.query('rollback')
        return res.status(409).json({ error: 'Conflict', message: 'That email already belongs to this household.' })
      }

      // Expired invitations are unusable and should not occupy the unique pending
      // slot. Retire them before checking/inserting a fresh one.
      await client.query(
        `update household_invites
            set revoked_at = clock_timestamp()
          where household_id = $1 and lower(email) = lower($2)
            and accepted_at is null and revoked_at is null
            and access_expires_at is not null
            and access_expires_at <= clock_timestamp()`,
        [tenant.householdId, email]
      )
      const duplicate = await client.query(
        `select 1 from household_invites
          where household_id = $1 and lower(email) = lower($2)
            and accepted_at is null and revoked_at is null`,
        [tenant.householdId, email]
      )
      if (duplicate.rows.length) {
        await client.query('rollback')
        return res.status(409).json({ error: 'Conflict', message: 'A pending invite for that email already exists.' })
      }

      const inserted = await client.query<{ id: string; member_type: string; is_admin: boolean; access_ends_on: string | null; access_expires_at: Date | null }>(
        `insert into household_invites
           (household_id, email, member_type, is_admin, invited_by, access_ends_on, access_expires_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id, member_type, is_admin, access_ends_on, access_expires_at`,
        [tenant.householdId, email, memberType, isAdmin, tenant.personId, accessEndsOn, accessExpiresAt]
      )
      const inv = inserted.rows[0]
      if (inv.access_expires_at && inv.access_expires_at.getTime() <= Date.now()) {
        throw new AccessEndDateError('access expiration must remain in the future')
      }
      await client.query('commit')
      return res.status(201).json({
        invite: {
          id: inv.id,
          householdId: tenant.householdId,
          email,
          memberType: inv.member_type,
          isAdmin: inv.is_admin,
          accessEndsOn: inv.access_ends_on,
          accessExpiresAt: inv.access_expires_at,
        },
      })
    } catch (error) {
      await client.query('rollback').catch(() => {})
      if ((error as { code?: string }).code === '23505') {
        return res.status(409).json({ error: 'Conflict', message: 'A pending invite for that email already exists.' })
      }
      if (error instanceof AccessEndDateError) {
        return res.status(400).json({ error: 'BadRequest', message: error.message })
      }
      throw error
    } finally {
      client.release()
    }
  })

  // List the caller's household's pending invites.
  api.get('/api/households/invites', async (req: Request) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const { rows } = await query<{ id: string; email: string; member_type: string; is_admin: boolean; access_ends_on: string | null; access_expires_at: Date | null; created_at: Date }>(
      `select id, email, member_type, is_admin, access_ends_on, access_expires_at, created_at
         from household_invites
        where household_id = $1 and accepted_at is null and revoked_at is null
        order by created_at`,
      [tenant.householdId]
    )
    return {
      invites: rows.map((r) => ({
        id: r.id,
        email: r.email,
        memberType: r.member_type,
        isAdmin: r.is_admin,
        accessEndsOn: r.access_ends_on,
        accessExpiresAt: r.access_expires_at,
        createdAt: r.created_at,
      })),
    }
  })

  // Revoke a pending invite belonging to the caller's household.
  api.delete('/api/households/invites/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const id = req.params.id ?? ''
    const { rows } = await query<{ id: string }>(
      `update household_invites set revoked_at = now()
        where id = $1 and household_id = $2 and accepted_at is null and revoked_at is null
        returning id`,
      [id, tenant.householdId]
    )
    if (!rows.length) return res.status(404).json({ error: 'NotFound', message: 'invite not found' })
    return { ok: true }
  })

  // ── Account: see + accept invites addressed to the caller's account email ───
  api.get('/api/auth/invites', async (req: Request) => {
    const tenant = await requireTenant(req)
    const account = await accountForTenant(tenant.personId)
    if (!account) return { invites: [] }
    return { invites: await pendingInvitesForEmail(account.email) }
  })

  api.post('/api/auth/invites/:id/accept', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const account = await accountForTenant(tenant.personId)
    if (!account) return res.status(403).json({ error: 'Forbidden', message: 'This session has no account.' })

    const id = req.params.id ?? ''
    // The helper's locked re-read is the authorization decision. Keeping a separate
    // unlocked pending check here made a successful lost-response retry fail before
    // it could reach the helper's idempotent accepted-invite branch.
    const result = await createMembershipFromInvite(account.id, account.email, {
      id,
    })
    return res.status(result.created ? 201 : 200).json({
      membership: {
        householdId: result.householdId,
        personId: result.personId,
        isAdmin: result.isAdmin,
        memberType: result.memberType,
        accessEndsOn: result.accessEndsOn,
        accessExpiresAt: result.accessExpiresAt,
      },
    })
  })
}
