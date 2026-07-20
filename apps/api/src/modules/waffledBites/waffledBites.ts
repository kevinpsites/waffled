// Waffled-Bites: a kid-owned 7" companion device, paired one-per-child from
// Family → tap a kid. Modeled directly on the kiosk pairing pattern
// (modules/kiosk/kiosk.ts) — a waffled_bite_devices row holds the sha256 of a
// long-lived device secret; the device exchanges it for a short-lived device
// token (sub `waffled-bite-device:<id>`, claim kind:'waffled-bite-device') that
// only the device routes below accept. Unlike kiosk's shared-tablet device, this
// one is fixed to a single person_id at pairing time — no profile picker.
//
// No push/WebSockets: the device polls GET /api/waffled-bites/device/state on a
// ~5s cadence. `runtime_state` (quiet timer, pending nudge) stores timestamps, not
// ticking counters, so remaining time is always computed on read.
import { randomBytes } from 'node:crypto'
import createAPI, { type Request, type Response } from 'lambda-api'
import { query } from '../../platform/db'
import { AuthError } from '../../platform/auth'
import { moduleRoutes } from '../../platform/route-guards'
import { mintAccess, sha256 } from '../auth/auth'
import { type Tenant } from '../households/households'
import { getDefaultCurrencyKey } from '../currencies/currencies'
import {
  listTodayInstances,
  ensureTodayInstances,
  todayDate,
  householdTz,
  completeInstance,
  presentInstance,
  ProofRequiredError,
} from '../chores/chores.service'

type Api = ReturnType<typeof createAPI>

const CODE_TTL_MIN = 10
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function genCode(len = 6): string {
  const bytes = randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
  return out
}
const genSecret = () => randomBytes(32).toString('base64url')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const { tenantRoute, adminRoute } = moduleRoutes('waffledBites')

export interface WaffledBiteDevicePrincipal {
  deviceId: string
  householdId: string
  personId: string
  label: string
}

// A device token guard, mirroring kiosk's requireDevice: verifies the device still
// exists and isn't revoked (a revoked device's JWT may still be unexpired).
export async function requireWaffledBiteDevice(req: Request): Promise<WaffledBiteDevicePrincipal> {
  const claims = req.principal?.claims
  if (claims?.kind !== 'waffled-bite-device') throw new AuthError('Device token required', 403)
  const deviceId = String(req.principal!.sub).replace(/^waffled-bite-device:/, '')
  const { rows } = await query<{ household_id: string; person_id: string; label: string }>(
    `select household_id, person_id, label from waffled_bite_devices where id = $1 and revoked_at is null`,
    [deviceId]
  )
  if (!rows[0]) throw new AuthError('Device revoked', 401)
  return { deviceId, householdId: rows[0].household_id, personId: rows[0].person_id, label: rows[0].label }
}

// Recursive merge for jsonb settings patches — nested objects merge key-by-key
// (e.g. patching `{night:{brightness:50}}` doesn't clobber `night.color`);
// anything else (arrays, primitives) replaces outright.
function deepMerge(base: unknown, patch: unknown): unknown {
  if (
    base && patch &&
    typeof base === 'object' && typeof patch === 'object' &&
    !Array.isArray(base) && !Array.isArray(patch)
  ) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) out[k] = deepMerge(out[k], v)
    return out
  }
  return patch
}

interface QuietState {
  active: boolean
  startedAt?: string
  durationSec?: number
  pausedAt?: string | null
  pauseAccumSec?: number
}
interface RuntimeState {
  quiet?: QuietState
  nudge?: { message: string; sentAt: string }
}

// Compute the device-facing quiet-time view (running/remaining) from the stored
// timestamps — never trust a stored "remaining" number, it would drift.
function quietView(q: QuietState | undefined) {
  if (!q?.active || !q.startedAt || q.durationSec == null) {
    return { active: false, running: false, remainingSec: 0, durationSec: 0 }
  }
  const running = !q.pausedAt
  const now = Date.now()
  const started = Date.parse(q.startedAt)
  const elapsedMs = (running ? now : Date.parse(q.pausedAt!)) - started
  const elapsedSec = elapsedMs / 1000 - (q.pauseAccumSec ?? 0)
  const remainingSec = Math.max(0, Math.round(q.durationSec - elapsedSec))
  return { active: true, running, remainingSec, durationSec: q.durationSec }
}

async function loadDeviceRow(householdId: string, deviceId: string) {
  const { rows } = await query<{ id: string; person_id: string; settings: unknown; runtime_state: RuntimeState }>(
    `select id, person_id, settings, runtime_state from waffled_bite_devices
      where id = $1 and household_id = $2 and revoked_at is null`,
    [deviceId, householdId]
  )
  return rows[0] ?? null
}

const WINDOWS: Array<{ key: 'morning' | 'afternoon' | 'evening'; start: string; end: string }> = [
  { key: 'morning', start: '06:00', end: '11:00' },
  { key: 'afternoon', start: '11:00', end: '16:00' },
  { key: 'evening', start: '16:00', end: '22:00' },
]
function bucketOf(dueTime: string | null): 'morning' | 'afternoon' | 'evening' | 'chores' {
  if (!dueTime) return 'chores'
  for (const w of WINDOWS) if (dueTime >= w.start && dueTime < w.end) return w.key
  return 'chores'
}

export function registerWaffledBiteRoutes(api: Api): void {
  // ── pairing (parent side) ─────────────────────────────────────────────────────
  api.post('/api/persons/:id/waffled-bite/pairing-code', adminRoute(async (tenant, req: Request, res: Response) => {
    const personId = req.params.id ?? ''
    const owns = await query(`select 1 from persons where id = $1 and household_id = $2 and deleted_at is null`, [personId, tenant.householdId])
    if (!owns.rows.length) return res.status(404).json({ error: 'NotFound', message: 'person not found' })
    const code = genCode()
    await query(
      `insert into waffled_bite_pairing_codes (code, household_id, person_id, created_by) values ($1, $2, $3, $4)`,
      [code, tenant.householdId, personId, tenant.personId]
    )
    const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60_000).toISOString()
    return { code, personId, expiresAt }
  }))

  api.get('/api/persons/:id/waffled-bite', tenantRoute(async (tenant, req: Request, res: Response) => {
    const personId = req.params.id ?? ''
    const owns = await query(`select 1 from persons where id = $1 and household_id = $2 and deleted_at is null`, [personId, tenant.householdId])
    if (!owns.rows.length) return res.status(404).json({ error: 'NotFound', message: 'person not found' })
    const { rows } = await query<{ id: string; label: string; settings: unknown; runtime_state: RuntimeState; last_seen_at: Date | null; created_at: Date }>(
      `select id, label, settings, runtime_state, last_seen_at, created_at from waffled_bite_devices
        where person_id = $1 and household_id = $2 and revoked_at is null`,
      [personId, tenant.householdId]
    )
    const d = rows[0]
    return {
      device: d
        ? {
            id: d.id,
            label: d.label,
            settings: d.settings,
            runtimeState: { quiet: quietView(d.runtime_state?.quiet) },
            lastSeenAt: d.last_seen_at,
            createdAt: d.created_at,
          }
        : null,
    }
  }))

  // Public: claim a pairing code → a new device + its secret (one-time-shown).
  api.post('/api/waffled-bites/pair', async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as { code?: string; label?: string }
    const code = b.code?.trim().toUpperCase()
    if (!code) return res.status(400).json({ error: 'BadRequest', message: 'code is required' })
    const consumed = await query<{ household_id: string; person_id: string }>(
      `update waffled_bite_pairing_codes set consumed_at = now()
        where code = $1 and consumed_at is null and created_at > now() - ($2 || ' minutes')::interval
        returning household_id, person_id`,
      [code, String(CODE_TTL_MIN)]
    )
    const claim = consumed.rows[0]
    if (!claim) return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired pairing code.' })
    const secret = genSecret()
    try {
      const { rows } = await query<{ id: string }>(
        `insert into waffled_bite_devices (household_id, person_id, label, token_hash)
         values ($1, $2, $3, $4) returning id`,
        [claim.household_id, claim.person_id, b.label?.trim() || 'Waffled-Bite', sha256(secret)]
      )
      return res.status(201).json({ deviceId: rows[0].id, deviceSecret: secret, householdId: claim.household_id, personId: claim.person_id })
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return res.status(409).json({ error: 'Conflict', message: 'This kid already has a paired Waffled-Bite.' })
      }
      throw err
    }
  })

  // Public: exchange the long-lived device secret for a short-lived device token.
  api.post('/api/waffled-bites/device/token', async (req: Request, res: Response) => {
    const secret = ((req.body ?? {}) as { deviceSecret?: string }).deviceSecret
    if (!secret) return res.status(400).json({ error: 'BadRequest', message: 'deviceSecret is required' })
    const { rows } = await query<{ id: string; household_id: string; person_id: string }>(
      `update waffled_bite_devices set last_seen_at = now()
        where token_hash = $1 and revoked_at is null returning id, household_id, person_id`,
      [sha256(secret)]
    )
    const d = rows[0]
    if (!d) return res.status(401).json({ error: 'Unauthorized', message: 'Unknown or revoked device.' })
    const access = mintAccess(`waffled-bite-device:${d.id}`, { kind: 'waffled-bite-device', household_id: d.household_id, person_id: d.person_id })
    return res.status(200).json({ accessToken: access.token, expiresIn: access.expiresIn })
  })

  // ── device poll (device-authed) ─────────────────────────────────────────────
  api.get('/api/waffled-bites/device/state', async (req: Request) => {
    const device = await requireWaffledBiteDevice(req)
    const tz = await householdTz(device.householdId)
    const date = todayDate(tz)
    await ensureTodayInstances(device.householdId, date)
    const instances = await listTodayInstances(device.householdId, date, tz, { streaks: false, personId: device.personId })

    const routines: Record<'morning' | 'afternoon' | 'evening' | 'chores', unknown[]> = {
      morning: [], afternoon: [], evening: [], chores: [],
    }
    for (const inst of instances) {
      routines[bucketOf(inst.dueTime)].push({
        id: inst.id,
        choreId: inst.choreId,
        choreTitle: inst.choreTitle,
        emoji: inst.emoji,
        dueTime: inst.dueTime,
        status: inst.status,
        rewardAmount: inst.rewardAmount,
        rewardCurrency: inst.rewardCurrency,
      })
    }

    const [personRow, deviceRow, currency] = await Promise.all([
      query<{ name: string; avatar_emoji: string | null; color_hex: string | null }>(
        `select name, avatar_emoji, color_hex from persons where id = $1`,
        [device.personId]
      ),
      loadDeviceRow(device.householdId, device.deviceId),
      getDefaultCurrencyKey(device.householdId),
    ])
    const person = personRow.rows[0]
    const balance = await query<{ balance: string | null }>(
      `select balance from v_person_balances where person_id = $1 and currency = $2`,
      [device.personId, currency]
    )

    // Read-once: hand back any pending nudge, then clear it in the same request.
    const nudge = deviceRow?.runtime_state?.nudge ?? null
    if (nudge) {
      await query(
        `update waffled_bite_devices set runtime_state = runtime_state - 'nudge' where id = $1`,
        [device.deviceId]
      )
    }

    return {
      now: new Date().toISOString(),
      person: { id: device.personId, name: person?.name, avatarEmoji: person?.avatar_emoji ?? null, colorHex: person?.color_hex ?? null },
      stars: Number(balance.rows[0]?.balance ?? 0),
      routines,
      settings: deviceRow?.settings ?? {},
      runtimeState: { quiet: quietView(deviceRow?.runtime_state?.quiet) },
      nudge,
    }
  })

  api.post('/api/waffled-bites/device/tasks/:instanceId/complete', async (req: Request, res: Response) => {
    const device = await requireWaffledBiteDevice(req)
    const instanceId = req.params.instanceId ?? ''
    if (!UUID_RE.test(instanceId)) return res.status(404).json({ error: 'NotFound', message: 'task not found' })
    const owns = await query(
      `select 1 from chore_instances where id = $1 and household_id = $2 and person_id = $3 and deleted_at is null`,
      [instanceId, device.householdId, device.personId]
    )
    if (!owns.rows.length) return res.status(404).json({ error: 'NotFound', message: 'task not found' })
    const syntheticTenant: Tenant = {
      sub: `waffled-bite-device:${device.deviceId}`,
      personId: device.personId,
      householdId: device.householdId,
      isAdmin: false,
      memberType: 'kid',
    }
    try {
      const inst = await completeInstance(syntheticTenant, instanceId)
      if (!inst) return res.status(404).json({ error: 'NotFound', message: 'task not found' })
      return { instance: presentInstance(inst) }
    } catch (err) {
      if (err instanceof ProofRequiredError) {
        return res.status(422).json({ error: 'ProofRequired', message: err.message })
      }
      throw err
    }
  })

  // ── settings (parent side, admin) ───────────────────────────────────────────
  api.patch('/api/waffled-bites/:id/settings', adminRoute(async (tenant, req: Request, res: Response) => {
    const device = await loadDeviceRow(tenant.householdId, req.params.id ?? '')
    if (!device) return res.status(404).json({ error: 'NotFound', message: 'device not found' })
    const patch = (req.body ?? {}) as Record<string, unknown>
    const next = deepMerge(device.settings ?? {}, patch)
    await query(`update waffled_bite_devices set settings = $2::jsonb where id = $1`, [device.id, JSON.stringify(next)])
    return { settings: next }
  }))

  // ── quiet time + nudge (parent side, any household member) ──────────────────
  async function updateQuiet(tenant: Tenant, deviceIdParam: string, res: Response, fn: (q: QuietState) => QuietState): Promise<unknown> {
    const device = await loadDeviceRow(tenant.householdId, deviceIdParam)
    if (!device) return res.status(404).json({ error: 'NotFound', message: 'device not found' })
    const current: QuietState = device.runtime_state?.quiet ?? { active: false }
    const next = fn(current)
    const nextState = { ...(device.runtime_state ?? {}), quiet: next }
    await query(`update waffled_bite_devices set runtime_state = $2::jsonb where id = $1`, [device.id, JSON.stringify(nextState)])
    return { ok: true }
  }

  api.post('/api/waffled-bites/:id/quiet/start', tenantRoute(async (tenant, req: Request, res: Response) => {
    const durationSec = Math.max(60, Math.min(90 * 60, Number((req.body as { durationSec?: number })?.durationSec) || 15 * 60))
    return updateQuiet(tenant, req.params.id ?? '', res, () => ({
      active: true, startedAt: new Date().toISOString(), durationSec, pausedAt: null, pauseAccumSec: 0,
    }))
  }))

  api.post('/api/waffled-bites/:id/quiet/pause', tenantRoute(async (tenant, req: Request, res: Response) =>
    updateQuiet(tenant, req.params.id ?? '', res, (q) => (q.active && !q.pausedAt ? { ...q, pausedAt: new Date().toISOString() } : q))
  ))

  api.post('/api/waffled-bites/:id/quiet/resume', tenantRoute(async (tenant, req: Request, res: Response) =>
    updateQuiet(tenant, req.params.id ?? '', res, (q) => {
      if (!q.active || !q.pausedAt) return q
      const pausedMs = Date.now() - Date.parse(q.pausedAt)
      return { ...q, pausedAt: null, pauseAccumSec: (q.pauseAccumSec ?? 0) + pausedMs / 1000 }
    })
  ))

  api.post('/api/waffled-bites/:id/quiet/add-time', tenantRoute(async (tenant, req: Request, res: Response) => {
    const seconds = Number((req.body as { seconds?: number })?.seconds) || 300
    return updateQuiet(tenant, req.params.id ?? '', res, (q) => (q.active ? { ...q, durationSec: (q.durationSec ?? 0) + seconds } : q))
  }))

  api.post('/api/waffled-bites/:id/quiet/end', tenantRoute(async (tenant, req: Request, res: Response) =>
    updateQuiet(tenant, req.params.id ?? '', res, () => ({ active: false }))
  ))

  api.post('/api/waffled-bites/:id/nudge', tenantRoute(async (tenant, req: Request, res: Response) => {
    const message = ((req.body ?? {}) as { message?: string }).message?.trim()
    if (!message) return res.status(400).json({ error: 'BadRequest', message: 'message is required' })
    const device = await loadDeviceRow(tenant.householdId, req.params.id ?? '')
    if (!device) return res.status(404).json({ error: 'NotFound', message: 'device not found' })
    const nextState = { ...(device.runtime_state ?? {}), nudge: { message, sentAt: new Date().toISOString() } }
    await query(`update waffled_bite_devices set runtime_state = $2::jsonb where id = $1`, [device.id, JSON.stringify(nextState)])
    return { ok: true }
  }))

  // ── unpair (parent side, admin) ─────────────────────────────────────────────
  api.delete('/api/waffled-bites/:id', adminRoute(async (tenant, req: Request, res: Response) => {
    const { rowCount } = await query(
      `update waffled_bite_devices set revoked_at = now() where id = $1 and household_id = $2 and revoked_at is null`,
      [req.params.id, tenant.householdId]
    )
    if (!rowCount) return res.status(404).json({ error: 'NotFound', message: 'device not found' })
    return { ok: true }
  }))
}
