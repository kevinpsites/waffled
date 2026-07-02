// Self-service account management: a logged-in member manages their OWN profile,
// password, and email — no admin required. Admin-managed member routes live in
// persons.ts / auth.ts; this module is the "my account" counterpart, always scoped
// to the caller (tenant.personId + tenant.householdId).
import createAPI, { type Request, type Response } from 'lambda-api'
import { query, getPool } from '../../platform/db'
import { tenantRoute } from '../../platform/route-guards'
import { hashPassword, verifyPassword } from '../auth/auth'
import { updatePerson } from '../persons/persons'
import type { Tenant } from '../households/households'

type Api = ReturnType<typeof createAPI>

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

// The caller's account (via persons.account_id) plus whether any OIDC identity
// exists — enough to derive hasAccount / hasPassword / provider for the account view
// and to gate the password/email flows.
interface AccountLookup {
  accountId: string | null
  email: string | null
  passwordHash: string | null
  hasOidc: boolean
}

async function lookupAccount(tenant: Tenant): Promise<AccountLookup> {
  const { rows } = await query<{
    account_id: string | null
    email: string | null
    password_hash: string | null
    has_oidc: boolean
  }>(
    `select p.account_id,
            a.email,
            a.password_hash,
            exists(
              select 1 from identities i
               where i.person_id = p.id and i.provider <> 'password' and i.deleted_at is null
            ) as has_oidc
       from persons p
       left join accounts a on a.id = p.account_id and a.deleted_at is null
      where p.id = $1`,
    [tenant.personId]
  )
  const r = rows[0]
  return {
    accountId: r?.account_id ?? null,
    email: r?.email ?? null,
    passwordHash: r?.password_hash ?? null,
    hasOidc: r?.has_oidc ?? false,
  }
}

export function registerAccountRoutes(api: Api): void {
  // The caller's own account + profile — the source of truth for the "My account"
  // screen (name/avatar/color/birthday, plus login shape: email, password vs SSO).
  api.get('/api/account', tenantRoute(async (tenant, _req: Request, res: Response) => {
    const p = await query<{
      name: string
      avatar_emoji: string | null
      color_hex: string | null
      birthday: string | null
      is_admin: boolean
      member_type: string
    }>(
      `select name, avatar_emoji, color_hex, birthday, is_admin, member_type
         from persons where id = $1 and household_id = $2 and deleted_at is null`,
      [tenant.personId, tenant.householdId]
    )
    const person = p.rows[0]
    if (!person) return res.status(404).json({ error: 'NotFound', message: 'person not found' })

    const acct = await lookupAccount(tenant)
    const hasAccount = acct.accountId != null
    const hasPassword = acct.passwordHash != null
    const provider = hasPassword ? 'password' : acct.hasOidc ? 'oidc' : 'none'

    return {
      personId: tenant.personId,
      name: person.name,
      avatarEmoji: person.avatar_emoji,
      colorHex: person.color_hex,
      birthday: person.birthday ?? null,
      isAdmin: person.is_admin,
      memberType: person.member_type,
      hasAccount,
      email: acct.email,
      hasPassword,
      provider,
    }
  }))

  // Update the caller's OWN profile. Household-scoped by tenant.householdId so a
  // token can only ever touch its own person. name (if given) must be non-empty.
  api.put('/api/account/profile', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      name?: unknown
      avatarEmoji?: unknown
      colorHex?: unknown
      birthday?: unknown
    }
    const patch: Record<string, unknown> = {}
    if ('name' in body && body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return res.status(400).json({ error: 'BadRequest', message: 'name must be non-empty' })
      }
      patch.name = body.name.trim()
    }
    if ('avatarEmoji' in body && body.avatarEmoji !== undefined) patch.avatarEmoji = body.avatarEmoji
    if ('colorHex' in body && body.colorHex !== undefined) patch.colorHex = body.colorHex
    if ('birthday' in body && body.birthday !== undefined) patch.birthday = body.birthday

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'no updatable fields provided' })
    }

    const person = await updatePerson(tenant.householdId, tenant.personId, patch)
    if (!person) return res.status(404).json({ error: 'NotFound', message: 'person not found' })
    return { ok: true }
  }))

  // Change the caller's own password. Requires the current password to check out.
  // OIDC-only accounts (no password_hash) have nothing to change here.
  api.put('/api/account/password', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { currentPassword?: string; newPassword?: string }
    const currentPassword = body.currentPassword ?? ''
    const newPassword = body.newPassword ?? ''

    const acct = await lookupAccount(tenant)
    if (!acct.accountId || !acct.passwordHash) {
      return res.status(400).json({ error: 'BadRequest', message: 'No password login on this account.' })
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'BadRequest', message: 'password must be at least 8 characters' })
    }
    if (!verifyPassword(currentPassword, acct.passwordHash)) {
      return res.status(403).json({ error: 'Forbidden', message: 'Current password is incorrect.' })
    }
    await query(`update accounts set password_hash = $1, updated_at = now() where id = $2`, [
      hashPassword(newPassword),
      acct.accountId,
    ])
    return { ok: true }
  }))

  // Change the caller's own email. Trusted change (no re-verification), mirrored onto
  // the account AND the caller's identities atomically. Password accounts must re-auth
  // with their current password; SSO-only email is managed at the provider.
  api.put('/api/account/email', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { email?: string; currentPassword?: string }
    const email = body.email?.trim() ?? ''
    const currentPassword = body.currentPassword ?? ''

    const acct = await lookupAccount(tenant)
    if (!acct.accountId) {
      return res.status(400).json({ error: 'BadRequest', message: 'No account on this login.' })
    }
    if (acct.passwordHash) {
      if (!verifyPassword(currentPassword, acct.passwordHash)) {
        return res.status(403).json({ error: 'Forbidden', message: 'Current password is incorrect.' })
      }
    } else {
      return res.status(400).json({ error: 'BadRequest', message: 'Your email is managed by your SSO provider.' })
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'BadRequest', message: 'a valid email is required' })
    }

    const client = await getPool().connect()
    try {
      await client.query('begin')
      await client.query(`update accounts set email = $1, updated_at = now() where id = $2`, [email, acct.accountId])
      await client.query(`update identities set email = $1, updated_at = now() where account_id = $2 and deleted_at is null`, [
        email,
        acct.accountId,
      ])
      await client.query('commit')
    } catch (err) {
      await client.query('rollback')
      if ((err as { code?: string }).code === '23505') {
        return res.status(409).json({ error: 'Conflict', message: 'That email is already in use.' })
      }
      throw err
    } finally {
      client.release()
    }
    return { ok: true }
  }))
}
