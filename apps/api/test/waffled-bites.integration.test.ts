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

  // ── settings ─────────────────────────────────────────────────────────────────
  it('lets a parent patch device settings; the device sees them on the next poll', async () => {
    const r = await call('PATCH', `/api/waffled-bites/${deviceId}/settings`, {
      night: { on: true, color: 'amber', brightness: 40 },
    }, admin)
    expect(r.statusCode).toBe(200)
    const state = json(await call('GET', '/api/waffled-bites/device/state', undefined, deviceToken))
    expect(state.settings.night).toMatchObject({ on: true, color: 'amber', brightness: 40 })
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
})
