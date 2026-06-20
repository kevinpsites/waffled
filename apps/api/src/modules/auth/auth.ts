// Built-in auth for self-hosted deployments: first-run setup, password login, and
// rotating refresh tokens. Issues a short-lived HS256 access token that matches the
// local issuer/audience — so the existing requireAuth verifier validates it with no
// changes, and PowerSync still exchanges it for its own RS256 token. OIDC (backend-
// mediated) layers on later as another way to mint the same session.
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import jwt from 'jsonwebtoken'
import createAPI, { type Request, type Response } from 'lambda-api'
import { config } from '../../platform/config'
import { query } from '../../platform/db'
import { provisionHousehold, presentHousehold, presentPerson } from '../households/households'
import { loginMethods } from './oidc'

type Api = ReturnType<typeof createAPI>

// Access token is short-lived (online API calls only — offline clients read their
// local PowerSync DB and need no token); the long refresh token covers reconnects
// after a long time offline. Both env-tunable.
const ACCESS_TTL_SECONDS = Number(process.env.ACCESS_TOKEN_TTL_SECONDS) || 60 * 60 // 1h
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS) || 60
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

// ── password hashing (Node scrypt — no extra dependency) ─────────────────────
function hashPassword(pw: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(pw, salt, 64)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}
function verifyPassword(pw: string, stored: string): boolean {
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
export function mintAccess(sub: string): { token: string; expiresIn: number } {
  const { secret, issuer, audience } = config.auth.local
  const token = jwt.sign({}, secret, { algorithm: 'HS256', subject: sub, issuer, audience, expiresIn: ACCESS_TTL_SECONDS })
  return { token, expiresIn: ACCESS_TTL_SECONDS }
}
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export async function issueRefresh(personId: string, subject: string): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await query(
    `insert into refresh_tokens (person_id, subject, token_hash, expires_at)
     values ($1, $2, $3, now() + ($4 || ' days')::interval)`,
    [personId, subject, sha256(token), String(REFRESH_TTL_DAYS)]
  )
  return token
}

// Validate + rotate a refresh token (single use): revoke the old, issue a new one.
async function rotateRefresh(token: string): Promise<{ subject: string; personId: string; newToken: string } | null> {
  const { rows } = await query<{ id: string; person_id: string; subject: string }>(
    `select id, person_id, subject from refresh_tokens
      where token_hash = $1 and revoked_at is null and expires_at > now() limit 1`,
    [sha256(token)]
  )
  const r = rows[0]
  if (!r) return null
  await query(`update refresh_tokens set revoked_at = now() where id = $1`, [r.id])
  const newToken = await issueRefresh(r.person_id, r.subject)
  return { subject: r.subject, personId: r.person_id, newToken }
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
    const { rows } = await query<{ id: string; person_id: string; password_hash: string }>(
      `select id, person_id, password_hash from credentials where lower(email) = lower($1) and deleted_at is null limit 1`,
      [email]
    )
    const cred = rows[0]
    if (!cred || !verifyPassword(password, cred.password_hash)) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid email or password.' })
    }
    const access = mintAccess(cred.id)
    const refreshToken = await issueRefresh(cred.person_id, cred.id)
    return res.status(200).json({ accessToken: access.token, refreshToken, expiresIn: access.expiresIn })
  })

  // Public: exchange a refresh token for a fresh access token (+ rotated refresh).
  api.post('/api/auth/refresh', async (req: Request, res: Response) => {
    const token = ((req.body ?? {}) as { refreshToken?: string }).refreshToken
    if (!token) return res.status(400).json({ error: 'BadRequest', message: 'refreshToken is required' })
    const r = await rotateRefresh(token)
    if (!r) return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired refresh token.' })
    const access = mintAccess(r.subject)
    return res.status(200).json({ accessToken: access.token, refreshToken: r.newToken, expiresIn: access.expiresIn })
  })

  // Public: revoke a refresh token (best effort).
  api.post('/api/auth/logout', async (req: Request) => {
    const token = ((req.body ?? {}) as { refreshToken?: string }).refreshToken
    if (token) await query(`update refresh_tokens set revoked_at = now() where token_hash = $1 and revoked_at is null`, [sha256(token)])
    return { ok: true }
  })
}
