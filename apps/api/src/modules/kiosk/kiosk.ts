// Kiosk device pairing + kid profile tokens (M3.3).
//
// A shared tablet is "paired" once to a household (a kiosk_devices row holding the
// sha256 of a long-lived device secret). The device exchanges that secret for a
// short-lived *device* access token (sub `device:<id>`, claim kind:'device') that is
// allowed ONLY on the kiosk routes below. A device is not a person and has no
// identity row, so requireTenant rejects it on every data route automatically — the
// device/user split is enforced by the identity table, not scattered guards.
//
// Tapping a profile mints a REAL person-scoped session: we lazily ensure a `kiosk`
// identity (provider='kiosk', sub `kiosk:<personId>`) so the token resolves through
// the existing sub→identity→person→household path and all admin/role gates apply
// unchanged. PINs are optional per person (hashed with the same scrypt scheme as
// passwords) and brute-force throttled.
import { randomBytes } from 'node:crypto'
import createAPI, { type Request, type Response } from 'lambda-api'
import { query } from '../../platform/db'
import { AuthError } from '../../platform/auth'
import {
  mintAccess,
  issueRefresh,
  sha256,
  hashPassword,
  verifyPassword,
} from '../auth/auth'
import { requireTenant, requireAdmin, presentPerson, type PersonRow } from '../households/households'

type Api = ReturnType<typeof createAPI>

const CODE_TTL_MIN = 10
const PIN_RE = /^\d{4,8}$/
const PIN_MAX_ATTEMPTS = Number(process.env.KIOSK_PIN_MAX_ATTEMPTS) || 5
const PIN_LOCKOUT_SECONDS = Number(process.env.KIOSK_PIN_LOCKOUT_SECONDS) || 300

// Unambiguous human-typable code (no 0/O/1/I) for the pairing flow.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function genCode(len = 6): string {
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  return out
}
const genSecret = () => randomBytes(32).toString('base64url')

export interface DevicePrincipal {
  deviceId: string
  householdId: string
}

// A device token guard: only tokens minted by /api/kiosk/device/token pass. Verifies
// the device still exists + isn't revoked (a revoked device's JWT may still be valid).
export async function requireDevice(req: Request): Promise<DevicePrincipal> {
  const claims = req.principal?.claims
  if (claims?.kind !== 'device') throw new AuthError('Device token required', 403)
  const deviceId = String(req.principal!.sub).replace(/^device:/, '')
  const { rows } = await query<{ household_id: string }>(
    `select household_id from kiosk_devices where id = $1 and revoked_at is null`,
    [deviceId]
  )
  if (!rows[0]) throw new AuthError('Device revoked', 401)
  return { deviceId, householdId: rows[0].household_id }
}

export function registerKioskRoutes(api: Api): void {
  // ── pairing ──────────────────────────────────────────────────────────────────
  // Admin mints a short-lived, one-time pairing code (shown in Settings → Devices).
  api.post('/api/kiosk/pairing-code', async (req: Request) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const label = ((req.body ?? {}) as { label?: string }).label?.trim() || 'Kiosk'
    const code = genCode()
    await query(
      `insert into kiosk_pairing_codes (code, household_id, created_by) values ($1, $2, $3)`,
      [code, tenant.householdId, tenant.personId]
    )
    const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60_000).toISOString()
    return { code, label, expiresAt }
  })

  // Public: claim a pairing code → a new device + its secret. One-time + TTL-bounded.
  api.post('/api/kiosk/pair', async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as { code?: string; label?: string }
    const code = b.code?.trim().toUpperCase()
    if (!code) return res.status(400).json({ error: 'BadRequest', message: 'code is required' })
    const consumed = await query<{ household_id: string }>(
      `update kiosk_pairing_codes set consumed_at = now()
        where code = $1 and consumed_at is null and created_at > now() - ($2 || ' minutes')::interval
        returning household_id`,
      [code, String(CODE_TTL_MIN)]
    )
    const hh = consumed.rows[0]
    if (!hh) return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired pairing code.' })
    const device = await createDevice(hh.household_id, b.label, null)
    return res.status(201).json(device)
  })

  // Admin shortcut: turn the *current* (already-authenticated) device into a kiosk,
  // no code round-trip. Useful when the admin is signing in on the tablet itself.
  api.post('/api/kiosk/promote', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const label = ((req.body ?? {}) as { label?: string }).label
    const device = await createDevice(tenant.householdId, label, tenant.personId)
    return res.status(201).json(device)
  })

  // Public: exchange the long-lived device secret for a short-lived device token.
  // This is the device's "refresh" — it re-mints whenever its access token expires.
  api.post('/api/kiosk/device/token', async (req: Request, res: Response) => {
    const secret = ((req.body ?? {}) as { deviceSecret?: string }).deviceSecret
    if (!secret) return res.status(400).json({ error: 'BadRequest', message: 'deviceSecret is required' })
    const { rows } = await query<{ id: string; household_id: string }>(
      `update kiosk_devices set last_seen_at = now()
        where token_hash = $1 and revoked_at is null returning id, household_id`,
      [sha256(secret)]
    )
    const d = rows[0]
    if (!d) return res.status(401).json({ error: 'Unauthorized', message: 'Unknown or revoked device.' })
    const access = mintAccess(`device:${d.id}`, { kind: 'device', household_id: d.household_id })
    return res.status(200).json({ accessToken: access.token, expiresIn: access.expiresIn })
  })

  // ── profile picker (device-authed) ─────────────────────────────────────────────
  api.get('/api/kiosk/profiles', async (req: Request) => {
    const { householdId } = await requireDevice(req)
    const { rows } = await query<PersonRow & { has_pin: boolean }>(
      `select p.*, (p.pin_hash is not null) as has_pin
         from persons p
        where p.household_id = $1 and p.deleted_at is null and p.show_on_kiosk
        order by p.sort_order, p.created_at`,
      [householdId]
    )
    return { profiles: rows.map((r) => ({ ...presentPerson(r), hasPin: r.has_pin })) }
  })

  // Claim a profile → a real, person-scoped session. The crux of the feature.
  api.post('/api/kiosk/profile/:personId', async (req: Request, res: Response) => {
    const { householdId } = await requireDevice(req)
    const personId = req.params.personId ?? ''
    const { rows } = await query<PersonRow & { pin_hash: string | null; pin_failed_count: number; pin_locked_until: Date | null }>(
      `select * from persons
        where id = $1 and household_id = $2 and deleted_at is null and show_on_kiosk`,
      [personId, householdId]
    )
    const person = rows[0]
    if (!person) return res.status(404).json({ error: 'NotFound', message: 'profile not found' })

    if (person.pin_hash) {
      if (person.pin_locked_until && person.pin_locked_until.getTime() > Date.now()) {
        const retryAfter = Math.ceil((person.pin_locked_until.getTime() - Date.now()) / 1000)
        return res.status(429).json({ error: 'TooManyRequests', message: 'Too many attempts. Try again soon.', retryAfter })
      }
      const pin = ((req.body ?? {}) as { pin?: string }).pin ?? ''
      if (!verifyPassword(pin, person.pin_hash)) {
        const next = (person.pin_failed_count ?? 0) + 1
        if (next >= PIN_MAX_ATTEMPTS) {
          await query(
            `update persons set pin_failed_count = 0, pin_locked_until = now() + ($2 || ' seconds')::interval where id = $1`,
            [personId, String(PIN_LOCKOUT_SECONDS)]
          )
          return res.status(429).json({ error: 'TooManyRequests', message: 'Too many attempts. Try again soon.', retryAfter: PIN_LOCKOUT_SECONDS })
        }
        await query(`update persons set pin_failed_count = $2 where id = $1`, [personId, next])
        return res.status(401).json({ error: 'Unauthorized', message: 'Incorrect PIN.' })
      }
      // Correct PIN → clear throttle state.
      await query(`update persons set pin_failed_count = 0, pin_locked_until = null where id = $1`, [personId])
    }

    // Lazily ensure (or resurrect) the kiosk identity so the minted token resolves
    // through the existing sub→identity→person→household path.
    const sub = `kiosk:${personId}`
    await query(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email, email_verified, is_primary)
       values ($1, $2, 'kiosk', $3, null, false, false)
       on conflict (auth0_user_id) do update set deleted_at = null`,
      [householdId, personId, sub]
    )
    const access = mintAccess(sub)
    const refreshToken = await issueRefresh(personId, sub)
    return res.status(200).json({ accessToken: access.token, refreshToken, expiresIn: access.expiresIn, person: presentPerson(person) })
  })

  api.post('/api/kiosk/heartbeat', async (req: Request) => {
    const { deviceId } = await requireDevice(req)
    await query(`update kiosk_devices set last_seen_at = now() where id = $1`, [deviceId])
    return { ok: true }
  })

  // ── device management (admin, in Settings → Display & Kiosk) ─────────────────────
  api.get('/api/kiosk/devices', async (req: Request) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const { rows } = await query<{ id: string; label: string; last_seen_at: Date | null; created_at: Date }>(
      `select id, label, last_seen_at, created_at from kiosk_devices
        where household_id = $1 and revoked_at is null order by created_at`,
      [tenant.householdId]
    )
    return {
      devices: rows.map((r) => ({ id: r.id, label: r.label, lastSeenAt: r.last_seen_at, createdAt: r.created_at })),
    }
  })

  api.patch('/api/kiosk/devices/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const label = ((req.body ?? {}) as { label?: string }).label?.trim()
    if (!label) return res.status(400).json({ error: 'BadRequest', message: 'label is required' })
    const { rowCount } = await query(
      `update kiosk_devices set label = $3 where id = $1 and household_id = $2 and revoked_at is null`,
      [req.params.id, tenant.householdId, label]
    )
    if (!rowCount) return res.status(404).json({ error: 'NotFound', message: 'device not found' })
    return { ok: true }
  })

  api.delete('/api/kiosk/devices/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const { rowCount } = await query(
      `update kiosk_devices set revoked_at = now() where id = $1 and household_id = $2 and revoked_at is null`,
      [req.params.id, tenant.householdId]
    )
    if (!rowCount) return res.status(404).json({ error: 'NotFound', message: 'device not found' })
    return { ok: true }
  })

  // ── per-person PIN (self or admin) ─────────────────────────────────────────────
  api.put('/api/persons/:id/pin', async (req: Request, res: Response) => {
    const { personId, tenant } = await requirePinTarget(req, res)
    if (!personId) return // response already sent
    const pin = ((req.body ?? {}) as { pin?: string }).pin ?? ''
    if (!PIN_RE.test(pin)) return res.status(400).json({ error: 'BadRequest', message: 'PIN must be 4–8 digits' })
    await query(
      `update persons set pin_hash = $2, pin_failed_count = 0, pin_locked_until = null where id = $1 and household_id = $3`,
      [personId, hashPassword(pin), tenant.householdId]
    )
    return { ok: true }
  })

  api.delete('/api/persons/:id/pin', async (req: Request, res: Response) => {
    const { personId, tenant } = await requirePinTarget(req, res)
    if (!personId) return
    await query(
      `update persons set pin_hash = null, pin_failed_count = 0, pin_locked_until = null where id = $1 and household_id = $2`,
      [personId, tenant.householdId]
    )
    return { ok: true }
  })
}

// A new paired device + its one-time-returned secret (only ever shown here).
async function createDevice(householdId: string, label: string | undefined, createdBy: string | null) {
  const secret = genSecret()
  const { rows } = await query<{ id: string }>(
    `insert into kiosk_devices (household_id, label, token_hash, created_by_person_id)
     values ($1, $2, $3, $4) returning id`,
    [householdId, label?.trim() || 'Kiosk', sha256(secret), createdBy]
  )
  return { deviceId: rows[0].id, deviceSecret: secret, householdId }
}

// PIN endpoints are settable by the person themselves or an admin. Returns the
// target personId (validated to be in the caller's household) or sends a 4xx.
async function requirePinTarget(req: Request, res: Response): Promise<{ personId: string | null; tenant: Awaited<ReturnType<typeof requireTenant>> }> {
  const tenant = await requireTenant(req)
  const personId = req.params.id ?? ''
  if (tenant.personId !== personId) requireAdmin(tenant)
  const owns = await query(`select 1 from persons where id = $1 and household_id = $2 and deleted_at is null`, [personId, tenant.householdId])
  if (!owns.rows.length) {
    res.status(404).json({ error: 'NotFound', message: 'person not found' })
    return { personId: null, tenant }
  }
  return { personId, tenant }
}
