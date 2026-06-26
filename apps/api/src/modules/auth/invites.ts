// P2.4 of the multi-household identity refactor (docs/design/multi-household-identity.md
// §5.5, decision 1): invite-and-accept. An admin invites an existing account's email
// to their household → a PENDING household_invites row (NOT an instant membership).
// The invited account sees it on login + via GET /api/auth/invites and accepts →
// which creates their persons membership linked to their account. No one is attached
// without their explicit OK.
import createAPI, { type Request, type Response } from 'lambda-api'
import { getPool, query } from '../../platform/db'
import { requireTenant, requireAdmin } from '../households/households'
import { pendingInvitesForEmail } from './accounts'

type Api = ReturnType<typeof createAPI>

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

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
    const b = (req.body ?? {}) as { email?: string; memberType?: string; isAdmin?: boolean }
    const email = b.email?.trim()
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'BadRequest', message: 'a valid email is required' })
    }
    const memberType = b.memberType?.trim() || 'adult'
    const isAdmin = b.isAdmin === true

    // Already a member of this household — an active person linked to an account
    // with that email, or an active credential in this household with that email.
    const member = await query(
      `select 1 where exists(
         select 1 from persons p join accounts a on a.id = p.account_id and a.deleted_at is null
          where p.household_id = $1 and p.deleted_at is null and lower(a.email) = lower($2))
        or exists(
         select 1 from credentials c
          where c.household_id = $1 and c.deleted_at is null and lower(c.email) = lower($2))`,
      [tenant.householdId, email]
    )
    if (member.rows.length) {
      return res.status(409).json({ error: 'Conflict', message: 'That email already belongs to this household.' })
    }

    // A pending invite for (household, email) already exists.
    const dup = await query(
      `select 1 from household_invites
        where household_id = $1 and lower(email) = lower($2)
          and accepted_at is null and revoked_at is null`,
      [tenant.householdId, email]
    )
    if (dup.rows.length) {
      return res.status(409).json({ error: 'Conflict', message: 'A pending invite for that email already exists.' })
    }

    const { rows } = await query<{ id: string; member_type: string; is_admin: boolean }>(
      `insert into household_invites (household_id, email, member_type, is_admin, invited_by)
       values ($1, $2, $3, $4, $5)
       returning id, member_type, is_admin`,
      [tenant.householdId, email, memberType, isAdmin, tenant.personId]
    )
    const inv = rows[0]
    return res.status(201).json({
      invite: {
        id: inv.id,
        householdId: tenant.householdId,
        email,
        memberType: inv.member_type,
        isAdmin: inv.is_admin,
      },
    })
  })

  // List the caller's household's pending invites.
  api.get('/api/households/invites', async (req: Request) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const { rows } = await query<{ id: string; email: string; member_type: string; is_admin: boolean; created_at: Date }>(
      `select id, email, member_type, is_admin, created_at
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
    const inv = await query<{
      id: string
      household_id: string
      email: string
      member_type: string
      is_admin: boolean
      accepted_at: Date | null
      revoked_at: Date | null
    }>(
      `select id, household_id, email, member_type, is_admin, accepted_at, revoked_at
         from household_invites where id = $1`,
      [id]
    )
    const invite = inv.rows[0]
    if (!invite) return res.status(404).json({ error: 'NotFound', message: 'invite not found' })
    if (invite.accepted_at || invite.revoked_at) {
      return res.status(403).json({ error: 'Forbidden', message: 'This invite is no longer pending.' })
    }
    // You may only accept an invite addressed to your own account email.
    if (invite.email.toLowerCase() !== account.email.toLowerCase()) {
      return res.status(403).json({ error: 'Forbidden', message: 'This invite is addressed to a different email.' })
    }

    // Idempotent: if the account is already a member of the target household, just
    // mark the invite accepted and return the existing membership — no duplicate.
    const existing = await query<{ id: string; member_type: string; is_admin: boolean }>(
      `select id, member_type, is_admin from persons
        where household_id = $1 and account_id = $2 and deleted_at is null
        order by created_at limit 1`,
      [invite.household_id, account.id]
    )
    if (existing.rows[0]) {
      await query(`update household_invites set accepted_at = now() where id = $1`, [invite.id])
      const m = existing.rows[0]
      return res.status(200).json({
        membership: {
          householdId: invite.household_id,
          personId: m.id,
          isAdmin: m.is_admin,
          memberType: m.member_type,
        },
      })
    }

    // Create the membership + accept the invite atomically. Display name = the
    // account's existing canonical person name, else the email local-part.
    const client = await getPool().connect()
    try {
      await client.query('begin')
      const nameRow = await client.query<{ name: string }>(
        `select name from persons where account_id = $1 and deleted_at is null order by created_at limit 1`,
        [account.id]
      )
      const name = nameRow.rows[0]?.name ?? account.email.split('@')[0]
      const personRow = await client.query<{ id: string }>(
        `insert into persons (household_id, name, member_type, is_admin, account_id)
         values ($1, $2, $3, $4, $5) returning id`,
        [invite.household_id, name, invite.member_type, invite.is_admin, account.id]
      )
      await client.query(`update household_invites set accepted_at = now() where id = $1`, [invite.id])
      await client.query('commit')
      return res.status(201).json({
        membership: {
          householdId: invite.household_id,
          personId: personRow.rows[0].id,
          isAdmin: invite.is_admin,
          memberType: invite.member_type,
        },
      })
    } catch (err) {
      await client.query('rollback')
      throw err
    } finally {
      client.release()
    }
  })
}
