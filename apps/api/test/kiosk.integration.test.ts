// Kiosk device pairing + kid profile tokens. An admin pairs a tablet (code or
// promote), the device lists household profiles and mints a real, person-scoped
// session when one is claimed (with an optional PIN). The two load-bearing
// assertions: a device token can't touch normal data routes, and a kid's profile
// token still hits the admin gate — i.e. attribution + authorization are enforced
// server-side, not trusted from the client.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  // Fast, deterministic PIN throttling for the lockout test.
  process.env.KIOSK_PIN_MAX_ATTEMPTS = '3'
  process.env.KIOSK_PIN_LOCKOUT_SECONDS = '1'
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
}, 120_000)
afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('kiosk pairing + profile tokens', () => {
  let admin: string         // owner/admin access token
  let kid: string           // a kid profile (no PIN)
  let pinKid: string        // a kid profile with a PIN
  let hiddenKidId: string   // show_on_kiosk = false
  let deviceSecret: string
  let deviceToken: string
  let kidToken: string
  let kidRefresh: string

  it('sets up an admin and family profiles', async () => {
    const setup = json(await call('POST', '/api/auth/setup', {
      household: { name: 'Sites', timezone: 'America/Chicago' },
      admin: { name: 'Kevin', email: 'kevin@example.com', password: 'hunter2hunter' },
    }))
    admin = setup.accessToken
    kid = json(await call('POST', '/api/persons', { name: 'Wally', memberType: 'kid' }, admin)).person.id
    pinKid = json(await call('POST', '/api/persons', { name: 'Lottie', memberType: 'kid' }, admin)).person.id
    hiddenKidId = json(await call('POST', '/api/persons', { name: 'Baby', memberType: 'kid' }, admin)).person.id
    expect((await call('PATCH', `/api/persons/${hiddenKidId}`, { showOnKiosk: false }, admin)).statusCode).toBe(200)
  })

  // ── pairing ──────────────────────────────────────────────────────────────────
  it('pairs a device with an admin-minted code; rejects bad/reused codes', async () => {
    const code = json(await call('POST', '/api/kiosk/pairing-code', { label: 'Kitchen' }, admin)).code
    expect(typeof code).toBe('string')

    const paired = await call('POST', '/api/kiosk/pair', { code, label: 'Kitchen' })
    expect(paired.statusCode).toBe(201)
    deviceSecret = json(paired).deviceSecret
    expect(typeof deviceSecret).toBe('string')
    expect(typeof json(paired).deviceId).toBe('string')

    // One-time: the same code can't be reused.
    expect((await call('POST', '/api/kiosk/pair', { code })).statusCode).toBe(401)
    // Unknown code.
    expect((await call('POST', '/api/kiosk/pair', { code: 'NOPE12' })).statusCode).toBe(401)
  })

  it('requires admin to mint a pairing code and to promote', async () => {
    // We don't have a non-admin token yet; claim one after pairing (below) proves it.
    const promoted = await call('POST', '/api/kiosk/promote', { label: 'Den' }, admin)
    expect(promoted.statusCode).toBe(201)
    expect(typeof json(promoted).deviceSecret).toBe('string')
  })

  it('exchanges the device secret for a short-lived device token; rejects a bad secret', async () => {
    const r = await call('POST', '/api/kiosk/device/token', { deviceSecret })
    expect(r.statusCode).toBe(200)
    deviceToken = json(r).accessToken
    expect(typeof deviceToken).toBe('string')
    expect((await call('POST', '/api/kiosk/device/token', { deviceSecret: 'garbage' })).statusCode).toBe(401)
  })

  // ── the split: a device token is not a tenant ──────────────────────────────────
  it('lists only show_on_kiosk profiles, without pin hashes', async () => {
    const r = await call('GET', '/api/kiosk/profiles', undefined, deviceToken)
    expect(r.statusCode).toBe(200)
    const profiles = json(r).profiles as Array<{ id: string; name: string; hasPin: boolean; pinHash?: string }>
    const ids = profiles.map((p) => p.id)
    expect(ids).toContain(kid)
    expect(ids).not.toContain(hiddenKidId) // hidden from the picker
    expect(profiles.every((p) => !('pinHash' in p) && !('pin_hash' in p))).toBe(true)
  })

  it('returns the device label with the profiles, and lets the device name itself', async () => {
    expect(json(await call('GET', '/api/kiosk/profiles', undefined, deviceToken)).deviceLabel).toBe('Kitchen')
    // The just-paired device names itself (post-pair step) — no admin needed.
    expect((await call('PUT', '/api/kiosk/device/label', { label: 'Mud Room' }, deviceToken)).statusCode).toBe(200)
    expect(json(await call('GET', '/api/kiosk/profiles', undefined, deviceToken)).deviceLabel).toBe('Mud Room')
    // …and the admin device list reflects it.
    const dev = json(await call('GET', '/api/kiosk/devices', undefined, admin)).devices.find((d: { label: string }) => d.label === 'Mud Room')
    expect(dev).toBeTruthy()
  })

  it('rejects a device token on a normal data route (the split)', async () => {
    // Device tokens have no identity row → requireTenant 403s automatically.
    expect((await call('POST', '/api/persons', { name: 'Nope', memberType: 'kid' }, deviceToken)).statusCode).toBe(403)
    // And a person token can't act as a device.
    expect((await call('GET', '/api/kiosk/profiles', undefined, admin)).statusCode).toBe(403)
  })

  // ── claiming a profile mints a real session ────────────────────────────────────
  it('claims a PIN-less kid profile and the token resolves to the household', async () => {
    const r = await call('POST', `/api/kiosk/profile/${kid}`, {}, deviceToken)
    expect(r.statusCode).toBe(200)
    const { accessToken, refreshToken, person } = json(r)
    expect(person.id).toBe(kid)
    kidToken = accessToken
    kidRefresh = refreshToken
    expect(json(await call('GET', '/api/household', undefined, accessToken))).toMatchObject({ provisioned: true })
  })

  it('enforces role gates on the claimed kid token (not admin)', async () => {
    // A kid is not an admin — admin-only mutations must still 403.
    expect((await call('POST', '/api/persons', { name: 'X', memberType: 'kid' }, kidToken)).statusCode).toBe(403)
  })

  it('rotates the kiosk session through the standard refresh endpoint', async () => {
    const r = await call('POST', '/api/auth/refresh', { refreshToken: kidRefresh })
    expect(r.statusCode).toBe(200)
    const fresh = json(r).accessToken
    expect(json(await call('GET', '/api/household', undefined, fresh))).toMatchObject({ provisioned: true })
  })

  it('404s when claiming a person outside the device household', async () => {
    expect((await call('POST', `/api/kiosk/profile/00000000-0000-0000-0000-000000000000`, {}, deviceToken)).statusCode).toBe(404)
    expect((await call('POST', `/api/kiosk/profile/${hiddenKidId}`, {}, deviceToken)).statusCode).toBe(404)
  })

  // ── PIN ────────────────────────────────────────────────────────────────────────
  it('requires the PIN when one is set, and throttles wrong attempts', async () => {
    expect((await call('PUT', `/api/persons/${pinKid}/pin`, { pin: '4242' }, admin)).statusCode).toBe(200)
    // No PIN / wrong PIN is rejected.
    expect((await call('POST', `/api/kiosk/profile/${pinKid}`, {}, deviceToken)).statusCode).toBe(401)
    // Throttle: KIOSK_PIN_MAX_ATTEMPTS=3 → the 3rd wrong attempt locks (429).
    const second = await call('POST', `/api/kiosk/profile/${pinKid}`, { pin: '0000' }, deviceToken)
    expect(second.statusCode).toBe(401)
    expect(json(second).triesLeft).toBe(1) // 3 max − 2 used
    expect((await call('POST', `/api/kiosk/profile/${pinKid}`, { pin: '0000' }, deviceToken)).statusCode).toBe(429)
    // Locked: even the correct PIN is refused while locked.
    expect((await call('POST', `/api/kiosk/profile/${pinKid}`, { pin: '4242' }, deviceToken)).statusCode).toBe(429)
    // Lockout expires (KIOSK_PIN_LOCKOUT_SECONDS=1) → correct PIN succeeds + resets.
    await sleep(1200)
    const ok = await call('POST', `/api/kiosk/profile/${pinKid}`, { pin: '4242' }, deviceToken)
    expect(ok.statusCode).toBe(200)
    expect(json(ok).person.id).toBe(pinKid)
  })

  it('lets an admin clear a PIN (tap-to-act again)', async () => {
    expect((await call('DELETE', `/api/persons/${pinKid}/pin`, undefined, admin)).statusCode).toBe(200)
    expect((await call('POST', `/api/kiosk/profile/${pinKid}`, {}, deviceToken)).statusCode).toBe(200)
  })

  // ── identity resurrection after a login is removed ──────────────────────────────
  it('resurrects a soft-deleted kiosk identity on re-claim', async () => {
    // Claiming created a kiosk identity for `kid`. Removing the login soft-deletes it.
    expect((await call('DELETE', `/api/persons/${kid}/login`, undefined, admin)).statusCode).toBe(200)
    // Re-claim must resurrect it so the fresh token resolves again.
    const r = await call('POST', `/api/kiosk/profile/${kid}`, {}, deviceToken)
    expect(r.statusCode).toBe(200)
    expect(json(await call('GET', '/api/household', undefined, json(r).accessToken))).toMatchObject({ provisioned: true })
  })

  // ── device management (admin) ───────────────────────────────────────────────────
  it('lists, renames, and revokes devices (admin)', async () => {
    const list = json(await call('GET', '/api/kiosk/devices', undefined, admin))
    expect(Array.isArray(list.devices)).toBe(true)
    expect(list.devices.length).toBeGreaterThanOrEqual(2)

    // A fresh device we can safely revoke without disturbing the others.
    const spare = json(await call('POST', '/api/kiosk/promote', { label: 'Spare' }, admin))
    const tok = json(await call('POST', '/api/kiosk/device/token', { deviceSecret: spare.deviceSecret })).accessToken
    expect((await call('GET', '/api/kiosk/profiles', undefined, tok)).statusCode).toBe(200)

    expect((await call('PATCH', `/api/kiosk/devices/${spare.deviceId}`, { label: 'Hallway' }, admin)).statusCode).toBe(200)
    const renamed = json(await call('GET', '/api/kiosk/devices', undefined, admin)).devices.find((d: { id: string }) => d.id === spare.deviceId)
    expect(renamed.label).toBe('Hallway')

    // Revoke → both the live token and the secret stop working.
    expect((await call('DELETE', `/api/kiosk/devices/${spare.deviceId}`, undefined, admin)).statusCode).toBe(200)
    expect((await call('GET', '/api/kiosk/profiles', undefined, tok)).statusCode).toBe(401)
    expect((await call('POST', '/api/kiosk/device/token', { deviceSecret: spare.deviceSecret })).statusCode).toBe(401)
  })

  it('rejects device management for non-admins', async () => {
    const kidTok = json(await call('POST', `/api/kiosk/profile/${kid}`, {}, deviceToken)).accessToken
    expect((await call('GET', '/api/kiosk/devices', undefined, kidTok)).statusCode).toBe(403)
  })

  it('surfaces hasPin in household settings', async () => {
    await call('PUT', `/api/persons/${kid}/pin`, { pin: '1234' }, admin)
    const members = json(await call('GET', '/api/household/settings', undefined, admin)).members
    expect(members.find((m: { id: string }) => m.id === kid).hasPin).toBe(true)
    await call('DELETE', `/api/persons/${kid}/pin`, undefined, admin)
  })

  // ── display / screensaver settings ──────────────────────────────────────────────
  it('serves display defaults and persists an admin PUT (shallow + nested merge)', async () => {
    const def = json(await call('GET', '/api/kiosk/display', undefined, admin))
    expect(def).toMatchObject({ screensaverMinutes: 15, content: 'photos', returnToPicker: true, resetHomeMinutes: 3 })
    expect(def.nightDim).toMatchObject({ enabled: false, start: '22:00', end: '07:00' })

    expect((await call('PUT', '/api/kiosk/display', { screensaverMinutes: 20, content: 'clock', nightDim: { enabled: true } }, admin)).statusCode).toBe(200)
    const after = json(await call('GET', '/api/kiosk/display', undefined, admin))
    expect(after.screensaverMinutes).toBe(20)
    expect(after.content).toBe('clock')
    expect(after.returnToPicker).toBe(true) // untouched key preserved
    expect(after.nightDim).toMatchObject({ enabled: true, start: '22:00', end: '07:00' }) // nested merge keeps start/end
  })

  it('serves photo-playback defaults and persists/clamps/sanitizes them', async () => {
    const def = json(await call('GET', '/api/kiosk/display', undefined, admin))
    expect(def).toMatchObject({ photoSource: 'all', photoAlbum: null, photoInterval: 10, photoShuffle: false })

    // Persist the new fields; photoInterval clamps to 3–120; a bad photoSource is ignored.
    expect((await call('PUT', '/api/kiosk/display', {
      photoSource: 'album', photoAlbum: '  Lake Day  ', photoInterval: 999, photoShuffle: true,
    }, admin)).statusCode).toBe(200)
    const a = json(await call('GET', '/api/kiosk/display', undefined, admin))
    expect(a.photoSource).toBe('album')
    expect(a.photoAlbum).toBe('Lake Day') // trimmed
    expect(a.photoInterval).toBe(120) // clamped from 999
    expect(a.photoShuffle).toBe(true)

    // Low interval clamps up to 3; an invalid source falls back to the stored value.
    expect((await call('PUT', '/api/kiosk/display', { photoInterval: 1, photoSource: 'bogus' }, admin)).statusCode).toBe(200)
    const b = json(await call('GET', '/api/kiosk/display', undefined, admin))
    expect(b.photoInterval).toBe(3)
    expect(b.photoSource).toBe('album') // unchanged — bad value rejected

    // A blank album string normalizes to null.
    expect((await call('PUT', '/api/kiosk/display', { photoAlbum: '   ' }, admin)).statusCode).toBe(200)
    expect(json(await call('GET', '/api/kiosk/display', undefined, admin)).photoAlbum).toBeNull()
  })

  it('lets a device token read display settings (dual-auth)', async () => {
    const r = await call('GET', '/api/kiosk/display', undefined, deviceToken)
    expect(r.statusCode).toBe(200)
    expect(json(r).content).toBe('clock') // from the PUT above
  })

  it('rejects a display PUT from a non-admin', async () => {
    const kidTok = json(await call('POST', `/api/kiosk/profile/${kid}`, {}, deviceToken)).accessToken
    expect((await call('PUT', '/api/kiosk/display', { screensaverMinutes: 5 }, kidTok)).statusCode).toBe(403)
  })
})
