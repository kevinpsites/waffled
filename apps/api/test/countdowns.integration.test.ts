// Countdowns — merged read (standalone + flagged events + birthdays), CRUD, and the
// sleeps config, against a real Postgres (Testcontainers).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}

function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<{ statusCode: number; body: string }>
}

const kevin = mint('dev|kevin')

// A YYYY-MM-DD n days from "now" (UTC-ish; the test only asserts ordering/presence).
function inDays(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool

  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  const householdId = JSON.parse(setup.body).household.id
  const ownerId = JSON.parse(setup.body).person.id
  const { query } = await import('../src/platform/db')
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [householdId, ownerId]
  )
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('countdowns', () => {
  let standaloneId = ''

  it('starts empty', async () => {
    const res = await call('GET', '/api/countdowns', kevin)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.countdowns).toEqual([])
    expect(body.sleeps).toBe(false)
  })

  it('creates a standalone countdown and lists it with days left', async () => {
    const res = await call('POST', '/api/countdowns', kevin, { title: 'Hawaii trip', date: inDays(30), emoji: '🏝️' })
    expect(res.statusCode).toBe(201)
    standaloneId = JSON.parse(res.body).id

    const list = JSON.parse((await call('GET', '/api/countdowns', kevin)).body).countdowns
    const hawaii = list.find((c: { title: string }) => c.title === 'Hawaii trip')
    expect(hawaii).toBeTruthy()
    expect(hawaii.source).toBe('standalone')
    expect(hawaii.daysLeft).toBeGreaterThan(0)
    expect(hawaii.emoji).toBe('🏝️')
  })

  it('rejects a bad date', async () => {
    expect((await call('POST', '/api/countdowns', kevin, { title: 'x', date: 'soon' })).statusCode).toBe(400)
    expect((await call('POST', '/api/countdowns', kevin, { title: '', date: inDays(5) })).statusCode).toBe(400)
  })

  it('includes an event flagged as a countdown', async () => {
    const ev = await call('POST', '/api/events', kevin, { title: 'Concert', startsAt: `${inDays(10)}T19:00:00.000Z`, isCountdown: true })
    expect(ev.statusCode).toBe(201)
    const list = JSON.parse((await call('GET', '/api/countdowns', kevin)).body).countdowns
    const concert = list.find((c: { title: string }) => c.title === 'Concert')
    expect(concert).toBeTruthy()
    expect(concert.source).toBe('event')
  })

  it('does NOT include an event that is not flagged', async () => {
    await call('POST', '/api/events', kevin, { title: 'Dentist', startsAt: `${inDays(12)}T09:00:00.000Z` })
    const list = JSON.parse((await call('GET', '/api/countdowns', kevin)).body).countdowns
    expect(list.some((c: { title: string }) => c.title === 'Dentist')).toBe(false)
  })

  it("derives a member's next birthday", async () => {
    await call('POST', '/api/persons', kevin, { name: 'Wally', memberType: 'kid', birthday: '2016-07-15' })
    const list = JSON.parse((await call('GET', '/api/countdowns', kevin)).body).countdowns
    const bday = list.find((c: { source: string; title: string }) => c.source === 'birthday' && c.title === "Wally's birthday")
    expect(bday).toBeTruthy()
    expect(bday.date.endsWith('-07-15')).toBe(true)
    expect(bday.daysLeft).toBeGreaterThanOrEqual(0)
  })

  it('sorts soonest first', async () => {
    const list = JSON.parse((await call('GET', '/api/countdowns', kevin)).body).countdowns
    const days = list.map((c: { daysLeft: number }) => c.daysLeft)
    expect(days).toEqual([...days].sort((a, b) => a - b))
  })

  it('edits and deletes a standalone countdown', async () => {
    expect((await call('PATCH', `/api/countdowns/${standaloneId}`, kevin, { title: 'Maui trip' })).statusCode).toBe(200)
    let list = JSON.parse((await call('GET', '/api/countdowns', kevin)).body).countdowns
    expect(list.some((c: { title: string }) => c.title === 'Maui trip')).toBe(true)

    expect((await call('DELETE', `/api/countdowns/${standaloneId}`, kevin)).statusCode).toBe(204)
    list = JSON.parse((await call('GET', '/api/countdowns', kevin)).body).countdowns
    expect(list.some((c: { title: string }) => c.title === 'Maui trip')).toBe(false)
  })

  it('persists the sleeps display preference', async () => {
    expect((await call('PUT', '/api/countdowns/config', kevin, { sleeps: true })).statusCode).toBe(200)
    expect(JSON.parse((await call('GET', '/api/countdowns', kevin)).body).sleeps).toBe(true)
  })
})
