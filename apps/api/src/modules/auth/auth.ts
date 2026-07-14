// Built-in auth for self-hosted deployments: first-run setup, password login, and
// rotating refresh tokens. Issues a short-lived HS256 access token that matches the
// local issuer/audience — so the existing requireAuth verifier validates it with no
// changes, and PowerSync still exchanges it for its own RS256 token. OIDC (backend-
// mediated) layers on later as another way to mint the same session.
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import jwt from 'jsonwebtoken'
import createAPI, { type Request, type Response } from 'lambda-api'
import { config } from '../../platform/config'
import { query, getPool } from '../../platform/db'
import { provisionHousehold, presentHousehold, presentPerson, requireTenant, requireAdmin } from '../households/households'
import { loginMethods } from './oidc'
import {
  listMemberships,
  pickActiveHousehold,
  setLastHousehold,
  pendingInvitesForEmail,
} from './accounts'

type Api = ReturnType<typeof createAPI>

// Access token is short-lived (online API calls only — offline clients read their
// local PowerSync DB and need no token); the long refresh token covers reconnects
// after a long time offline. Both env-tunable.
const ACCESS_TTL_SECONDS = Number(process.env.ACCESS_TOKEN_TTL_SECONDS) || 60 * 60 // 1h
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS) || 60
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

// ── password hashing (Node scrypt — no extra dependency) ─────────────────────
export function hashPassword(pw: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(pw, salt, 64)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(pw, Buffer.from(saltHex, 'hex'), 64)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// ── tokens ───────────────────────────────────────────────────────────────────
// Exported so the OIDC module reaches the *same* session path — a verified OIDC
// login mints an identical access+refresh pair, keeping everything downstream
// (requireAuth, the PowerSync exchange) unchanged.
// `extra` carries optional non-identity claims (e.g. a device token's
// { kind:'device', household_id }). Default empty → password/OIDC callers are unchanged.
export function mintAccess(sub: string, extra: Record<string, unknown> = {}): { token: string; expiresIn: number } {
  const { secret, issuer, audience } = config.auth.local
  const token = jwt.sign(extra, secret, { algorithm: 'HS256', subject: sub, issuer, audience, expiresIn: ACCESS_TTL_SECONDS })
  return { token, expiresIn: ACCESS_TTL_SECONDS }
}
// Shared one-way hash for opaque secrets stored at rest (refresh tokens, device secrets).
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export async function issueRefresh(personId: string, subject: string): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await query(
    `insert into refresh_tokens (person_id, subject, token_hash, expires_at)
     values ($1, $2, $3, now() + ($4 || ' days')::interval)`,
    [personId, subject, sha256(token), String(REFRESH_TTL_DAYS)]
  )
  return token
}

// Validate + single-use revoke a refresh token: confirm it's live, revoke the old
// row, and return the person + the token's *old* subject — WITHOUT issuing a new
// one. The refresh route decides the new subject/claim (and re-keys to the account
// where one exists), which is what upgrades an in-flight legacy token.
async function validateAndRevokeRefresh(token: string): Promise<{ personId: string; subject: string } | null> {
  const { rows } = await query<{ id: string; person_id: string; subject: string }>(
    `select id, person_id, subject from refresh_tokens
      where token_hash = $1 and revoked_at is null and expires_at > now() limit 1`,
    [sha256(token)]
  )
  const r = rows[0]
  if (!r) return null
  await query(`update refresh_tokens set revoked_at = now() where id = $1`, [r.id])
  return { personId: r.person_id, subject: r.subject }
}

async function isInitialized(): Promise<boolean> {
  const { rows } = await query(`select 1 from households where deleted_at is null limit 1`)
  return rows.length > 0
}

export function registerAuthRoutes(api: Api): void {
  // Public: first-run + which login methods to show (password and/or OIDC, per the
  // DB-backed auth_config the admin edits in Settings).
  api.get('/api/auth/status', async () => ({ initialized: await isInitialized(), ...(await loginMethods()) }))

  // Public, one-time: create the first household + admin. Locked once initialized.
  api.post('/api/auth/setup', async (req: Request, res: Response) => {
    if (await isInitialized()) {
      return res.status(409).json({ error: 'Conflict', message: 'This instance is already set up.' })
    }
    const b = (req.body ?? {}) as {
      household?: { name?: string; timezone?: string }
      admin?: { name?: string; email?: string; password?: string; avatarEmoji?: string; colorHex?: string }
    }
    const name = b.household?.name?.trim()
    const timezone = b.household?.timezone?.trim()
    const adminName = b.admin?.name?.trim()
    const email = b.admin?.email?.trim()
    const password = b.admin?.password ?? ''
    if (!name || !timezone || !adminName || !email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'BadRequest', message: 'household name + timezone and admin name + valid email are required' })
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'BadRequest', message: 'password must be at least 8 characters' })
    }
    const sub = randomUUID()
    try {
      const { household, person } = await provisionHousehold({
        sub,
        provider: 'password',
        email,
        emailVerified: true,
        householdName: name,
        timezone,
        person: { name: adminName, avatarEmoji: b.admin?.avatarEmoji ?? null, colorHex: b.admin?.colorHex ?? null },
        credential: { email, passwordHash: hashPassword(password) },
      })
      const access = mintAccess(sub)
      const refreshToken = await issueRefresh(person.id, sub)
      return res.status(201).json({
        accessToken: access.token,
        refreshToken,
        expiresIn: access.expiresIn,
        person: presentPerson(person),
        household: presentHousehold(household),
      })
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return res.status(409).json({ error: 'Conflict', message: 'Already set up.' })
      }
      throw err
    }
  })

  // Public: password login → access + refresh tokens.
  api.post('/api/auth/login', async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as { email?: string; password?: string }
    const email = b.email?.trim()
    const password = b.password ?? ''
    if (!email || !password) return res.status(400).json({ error: 'BadRequest', message: 'email and password are required' })
    // Authenticate the *account* (the global human login, keyed by lower(email)).
    // The credentials table is gone — accounts.password_hash is the password mirror.
    const { rows } = await query<{ id: string; password_hash: string | null }>(
      `select id, password_hash from accounts where lower(email) = lower($1) and deleted_at is null limit 1`,
      [email]
    )
    const account = rows[0]
    // password_hash is null for SSO-only accounts — they have no password to verify.
    if (!account || !account.password_hash || !verifyPassword(password, account.password_hash)) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid email or password.' })
    }
    // Mint an account-scoped token landing on the last-active household.
    const accountId = account.id
    const memberships = await listMemberships(accountId)
    const active = await pickActiveHousehold(accountId, memberships)
    await setLastHousehold(accountId, active)
    const activePersonId = memberships.find((m) => m.householdId === active)!.personId
    const accessTk = mintAccess(accountId, { [config.auth.householdClaim]: active })
    const refreshToken = await issueRefresh(activePersonId, accountId)
    return res.status(200).json({
      accessToken: accessTk.token,
      refreshToken,
      expiresIn: accessTk.expiresIn,
      memberships,
      pendingInvites: await pendingInvitesForEmail(email),
    })
  })

  // Public: exchange a refresh token for a fresh access token (+ rotated refresh).
  api.post('/api/auth/refresh', async (req: Request, res: Response) => {
    const token = ((req.body ?? {}) as { refreshToken?: string }).refreshToken
    if (!token) return res.status(400).json({ error: 'BadRequest', message: 'refreshToken is required' })
    const r = await validateAndRevokeRefresh(token)
    if (!r) return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired refresh token.' })
    // Re-key off the person's account (not the presented token's old subject): this
    // upgrades an in-flight legacy token (subject = credential id) to an account-
    // scoped session. Persons without an account (kiosk/device/no-account) keep the
    // legacy claim-less subject.
    const pr = await query<{ household_id: string; account_id: string | null }>(
      `select household_id, account_id from persons where id = $1`,
      [r.personId]
    )
    const person = pr.rows[0]
    let access: { token: string; expiresIn: number }
    let newSubject: string
    if (person?.account_id) {
      newSubject = person.account_id
      access = mintAccess(newSubject, { [config.auth.householdClaim]: person.household_id })
    } else {
      newSubject = r.subject
      access = mintAccess(newSubject)
    }
    const newToken = await issueRefresh(r.personId, newSubject)
    return res.status(200).json({ accessToken: access.token, refreshToken: newToken, expiresIn: access.expiresIn })
  })

  // Authenticated: switch the account's active household. Mints a fresh access +
  // refresh pair scoped to another household the account belongs to, and remembers
  // it as last-active. 403 if the account isn't a member of the target.
  api.post('/api/auth/switch', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const targetHouseholdId = ((req.body ?? {}) as { householdId?: string }).householdId?.trim()
    if (!targetHouseholdId) return res.status(400).json({ error: 'BadRequest', message: 'householdId is required' })
    // Resolve the caller's account from their current membership person.
    const ar = await query<{ account_id: string | null }>(`select account_id from persons where id = $1`, [tenant.personId])
    const accountId = ar.rows[0]?.account_id
    if (!accountId) return res.status(403).json({ error: 'Forbidden', message: 'This session has no account.' })
    const memberships = await listMemberships(accountId)
    const target = memberships.find((m) => m.householdId === targetHouseholdId)
    if (!target) return res.status(403).json({ error: 'Forbidden', message: 'Not a member of that household.' })
    await setLastHousehold(accountId, targetHouseholdId)
    const accessTk = mintAccess(accountId, { [config.auth.householdClaim]: targetHouseholdId })
    const refreshToken = await issueRefresh(target.personId, accountId)
    return res.status(200).json({
      accessToken: accessTk.token,
      refreshToken,
      expiresIn: accessTk.expiresIn,
      householdId: targetHouseholdId,
      memberships,
    })
  })

  // Public: revoke a refresh token (best effort).
  api.post('/api/auth/logout', async (req: Request) => {
    const token = ((req.body ?? {}) as { refreshToken?: string }).refreshToken
    if (token) await query(`update refresh_tokens set revoked_at = now() where token_hash = $1 and revoked_at is null`, [sha256(token)])
    return { ok: true }
  })

  // ── member management (admin) ────────────────────────────────────────────────
  // Give a family member a login: an email (enables invite-gated SSO) and,
  // optionally, a password. One credential per person; re-PUT to change either.
  api.put('/api/persons/:id/login', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const personId = req.params.id ?? ''
    const b = (req.body ?? {}) as { email?: string; password?: string }
    const email = b.email?.trim()
    const password = b.password
    if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'BadRequest', message: 'a valid email is required' })
    if (password !== undefined && password !== '' && password.length < 8) {
      return res.status(400).json({ error: 'BadRequest', message: 'password must be at least 8 characters' })
    }
    // The person must belong to the caller's household.
    const owns = await query(`select 1 from persons where id = $1 and household_id = $2 and deleted_at is null`, [personId, tenant.householdId])
    if (!owns.rows.length) return res.status(404).json({ error: 'NotFound', message: 'person not found' })
    try {
      await setPersonLogin(tenant.householdId, personId, email, password || null)
      return { ok: true }
    } catch (err) {
      if (err instanceof LoginEmailConflictError || (err as { code?: string }).code === '23505') {
        return res.status(409).json({ error: 'Conflict', message: 'That email is already in use.' })
      }
      throw err
    }
  })

  // Remove a member's login entirely (revokes sessions). The owner keeps theirs.
  api.delete('/api/persons/:id/login', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const personId = req.params.id ?? ''
    const h = await query<{ owner_person_id: string | null }>(`select owner_person_id from households where id = $1`, [tenant.householdId])
    if (h.rows[0]?.owner_person_id === personId) {
      return res.status(400).json({ error: 'BadRequest', message: "The household owner's login can't be removed." })
    }
    const owns = await query(`select 1 from persons where id = $1 and household_id = $2 and deleted_at is null`, [personId, tenant.householdId])
    if (!owns.rows.length) return res.status(404).json({ error: 'NotFound', message: 'person not found' })
    await removePersonLogin(personId)
    return { ok: true }
  })
}

// Give (or change) a member's login, now backed by `accounts` (the global human
// login keyed by email) — the credentials table is retired. An existing global
// account may only be changed through the person already linked to it; joining a
// different household goes through the explicit invitation/acceptance flow.
//
// Identity wiring: a password identity still exists per person (provider='password')
// so OIDC invite-gating (findPersonByEmail, which matches by identities.email) and
// the legacy sub→identity path keep working. With account-scoped tokens its
// auth0_user_id (the unique, non-null JWT 'sub' column) is no longer a credential
// id — there's nothing to key off, so we mint a stable random subject. Existing
// password identities keep their old subject; we only refresh their email.
//
export class LoginEmailConflictError extends Error {}

export async function setPersonLogin(householdId: string, personId: string, email: string, password: string | null): Promise<void> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const hash = password ? hashPassword(password) : undefined
    const person = await client.query<{ account_id: string | null }>(
      `select account_id from persons
        where id = $1 and household_id = $2 and deleted_at is null
        for update`,
      [personId, householdId]
    )
    if (!person.rows[0]) throw new Error('person not found')

    // Lock any account that already owns the requested email. It is safe to edit
    // only when this exact person is already linked to that account.
    const existingAccount = await client.query<{ id: string }>(
      `select id from accounts where lower(email) = lower($1) and deleted_at is null for update`,
      [email]
    )
    let accountId = person.rows[0].account_id
    if (existingAccount.rows[0]) {
      if (accountId !== existingAccount.rows[0].id) throw new LoginEmailConflictError()
      await client.query(
        `update accounts set email = $1, password_hash = coalesce($2, password_hash), updated_at = now() where id = $3`,
        [email, hash ?? null, accountId]
      )
    } else if (accountId) {
      // Rename/update the person's own account rather than orphaning it and
      // silently switching the membership to a newly-created global account.
      await client.query(
        `update accounts set email = $1, password_hash = coalesce($2, password_hash), updated_at = now() where id = $3 and deleted_at is null`,
        [email, hash ?? null, accountId]
      )
    } else {
      const ins = await client.query<{ id: string }>(
        `insert into accounts (email, password_hash, last_household_id) values ($1, $2, $3) returning id`,
        [email, hash ?? null, householdId]
      )
      accountId = ins.rows[0].id
    }
    await client.query(`update persons set account_id = $1 where id = $2`, [accountId, personId])
    // When a password exists, make sure a password identity for this person exists
    // so OIDC invite-gating (matched by identities.email) and any legacy sub path
    // keep resolving. auth0_user_id must be unique + non-null; mint a fresh subject.
    const ident = await client.query<{ id: string }>(
      `select id from identities where person_id = $1 and provider = 'password' and deleted_at is null`,
      [personId]
    )
    if (ident.rows.length) {
      await client.query(`update identities set email = $1, account_id = $2, updated_at = now() where id = $3`, [email, accountId, ident.rows[0].id])
    } else if (password) {
      await client.query(
        `insert into identities (household_id, person_id, provider, auth0_user_id, email, email_verified, is_primary, account_id)
         values ($1, $2, 'password', $3, $4, true, false, $5)`,
        [householdId, personId, `password:${randomUUID()}`, email, accountId]
      )
    }
    await client.query('commit')
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// Remove sign-in for THIS membership only (not the human globally). Null this
// person's account_id, soft-delete their identities, and revoke their sessions.
// The account row is soft-deleted only if it has no other active memberships — so a
// human who belongs to several households keeps their login everywhere else. The
// person row itself stays (they become a no-login member of this household).
async function removePersonLogin(personId: string): Promise<void> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const pr = await client.query<{ account_id: string | null }>(
      `select account_id from persons where id = $1`,
      [personId]
    )
    const accountId = pr.rows[0]?.account_id ?? null
    await client.query(`update persons set account_id = null where id = $1`, [personId])
    await client.query(`update identities set deleted_at = now() where person_id = $1 and deleted_at is null`, [personId])
    await client.query(`update refresh_tokens set revoked_at = now() where person_id = $1 and revoked_at is null`, [personId])
    if (accountId) {
      // Drop the account only when no other active membership references it.
      const others = await client.query(
        `select 1 from persons where account_id = $1 and id <> $2 and deleted_at is null limit 1`,
        [accountId, personId]
      )
      if (!others.rows.length) {
        await client.query(`update accounts set deleted_at = now(), updated_at = now() where id = $1 and deleted_at is null`, [accountId])
      }
    }
    await client.query('commit')
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}
