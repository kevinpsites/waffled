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
import { DateTime } from 'luxon'
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
  uncompleteInstance,
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

// Type/range-checks the two shapes a device is allowed to write (sound/night)
// before deepMerge ever sees them — the device's bearer token is a lower trust
// boundary than a parent session (no login, just a long-lived secret exchange),
// so a field with the WRONG TYPE is dropped outright (deepMerge then leaves
// whatever was already stored, same as if the field were simply omitted from
// the patch), while a right-typed but out-of-range NUMBER is clamped rather
// than dropped, since it's still perfectly usable. No schema library in this
// codebase (no zod etc.) — matches the existing manual-validation style rather
// than adding one for a single route.
function sanitizeNumber(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : undefined
}
function sanitizeString(v: unknown, maxLen: number): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen ? v : undefined
}
function sanitizeDeviceSettingsPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (patch.sound && typeof patch.sound === 'object' && !Array.isArray(patch.sound)) {
    const s = patch.sound as Record<string, unknown>
    const soundOut: Record<string, unknown> = {}
    if (typeof s.on === 'boolean') soundOut.on = s.on
    const sound = sanitizeString(s.sound, 32)
    if (sound !== undefined) soundOut.sound = sound
    const volume = sanitizeNumber(s.volume, 0, 100)
    if (volume !== undefined) soundOut.volume = volume
    const timerMin = sanitizeNumber(s.timerMin, 0, 1440)
    if (timerMin !== undefined) soundOut.timerMin = timerMin
    if (Object.keys(soundOut).length) out.sound = soundOut
  }
  if (patch.night && typeof patch.night === 'object' && !Array.isArray(patch.night)) {
    const n = patch.night as Record<string, unknown>
    const nightOut: Record<string, unknown> = {}
    if (typeof n.on === 'boolean') nightOut.on = n.on
    const color = sanitizeString(n.color, 32)
    if (color !== undefined) nightOut.color = color
    const brightness = sanitizeNumber(n.brightness, 0, 100)
    if (brightness !== undefined) nightOut.brightness = brightness
    if (Object.keys(nightOut).length) out.night = nightOut
  }
  return out
}

// Shared shape for both quiet time and the generic timer — both are
// "started at T, runs for durationSec, optionally paused" countdowns, only
// their access rules differ (see countdownView/updateRuntimeState below).
interface CountdownState {
  active: boolean
  startedAt?: string
  durationSec?: number
  pausedAt?: string | null
  pauseAccumSec?: number
}
interface RuntimeState {
  quiet?: CountdownState
  timer?: CountdownState
  nudge?: { message: string; sentAt: string }
}

// Compute the device-facing view (running/remaining) from the stored
// timestamps — never trust a stored "remaining" number, it would drift.
function countdownView(q: CountdownState | undefined) {
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

// ── wake-light schedule (bedtime -> yellow warning -> green wake) ──────────
// The schedule (`settings.schedules`) has been stored and shown on the
// parent web app since day one, but until `bedtimeMin` was added, nothing —
// backend or device — ever computed a state from it; wakeMin/leadMin drove
// nothing. This is the first thing that reads it.
export interface WaffledBiteSchedule {
  days: number[] // 0 (Sun) - 6 (Sat) — the WAKE morning (see the day-attribution note below), not the bedtime evening
  wakeMin: number // minutes since local midnight the light turns green
  leadMin: number // minutes before wakeMin the light turns yellow
  bedtimeMin?: number // minutes since local midnight, the EVENING BEFORE wakeMin, sleep starts — absent on schedules created before this field existed, which simply never force-lock
}

export type WakeLightState = 'none' | 'sleep' | 'warn' | 'wake'
export interface WakeLightView {
  state: WakeLightState
  wakeAtHour?: number
  wakeAtMinute?: number
}

// How long the 'wake' (green, exitable) state holds after the actual wake
// instant before reverting to 'none' — bounded and write-free (no "kid
// tapped X" flag needed) so the schedule cleanly reverts to unforced for the
// rest of the day, and the NEXT night's bedtime re-locks from a 'none' start.
const WAKE_GRACE_MIN = 60

// Household-local {y,m,d,dow (0=Sun..6=Sat),minuteOfDay} for a given
// instant. Deliberately takes `now` as a parameter (not always `new Date()`,
// unlike chores.service's todayDate) so this — and everything built on it —
// can be tested at exact instants (8pm, 11:59pm, 12:01am), not just "close
// enough" real-clock windows.
function localParts(now: Date, tz: string) {
  const parts: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(now)) parts[p.type] = p.value
  const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  // Some ICU builds render midnight as "24" with hour12:false — normalize.
  const hour = parts.hour === '24' ? 0 : Number(parts.hour)
  return {
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    dow: WEEKDAY[parts.weekday], minuteOfDay: hour * 60 + Number(parts.minute),
  }
}

// The device's poll "now" field — see wb_state.h's header comment, the
// device has no RTC/timezone database of its own, so it trusts this
// verbatim for its clock and quiet-time's "Until H:MM" label. MUST be
// household-local, not raw UTC (was `new Date().toISOString()` — a real
// bug: the clock/label were silently off by the household's UTC offset).
function nowLocalView(tz: string) {
  const p = localParts(new Date(), tz)
  return { hour: Math.floor(p.minuteOfDay / 60), minute: p.minuteOfDay % 60, weekday: p.dow, month: p.m, day: p.d }
}

// Pure calendar-date arithmetic (UTC-anchored, no wall-clock/DST concerns —
// this is just "what date and weekday is N days from this date").
function addDays(y: number, m: number, d: number, days: number) {
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow: dt.getUTCDay() }
}

// Converts a household-local wall-clock date+time to the actual UTC instant.
// luxon resolves DST correctly (a single-pass "guess the UTC offset, then
// subtract it" approach — what this used to hand-roll — is off by the DST
// delta for any wall-clock time within about an hour of a transition; see
// recurrence.ts's toFloating/fromFloating for the same pattern applied to
// calendar recurrence).
function localToUtcMs(y: number, m: number, d: number, minuteOfDay: number, tz: string): number {
  return DateTime.fromObject({ year: y, month: m, day: d, hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 }, { zone: tz }).toMillis()
}

// For each schedule, tries each of the 3 candidate wake-dates around `now`'s
// local calendar date (yesterday/today/tomorrow) — this sidesteps ever
// having to decide "which single day is 'today's governing wake-day'" by
// hand: whichever candidate's bedtime->wake range actually contains `now`,
// if any, wins. `days` marks the WAKE morning (matches the parent web app's
// "🟢 Okay to get up" label), so a schedule's Sunday-night bedtime is
// governed by Monday being in `days`, not Sunday — a real decision, not an
// oversight; a parent picking "school days" (Mon-Fri) is choosing Sun-Thu
// nights, which the web app's field hint should say explicitly.
//
// Two schedules CAN genuinely overlap (the web panel's "+ Add another
// schedule" has no ordering UI) — when they do, the more SPECIFIC one wins
// (fewest days-of-week), so a one-off single-day override beats a standing
// every-day/school-days rule regardless of which was added first. Ties
// (equal specificity) keep whichever is found first.
export function wakeLightView(schedules: WaffledBiteSchedule[], now: Date, tz: string): WakeLightView {
  const nowMs = now.getTime()
  const local = localParts(now, tz)
  let best: (WakeLightView & { specificity: number }) | null = null

  for (const sch of schedules) {
    if (sch.bedtimeMin == null) continue
    for (const dayOffset of [-1, 0, 1]) {
      const wakeDate = addDays(local.y, local.m, local.d, dayOffset)
      if (!sch.days.includes(wakeDate.dow)) continue
      const bedDate = addDays(wakeDate.y, wakeDate.m, wakeDate.d, -1)
      const bedtimeMs = localToUtcMs(bedDate.y, bedDate.m, bedDate.d, sch.bedtimeMin, tz)
      const warnMs = localToUtcMs(wakeDate.y, wakeDate.m, wakeDate.d, Math.max(0, sch.wakeMin - sch.leadMin), tz)
      const wakeMs = localToUtcMs(wakeDate.y, wakeDate.m, wakeDate.d, sch.wakeMin, tz)
      const graceEndMs = wakeMs + WAKE_GRACE_MIN * 60_000

      let state: WakeLightState | null = null
      if (nowMs >= bedtimeMs && nowMs < warnMs) state = 'sleep'
      else if (nowMs >= warnMs && nowMs < wakeMs) state = 'warn'
      else if (nowMs >= wakeMs && nowMs < graceEndMs) state = 'wake'
      if (!state) continue

      const specificity = sch.days.length
      if (!best || specificity < best.specificity) {
        best = { state, wakeAtHour: Math.floor(sch.wakeMin / 60), wakeAtMinute: sch.wakeMin % 60, specificity }
      }
    }
  }
  if (!best) return { state: 'none' }
  const { specificity: _specificity, ...view } = best
  return view
}

function schedulesOf(settings: unknown): WaffledBiteSchedule[] {
  const s = (settings ?? {}) as { schedules?: unknown }
  return Array.isArray(s.schedules) ? (s.schedules as WaffledBiteSchedule[]) : []
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
    // Opportunistic cleanup: a code a parent minted then abandoned (closed the
    // pairing modal, never claimed it) would otherwise sit forever — sweep any
    // code past its TTL every time a new one is minted, so the table never grows
    // with dead rows. Cheap (this table stays tiny) and needs no separate job.
    await query(`delete from waffled_bite_pairing_codes where created_at < now() - ($1 || ' minutes')::interval`, [String(CODE_TTL_MIN)])
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
    if (!d) return { device: null }
    const tz = await householdTz(tenant.householdId)
    return {
      device: {
        id: d.id,
        label: d.label,
        settings: d.settings,
        runtimeState: {
          quiet: countdownView(d.runtime_state?.quiet),
          timer: countdownView(d.runtime_state?.timer),
          wakeLight: wakeLightView(schedulesOf(d.settings), new Date(), tz),
        },
        lastSeenAt: d.last_seen_at,
        createdAt: d.created_at,
      },
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
      now: nowLocalView(tz),
      person: { id: device.personId, name: person?.name, avatarEmoji: person?.avatar_emoji ?? null, colorHex: person?.color_hex ?? null },
      stars: Number(balance.rows[0]?.balance ?? 0),
      routines,
      settings: deviceRow?.settings ?? {},
      runtimeState: {
        quiet: countdownView(deviceRow?.runtime_state?.quiet),
        timer: countdownView(deviceRow?.runtime_state?.timer),
        wakeLight: wakeLightView(schedulesOf(deviceRow?.settings), new Date(), tz),
      },
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

  // Un-tap: reverses an accidental (or since-changed-their-mind) tap, same
  // action the kiosk's own uncomplete already offers any household member —
  // the device route was just never wired up for it. Mirrors /complete
  // above exactly (same ownership check, same synthetic tenant).
  api.post('/api/waffled-bites/device/tasks/:instanceId/uncomplete', async (req: Request, res: Response) => {
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
    const inst = await uncompleteInstance(syntheticTenant, instanceId)
    if (!inst) return res.status(404).json({ error: 'NotFound', message: 'task not found' })
    return { instance: presentInstance(inst) }
  })

  // The on-device "Grown-up controls" screen only has the device's own access
  // token available (no admin login flow on-device) — a separate, narrower write
  // path than the parent-side route below. Allowlisted to sound/night only, so a
  // device can't rewrite parent-only settings (schedules, alarm) it has no UI for.
  const DEVICE_WRITABLE_SETTINGS_KEYS = ['sound', 'night'] as const
  api.patch('/api/waffled-bites/device/settings', async (req: Request, res: Response) => {
    const device = await requireWaffledBiteDevice(req)
    const patch = (req.body ?? {}) as Record<string, unknown>
    const filtered: Record<string, unknown> = {}
    for (const key of DEVICE_WRITABLE_SETTINGS_KEYS) if (key in patch) filtered[key] = patch[key]
    const sanitized = sanitizeDeviceSettingsPatch(filtered)
    const deviceRow = await loadDeviceRow(device.householdId, device.deviceId)
    if (!deviceRow) return res.status(404).json({ error: 'NotFound', message: 'device not found' })
    const next = deepMerge(deviceRow.settings ?? {}, sanitized)
    await query(`update waffled_bite_devices set settings = $2::jsonb where id = $1`, [device.deviceId, JSON.stringify(next)])
    return { settings: next }
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

  // ── quiet time + timer + nudge (parent side, any household member) ──────────
  // Shared by both countdowns — quiet and timer store/compute identically
  // (see CountdownState/countdownView above), only which routes exist and
  // who's allowed to hit them differs.
  async function updateRuntimeState(
    tenant: Tenant, deviceIdParam: string, res: Response, key: 'quiet' | 'timer', fn: (q: CountdownState) => CountdownState
  ): Promise<unknown> {
    const device = await loadDeviceRow(tenant.householdId, deviceIdParam)
    if (!device) return res.status(404).json({ error: 'NotFound', message: 'device not found' })
    const current: CountdownState = device.runtime_state?.[key] ?? { active: false }
    const next = fn(current)
    const nextState = { ...(device.runtime_state ?? {}), [key]: next }
    await query(`update waffled_bite_devices set runtime_state = $2::jsonb where id = $1`, [device.id, JSON.stringify(nextState)])
    return { ok: true }
  }
  const updateQuiet = (tenant: Tenant, id: string, res: Response, fn: (q: CountdownState) => CountdownState) =>
    updateRuntimeState(tenant, id, res, 'quiet', fn)
  const updateTimer = (tenant: Tenant, id: string, res: Response, fn: (q: CountdownState) => CountdownState) =>
    updateRuntimeState(tenant, id, res, 'timer', fn)

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

  // Timer: unlike quiet time, a parent can ALSO start/end one directly (a kid
  // starts/ends their own via the device-authed routes below) — the fine
  // controls (pause/resume/add-time) stay parent-only either way, same as
  // quiet time, since a kid navigating away and back shouldn't need them.
  api.post('/api/waffled-bites/:id/timer/start', tenantRoute(async (tenant, req: Request, res: Response) => {
    const durationSec = Math.max(60, Math.min(90 * 60, Number((req.body as { durationSec?: number })?.durationSec) || 5 * 60))
    return updateTimer(tenant, req.params.id ?? '', res, () => ({
      active: true, startedAt: new Date().toISOString(), durationSec, pausedAt: null, pauseAccumSec: 0,
    }))
  }))

  api.post('/api/waffled-bites/:id/timer/pause', tenantRoute(async (tenant, req: Request, res: Response) =>
    updateTimer(tenant, req.params.id ?? '', res, (q) => (q.active && !q.pausedAt ? { ...q, pausedAt: new Date().toISOString() } : q))
  ))

  api.post('/api/waffled-bites/:id/timer/resume', tenantRoute(async (tenant, req: Request, res: Response) =>
    updateTimer(tenant, req.params.id ?? '', res, (q) => {
      if (!q.active || !q.pausedAt) return q
      const pausedMs = Date.now() - Date.parse(q.pausedAt)
      return { ...q, pausedAt: null, pauseAccumSec: (q.pauseAccumSec ?? 0) + pausedMs / 1000 }
    })
  ))

  api.post('/api/waffled-bites/:id/timer/add-time', tenantRoute(async (tenant, req: Request, res: Response) => {
    const seconds = Number((req.body as { seconds?: number })?.seconds) || 300
    return updateTimer(tenant, req.params.id ?? '', res, (q) => (q.active ? { ...q, durationSec: (q.durationSec ?? 0) + seconds } : q))
  }))

  api.post('/api/waffled-bites/:id/timer/end', tenantRoute(async (tenant, req: Request, res: Response) =>
    updateTimer(tenant, req.params.id ?? '', res, () => ({ active: false }))
  ))

  // ── timer (device side) ──────────────────────────────────────────────────────
  // The kid can start/end their own timer right from the device — unlike
  // quiet time, this one is exitable and not parent-locked. Pause/resume/
  // add-time stay parent-only (routes above), matching quiet time's asymmetry.
  async function updateTimerAsDevice(device: WaffledBiteDevicePrincipal, fn: (q: CountdownState) => CountdownState): Promise<unknown> {
    const deviceRow = await loadDeviceRow(device.householdId, device.deviceId)
    const current: CountdownState = deviceRow?.runtime_state?.timer ?? { active: false }
    const next = fn(current)
    const nextState = { ...(deviceRow?.runtime_state ?? {}), timer: next }
    await query(`update waffled_bite_devices set runtime_state = $2::jsonb where id = $1`, [device.deviceId, JSON.stringify(nextState)])
    return { ok: true }
  }

  api.post('/api/waffled-bites/device/timer/start', async (req: Request) => {
    const device = await requireWaffledBiteDevice(req)
    const durationSec = Math.max(60, Math.min(90 * 60, Number((req.body as { durationSec?: number })?.durationSec) || 5 * 60))
    return updateTimerAsDevice(device, () => ({
      active: true, startedAt: new Date().toISOString(), durationSec, pausedAt: null, pauseAccumSec: 0,
    }))
  })

  api.post('/api/waffled-bites/device/timer/end', async (req: Request) => {
    const device = await requireWaffledBiteDevice(req)
    return updateTimerAsDevice(device, () => ({ active: false }))
  })

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

  // ── unpair (device side — "Forget this device" on the device itself) ───────
  // Same revocation the admin route above does, just self-scoped via device
  // auth instead of a parent's admin token — the device's own "Forget this
  // device" flow calls this so a forgotten device is ACTUALLY unpaired
  // server-side, not just locally forgetful of its own secret.
  api.post('/api/waffled-bites/device/unpair', async (req: Request, res: Response) => {
    const device = await requireWaffledBiteDevice(req)
    await query(
      `update waffled_bite_devices set revoked_at = now() where id = $1 and revoked_at is null`,
      [device.deviceId]
    )
    return { ok: true }
  })
}
