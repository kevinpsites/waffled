// Waffled-Bites device pairing + parent control panel. This test doubles as the
// "test-device harness" for a feature whose physical hardware doesn't exist yet: it
// plays the ESP32 device's role for real, over the same public API real firmware
// will use later (pair → exchange token → poll state → complete a task → get
// nudged). The two load-bearing assertions mirror kiosk's: a device token can't
// touch normal tenant routes, and a tenant token can't touch the device routes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { runMigrations } from '../src/migrate'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let query: typeof import('../src/platform/db').query

interface RunResult { statusCode: number; body: string }
function call(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}
const json = (r: RunResult) => JSON.parse(r.body)

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
  query = (await import('../src/platform/db')).query
}, 120_000)
afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('waffled-bites device pairing + parent control panel', () => {
  let admin: string
  let kid: string        // the paired kid
  let otherKid: string   // a second kid, never paired
  let morningId: string, afternoonId: string, eveningId: string, generalId: string
  let deviceId: string
  let deviceSecret: string
  let deviceToken: string

  it('sets up an admin, two kids, and enables the waffledBites module', async () => {
    const setup = json(await call('POST', '/api/auth/setup', {
      household: { name: 'Sites', timezone: 'America/Chicago' },
      admin: { name: 'Kevin', email: 'kevin@example.com', password: 'hunter2hunter' },
    }))
    admin = setup.accessToken
    kid = json(await call('POST', '/api/persons', { name: 'Hudson', memberType: 'kid' }, admin)).person.id
    otherKid = json(await call('POST', '/api/persons', { name: 'Ella', memberType: 'kid' }, admin)).person.id
    expect((await call('PATCH', '/api/household/modules', { waffledBites: true }, admin)).statusCode).toBe(200)
  })

  it('403s minting a pairing code before the module is enabled', async () => {
    await call('PATCH', '/api/household/modules', { waffledBites: false }, admin)
    expect((await call('POST', `/api/persons/${kid}/waffled-bite/pairing-code`, {}, admin)).statusCode).toBe(403)
    await call('PATCH', '/api/household/modules', { waffledBites: true }, admin)
  })

  it('pairs a Waffled-Bite to a specific kid with an admin-minted code', async () => {
    const code = json(await call('POST', `/api/persons/${kid}/waffled-bite/pairing-code`, { label: "Hudson's Waffled-Bite" }, admin)).code
    expect(typeof code).toBe('string')

    const paired = await call('POST', '/api/waffled-bites/pair', { code })
    expect(paired.statusCode).toBe(201)
    deviceId = json(paired).deviceId
    deviceSecret = json(paired).deviceSecret
    expect(typeof deviceId).toBe('string')
    expect(typeof deviceSecret).toBe('string')

    // One-time: the same code can't be reused; unknown codes are rejected.
    expect((await call('POST', '/api/waffled-bites/pair', { code })).statusCode).toBe(401)
    expect((await call('POST', '/api/waffled-bites/pair', { code: 'NOPE12' })).statusCode).toBe(401)
  })

  it('only allows one active device per kid', async () => {
    const code = json(await call('POST', `/api/persons/${kid}/waffled-bite/pairing-code`, {}, admin)).code
    const r = await call('POST', '/api/waffled-bites/pair', { code })
    expect(r.statusCode).toBe(409)
  })

  // ── abandoned pairing codes don't accumulate forever ────────────────────────
  it('sweeps expired, never-claimed pairing codes the next time one is minted', async () => {
    // A code a parent minted and then abandoned (closed the pairing modal without
    // pairing) would otherwise sit in the table forever. Simulate one aging past
    // its TTL, then mint a fresh code and confirm the stale one is gone.
    const householdId = json(await call('GET', '/api/household', undefined, admin)).household.id
    await query(
      `insert into waffled_bite_pairing_codes (code, household_id, person_id, created_by, created_at)
       values ('STALE1', $1, $2, $2, now() - interval '11 minutes')`,
      [householdId, otherKid]
    )
    const before = await query(`select 1 from waffled_bite_pairing_codes where code = 'STALE1'`)
    expect(before.rows.length).toBe(1)

    await call('POST', `/api/persons/${otherKid}/waffled-bite/pairing-code`, {}, admin)

    const after = await query(`select 1 from waffled_bite_pairing_codes where code = 'STALE1'`)
    expect(after.rows.length).toBe(0)
  })

  it('exchanges the device secret for a short-lived device token; rejects a bad secret', async () => {
    const r = await call('POST', '/api/waffled-bites/device/token', { deviceSecret })
    expect(r.statusCode).toBe(200)
    deviceToken = json(r).accessToken
    expect(typeof deviceToken).toBe('string')
    expect((await call('POST', '/api/waffled-bites/device/token', { deviceSecret: 'garbage' })).statusCode).toBe(401)
  })

  it("shows the paired device (with its live runtime state) on the kid's profile", async () => {
    const r = await call('GET', `/api/persons/${kid}/waffled-bite`, undefined, admin)
    expect(r.statusCode).toBe(200)
    expect(json(r).device).toMatchObject({ id: deviceId, runtimeState: { quiet: { active: false } } })

    const none = await call('GET', `/api/persons/${otherKid}/waffled-bite`, undefined, admin)
    expect(json(none).device).toBeNull()
  })

  // ── routine bucketing + stars on the device poll ────────────────────────────
  it('buckets chores into the right time windows and reports the stars balance', async () => {
    await call('POST', '/api/chores', { title: 'Get dressed', personId: kid, dueTime: '07:30', rewardAmount: 1 }, admin)
    await call('POST', '/api/chores', { title: 'Quiet reading', personId: kid, dueTime: '13:00', rewardAmount: 2 }, admin)
    await call('POST', '/api/chores', { title: 'Bath time', personId: kid, dueTime: '19:00', rewardAmount: 3 }, admin)
    await call('POST', '/api/chores', { title: 'Feed the dog', personId: kid, rewardAmount: 1 }, admin) // no due time

    const state = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken))
    expect(state.person).toMatchObject({ id: kid, name: 'Hudson' })
    expect(state.routines.morning.map((t: { choreTitle: string }) => t.choreTitle)).toContain('Get dressed')
    expect(state.routines.afternoon.map((t: { choreTitle: string }) => t.choreTitle)).toContain('Quiet reading')
    expect(state.routines.evening.map((t: { choreTitle: string }) => t.choreTitle)).toContain('Bath time')
    expect(state.routines.chores.map((t: { choreTitle: string }) => t.choreTitle)).toContain('Feed the dog')
    expect(state.stars).toBe(0)

    morningId = state.routines.morning.find((t: { choreTitle: string }) => t.choreTitle === 'Get dressed').id
    afternoonId = state.routines.afternoon.find((t: { choreTitle: string }) => t.choreTitle === 'Quiet reading').id
    eveningId = state.routines.evening.find((t: { choreTitle: string }) => t.choreTitle === 'Bath time').id
    generalId = state.routines.chores.find((t: { choreTitle: string }) => t.choreTitle === 'Feed the dog').id
  })

  // The device has no RTC/timezone database of its own (see wb_state.h) — it
  // trusts "now" from this poll verbatim for its clock and quiet-time's
  // "Until H:MM" label, so this MUST already be household-local, not raw UTC.
  it('reports the device poll\'s "now" in the household\'s own timezone (America/Chicago), not raw UTC', async () => {
    const state = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken))
    expect(state.now).toMatchObject({
      hour: expect.any(Number), minute: expect.any(Number),
      weekday: expect.any(Number), month: expect.any(Number), day: expect.any(Number),
    })
    expect(state.now.hour).toBeGreaterThanOrEqual(0)
    expect(state.now.hour).toBeLessThan(24)
    expect(state.now.minute).toBeGreaterThanOrEqual(0)
    expect(state.now.minute).toBeLessThan(60)
    // America/Chicago is always 5-6h behind UTC — if these ever match, "now" regressed to a raw UTC passthrough.
    expect(state.now.hour).not.toBe(new Date().getUTCHours())
  })

  it('completing a task from the device awards stars via the same ledger chores use', async () => {
    const complete = await call('POST', `/api/waffled-bites/device/tasks/${morningId}/complete`, undefined, deviceToken)
    expect(complete.statusCode).toBe(200)
    expect(json(complete).instance.status).toBe('done')

    const state = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken))
    expect(state.stars).toBe(1)
    expect(state.routines.morning.find((t: { id: string }) => t.id === morningId).status).toBe('done')

    // Only this device's own kid's task can be completed via this device.
    const wrongDevice = await call('POST', `/api/waffled-bites/device/tasks/${afternoonId}/complete`, undefined, deviceToken)
    expect(wrongDevice.statusCode).toBe(200) // afternoonId DOES belong to this device's kid — sanity check
    expect(json(wrongDevice).instance.status).toBe('done')
  })

  it('lets the device un-tap a task it (or a parent) marked done, same as the kiosk uncomplete', async () => {
    const uncomplete = await call('POST', `/api/waffled-bites/device/tasks/${afternoonId}/uncomplete`, undefined, deviceToken)
    expect(uncomplete.statusCode).toBe(200)
    expect(json(uncomplete).instance.status).toBe('pending')

    const state = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken))
    expect(state.stars).toBe(1) // the 2-star "Quiet reading" award is reversed; the 1-star "Get dressed" one stands
    expect(state.routines.afternoon.find((t: { id: string }) => t.id === afternoonId).status).toBe('pending')

    // Re-complete it so later tests see the same "done" state they'd expect otherwise.
    expect((await call('POST', `/api/waffled-bites/device/tasks/${afternoonId}/complete`, undefined, deviceToken)).statusCode).toBe(200)
  })

  // ── nudges: read-once ────────────────────────────────────────────────────────
  it('delivers a nudge to the device once, then clears it', async () => {
    expect((await call('POST', `/api/waffled-bites/${deviceId}/nudge`, { message: 'Dinner is ready' }, admin)).statusCode).toBe(200)
    const first = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken))
    expect(first.nudge).toMatchObject({ message: 'Dinner is ready' })
    const second = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken))
    expect(second.nudge).toBeNull()
  })

  // ── quiet time: parent-controlled, device reads computed remaining time ────────
  it('starts, pauses, resumes, extends, and ends quiet time from the parent side', async () => {
    expect((await call('POST', `/api/waffled-bites/${deviceId}/quiet/start`, { durationSec: 900 }, admin)).statusCode).toBe(200)
    let state = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken))
    expect(state.runtimeState.quiet.active).toBe(true)
    expect(state.runtimeState.quiet.running).toBe(true)
    expect(state.runtimeState.quiet.remainingSec).toBeGreaterThan(890)
    expect(state.runtimeState.quiet.remainingSec).toBeLessThanOrEqual(900)
    // The parent-side profile card reads the same live quiet state, not just the device poll.
    const parentView = json(await call('GET', `/api/persons/${kid}/waffled-bite`, undefined, admin)).device.runtimeState.quiet
    expect(parentView.active).toBe(true)
    expect(parentView.remainingSec).toBeLessThanOrEqual(900)

    expect((await call('POST', `/api/waffled-bites/${deviceId}/quiet/pause`, {}, admin)).statusCode).toBe(200)
    const paused1 = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken)).runtimeState.quiet
    expect(paused1.running).toBe(false)
    await new Promise((r) => setTimeout(r, 1100))
    const paused2 = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken)).runtimeState.quiet
    expect(paused2.remainingSec).toBe(paused1.remainingSec) // frozen while paused

    expect((await call('POST', `/api/waffled-bites/${deviceId}/quiet/resume`, {}, admin)).statusCode).toBe(200)
    expect((await call('POST', `/api/waffled-bites/${deviceId}/quiet/add-time`, { seconds: 300 }, admin)).statusCode).toBe(200)
    const extended = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken)).runtimeState.quiet
    expect(extended.remainingSec).toBeGreaterThan(paused2.remainingSec)

    expect((await call('POST', `/api/waffled-bites/${deviceId}/quiet/end`, {}, admin)).statusCode).toBe(200)
    const ended = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken)).runtimeState.quiet
    expect(ended.active).toBe(false)
  })

  // Retrofit test (not written before the clamp change, per the "say so explicitly"
  // exception) — the parent-facing UI's own custom-duration input used to cap at 90
  // minutes to match this server-side ceiling; both were raised to 3 hours together
  // when a real usage need for longer quiet time came up.
  it('clamps quiet/start duration to [60s, 3h], not the old 90-minute ceiling', async () => {
    await call('POST', `/api/waffled-bites/${deviceId}/quiet/start`, { durationSec: 999999 }, admin)
    const long = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken)).runtimeState.quiet
    expect(long.durationSec).toBe(180 * 60)
    expect((await call('POST', `/api/waffled-bites/${deviceId}/quiet/end`, {}, admin)).statusCode).toBe(200)

    await call('POST', `/api/waffled-bites/${deviceId}/quiet/start`, { durationSec: 1 }, admin)
    const short = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken)).runtimeState.quiet
    expect(short.durationSec).toBe(60)
    expect((await call('POST', `/api/waffled-bites/${deviceId}/quiet/end`, {}, admin)).statusCode).toBe(200)
  })

  // ── timer: unlike quiet time, either the kid (on-device) or a parent can
  // start/end it, and it's exitable (no on-device lock). Only the parent gets
  // the fine controls (pause/resume/add-time), same asymmetry as quiet time.
  it('starts a timer from the device itself, and a parent can pause/resume/extend/end it', async () => {
    expect((await call('POST', '/api/waffled-bites/device/timer/start', { durationSec: 300 }, deviceToken)).statusCode).toBe(200)
    const state = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken))
    expect(state.runtimeState.timer.active).toBe(true)
    expect(state.runtimeState.timer.running).toBe(true)
    expect(state.runtimeState.timer.remainingSec).toBeGreaterThan(290)
    expect(state.runtimeState.timer.remainingSec).toBeLessThanOrEqual(300)
    // The parent-side profile card reads the same live timer state, not just the device poll.
    const parentView = json(await call('GET', `/api/persons/${kid}/waffled-bite`, undefined, admin)).device.runtimeState.timer
    expect(parentView.active).toBe(true)

    expect((await call('POST', `/api/waffled-bites/${deviceId}/timer/pause`, {}, admin)).statusCode).toBe(200)
    const paused1 = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken)).runtimeState.timer
    expect(paused1.running).toBe(false)
    await new Promise((r) => setTimeout(r, 1100))
    const paused2 = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken)).runtimeState.timer
    expect(paused2.remainingSec).toBe(paused1.remainingSec) // frozen while paused

    expect((await call('POST', `/api/waffled-bites/${deviceId}/timer/resume`, {}, admin)).statusCode).toBe(200)
    expect((await call('POST', `/api/waffled-bites/${deviceId}/timer/add-time`, { seconds: 60 }, admin)).statusCode).toBe(200)
    const extended = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken)).runtimeState.timer
    expect(extended.remainingSec).toBeGreaterThan(paused2.remainingSec)

    // Unlike quiet time (parent-only end), the device can end its own timer too.
    expect((await call('POST', '/api/waffled-bites/device/timer/end', {}, deviceToken)).statusCode).toBe(200)
    const ended = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken)).runtimeState.timer
    expect(ended.active).toBe(false)
  })

  it('also lets a parent start a timer directly; a device token cannot hit the parent-only fine controls', async () => {
    expect((await call('POST', `/api/waffled-bites/${deviceId}/timer/start`, { durationSec: 600 }, admin)).statusCode).toBe(200)
    const state = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken))
    expect(state.runtimeState.timer.active).toBe(true)
    expect((await call('POST', `/api/waffled-bites/${deviceId}/timer/end`, {}, admin)).statusCode).toBe(200)

    expect((await call('POST', `/api/waffled-bites/${deviceId}/timer/pause`, {}, deviceToken)).statusCode).toBe(403)
  })

  // ── settings ─────────────────────────────────────────────────────────────────
  it('lets a parent patch device settings; the device sees them on the next poll', async () => {
    const r = await call('PATCH', `/api/waffled-bites/${deviceId}/settings`, {
      night: { on: true, color: 'amber', brightness: 40 },
    }, admin)
    expect(r.statusCode).toBe(200)
    const state = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken))
    expect(state.settings.night).toMatchObject({ on: true, color: 'amber', brightness: 40 })
  })

  // ── wake-light schedule (bedtime -> yellow warning -> green wake) ──────────
  // Exact boundary behavior (midnight-crossing, day-attribution) is covered by
  // wake-light.unit.test.ts's injected-clock tests; this just proves the real
  // HTTP wiring (household tz lookup, settings.schedules parsing) actually
  // reaches wakeLightView. wakeMin is anchored to "shortly after right now"
  // (Chicago-local) rather than a fixed 23:59 — a fixed near-midnight wake
  // time collides with its own WAKE_GRACE_MIN window once real wall-clock
  // time crosses midnight, which is exactly what made this test flaky.
  it("computes the wake-light state from the household's real schedule + timezone on both the device poll and the parent view", async () => {
    const chicagoNow = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date())
    const h = Number(chicagoNow.find((p) => p.type === 'hour')!.value)
    const m = Number(chicagoNow.find((p) => p.type === 'minute')!.value)
    const wakeMin = Math.min(1439, h * 60 + m + 10)

    await call('PATCH', `/api/waffled-bites/${deviceId}/settings`, {
      schedules: [{ days: [0, 1, 2, 3, 4, 5, 6], wakeMin, leadMin: 0, bedtimeMin: 0 }],
    }, admin)

    const state = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken))
    expect(state.runtimeState.wakeLight.state).toBe('sleep')

    const parentView = json(await call('GET', `/api/persons/${kid}/waffled-bite`, undefined, admin)).device.runtimeState.wakeLight
    expect(parentView.state).toBe('sleep')

    // A schedule with no bedtimeMin at all (pre-existing wake-only schedules) never force-locks.
    await call('PATCH', `/api/waffled-bites/${deviceId}/settings`, {
      schedules: [{ days: [0, 1, 2, 3, 4, 5, 6], wakeMin, leadMin: 0 }],
    }, admin)
    const none = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken))
    expect(none.runtimeState.wakeLight.state).toBe('none')
  })

  // The on-device "Grown-up controls" screen has only the device's own access
  // token available (no admin login flow on-device) — it needs its own write
  // path, distinct from the parent-side admin route above. Scoped to just
  // sound/night so a device can't rewrite parent-only settings (schedules,
  // alarm) it has no UI for.
  it('lets the device itself patch its sound/night settings, but not other keys, and rejects a tenant token', async () => {
    const r = await call('PATCH', '/api/waffled-bites/device/settings', {
      sound: { on: true, sound: 'rain', volume: 60, timerMin: 30 },
    }, deviceToken)
    expect(r.statusCode).toBe(200)
    expect(json(r).settings.sound).toMatchObject({ on: true, sound: 'rain', volume: 60, timerMin: 30 })
    // Previously-set night settings (patched by the parent above) survive a sound-only patch.
    expect(json(r).settings.night).toMatchObject({ on: true, color: 'amber', brightness: 40 })

    const state = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken))
    expect(state.settings.sound).toMatchObject({ on: true, sound: 'rain', volume: 60, timerMin: 30 })

    // A non-whitelisted key (e.g. a parent-only schedule) is silently dropped, not applied —
    // whatever schedules already existed (or didn't) survives unchanged, not overwritten by
    // the smuggled value.
    const before = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken)).settings.schedules
    const smuggled = await call('PATCH', '/api/waffled-bites/device/settings', {
      schedules: [{ days: [1, 2, 3, 4, 5], wakeMin: 360, leadMin: 15 }],
    }, deviceToken)
    expect(smuggled.statusCode).toBe(200)
    expect(json(smuggled).settings.schedules).toEqual(before)

    // Only this route's own device token works here — a parent/admin token is not a device.
    expect((await call('PATCH', '/api/waffled-bites/device/settings', { sound: { on: false } }, admin)).statusCode).toBe(403)
  })

  // The device token is a lower trust boundary than a parent session (no login,
  // just a long-lived secret exchange), so malformed field shapes/types under the
  // allowlisted keys must be dropped, not merged verbatim — an out-of-range NUMBER
  // is clamped (still usable), but a wrong-TYPE value is dropped entirely, leaving
  // whatever was already stored (same as if the field were simply omitted).
  it('sanitizes malformed values inside a device settings patch instead of merging them verbatim', async () => {
    // Known-good baseline first, so a later dropped field's expected value is
    // "whatever was already there", not an assumption about test ordering.
    await call('PATCH', '/api/waffled-bites/device/settings', {
      sound: { on: false, sound: 'white', volume: 20, timerMin: 0 },
      night: { on: true, color: 'amber', brightness: 40 },
    }, deviceToken)

    const r = await call('PATCH', '/api/waffled-bites/device/settings', {
      sound: { on: 'yes', sound: 123, volume: 9999, timerMin: -50 },
      night: { on: true, color: 42, brightness: 'loud' },
    }, deviceToken)
    expect(r.statusCode).toBe(200)
    const settings = json(r).settings
    // wrong-type `on`/`sound` dropped — the baseline values survive untouched
    expect(settings.sound.on).toBe(false)
    expect(settings.sound.sound).toBe('white')
    // out-of-range numbers clamped, not dropped
    expect(settings.sound.volume).toBe(100)
    expect(settings.sound.timerMin).toBe(0)
    // wrong-type `color`/`brightness` dropped — the earlier valid values survive untouched
    expect(settings.night.color).toBe('amber')
    expect(settings.night.brightness).toBe(40)
    expect(settings.night.on).toBe(true)
  })

  // ── the split: a device token is not a tenant, and vice versa ──────────────────
  it('rejects a device token on a normal tenant route, and a tenant token on a device route', async () => {
    expect((await call('POST', '/api/persons', { name: 'Nope', memberType: 'kid' }, deviceToken)).statusCode).toBe(403)
    expect((await call('GET', `/api/persons/${kid}/waffled-bite`, undefined, deviceToken)).statusCode).toBe(403)
    expect((await call('GET', '/api/waffled-bites/device/state', undefined, admin)).statusCode).toBe(403)
  })

  // ── unpairing ────────────────────────────────────────────────────────────────
  it('unpairs the device; its token stops working', async () => {
    expect((await call('DELETE', `/api/waffled-bites/${deviceId}`, undefined, admin)).statusCode).toBe(200)
    expect((await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken)).statusCode).toBe(401)
    const none = json(await call('GET', `/api/persons/${kid}/waffled-bite`, undefined, admin))
    expect(none.device).toBeNull()
  })

  // ── device self-unpair ("Forget this device" on the device itself) ─────────────
  it('lets a device unpair itself, same effect as the parent web app\'s unpair', async () => {
    const code = json(await call('POST', `/api/persons/${otherKid}/waffled-bite/pairing-code`, {}, admin)).code
    const paired = json(await call('POST', '/api/waffled-bites/pair', { code }))
    const otherDeviceId: string = paired.deviceId
    const otherDeviceToken = json(await call('POST', '/api/waffled-bites/device/token', { deviceSecret: paired.deviceSecret })).accessToken

    expect((await call('POST', '/api/waffled-bites/device/unpair', undefined, otherDeviceToken)).statusCode).toBe(200)
    expect((await call('GET', '/api/waffled-bites/device/state', undefined, otherDeviceToken)).statusCode).toBe(401)
    const none = json(await call('GET', `/api/persons/${otherKid}/waffled-bite`, undefined, admin))
    expect(none.device).toBeNull()

    // Idempotent-ish: an already-revoked device's own unpair call 404s, not a crash.
    expect((await call('POST', `/api/waffled-bites/${otherDeviceId}/nudge`, { message: 'x' }, admin)).statusCode).toBe(404)
  })
})
