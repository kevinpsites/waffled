// Optional-module gating — disabling a module 403s its routes (full backend
// enforcement), while ungated routes and other modules keep working. Shares one
// Postgres testcontainer + app, mirroring the other integration suites.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

interface RunResult { statusCode: number; body: string }

function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}

let kevin = ''

// Set a module on/off for the household (admin endpoint).
async function setModule(key: string, on: boolean) {
  const r = await call('PATCH', '/api/household/modules', kevin, { [key]: on })
  expect(r.statusCode).toBe(200)
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  process.env.LOCAL_JWT_SECRET = SECRET
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool

  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  kevin = JSON.parse(setup.body).accessToken
}, 120_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

// One representative read route per module (the cheapest GET that the module gates).
const PROBES: Array<{ key: string; method: string; path: string }> = [
  { key: 'chores', method: 'GET', path: '/api/chores/today' },
  { key: 'goals', method: 'GET', path: '/api/goal-lists' },
  { key: 'meals', method: 'GET', path: '/api/recipes' },
  { key: 'lists', method: 'GET', path: '/api/lists' },
]

describe('optional-module gating', () => {
  it('all five modules are on by default (catalog defaultOn)', async () => {
    for (const p of PROBES) {
      const r = await call(p.method, p.path, kevin)
      expect(r.statusCode, `${p.key} should be reachable by default`).toBe(200)
    }
  })

  for (const p of PROBES) {
    it(`disabling ${p.key} 403s ${p.method} ${p.path}, re-enabling restores it`, async () => {
      await setModule(p.key, false)
      const off = await call(p.method, p.path, kevin)
      expect(off.statusCode).toBe(403)
      expect(JSON.parse(off.body).message).toMatch(new RegExp(`${p.key} module is not enabled`, 'i'))

      // Ungated routes (and the module-toggle endpoint itself) keep working.
      expect((await call('GET', '/api/persons', kevin)).statusCode).toBe(200)

      await setModule(p.key, true)
      expect((await call(p.method, p.path, kevin)).statusCode).toBe(200)
    })
  }

  it('the goals module also gates the calendar↔goal bridge', async () => {
    expect((await call('GET', '/api/goal-calendar/recap', kevin)).statusCode).toBe(200)
    await setModule('goals', false)
    const off = await call('GET', '/api/goal-calendar/recap', kevin)
    expect(off.statusCode).toBe(403)
    expect(JSON.parse(off.body).message).toMatch(/goals module is not enabled/i)
    await setModule('goals', true)
  })

  it('disabling one module leaves the others reachable', async () => {
    await setModule('meals', false)
    expect((await call('GET', '/api/recipes', kevin)).statusCode).toBe(403)
    expect((await call('GET', '/api/goal-lists', kevin)).statusCode).toBe(200)
    expect((await call('GET', '/api/lists', kevin)).statusCode).toBe(200)
    await setModule('meals', true)
  })

  it('module check precedes admin/cap checks (write route 403s when module off)', async () => {
    await setModule('meals', false)
    // PUT /api/meals/calendar-settings is an adminRoute; with the module off it
    // 403s on the module gate regardless of role.
    const r = await call('PUT', '/api/meals/calendar-settings', kevin, { addToCalendar: true })
    expect(r.statusCode).toBe(403)
    expect(JSON.parse(r.body).message).toMatch(/meals module is not enabled/i)
    await setModule('meals', true)
  })

  it('an unauthenticated request still 401s (auth before module)', async () => {
    expect((await call('GET', '/api/recipes')).statusCode).toBe(401)
  })
})

describe('rewards nested under chores', () => {
  it('rewards work by default (chores on, sub-flag on)', async () => {
    expect((await call('GET', '/api/rewards', kevin)).statusCode).toBe(200)
  })

  it('turning off the rewards sub-flag 403s reward routes; chores still work', async () => {
    const put = await call('PUT', '/api/chores/settings', kevin, { rewards: false })
    expect(put.statusCode).toBe(200)
    expect(JSON.parse(put.body).rewards).toBe(false)

    const off = await call('GET', '/api/rewards', kevin)
    expect(off.statusCode).toBe(403)
    expect(JSON.parse(off.body).message).toMatch(/rewards are turned off/i)
    // Chores itself is unaffected.
    expect((await call('GET', '/api/chores/today', kevin)).statusCode).toBe(200)

    await call('PUT', '/api/chores/settings', kevin, { rewards: true })
    expect((await call('GET', '/api/rewards', kevin)).statusCode).toBe(200)
  })

  it('disabling the chores module also disables rewards', async () => {
    await setModule('chores', false)
    const off = await call('GET', '/api/rewards', kevin)
    expect(off.statusCode).toBe(403)
    expect(JSON.parse(off.body).message).toMatch(/chores module is not enabled/i)
    await setModule('chores', true)
    expect((await call('GET', '/api/rewards', kevin)).statusCode).toBe(200)
  })
})
