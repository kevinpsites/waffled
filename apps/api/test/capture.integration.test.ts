// Capture parsing — provider config endpoints + heuristic fallback against a real
// PG, plus pure intent-finalization unit checks. (LLM adapters hit external HTTP
// and aren't exercised here; finalizeIntent covers the mapping they feed into.)
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'
import { finalizeIntent, resolveDayFromText } from '../src/modules/capture/capture'

const SECRET = 'nook-local-dev-secret-change-me'
let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'nook-local', audience: 'nook-api', expiresIn: '1h' })
}
interface RunResult { statusCode: number; body: string }
function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run({ httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false }, {}) as Promise<RunResult>
}

let kevin = ''

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
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('capture config endpoints', () => {
  it('defaults to the on-device heuristic with no providers configured', async () => {
    const res = await call('GET', '/api/capture/config', kevin)
    expect(res.statusCode).toBe(200)
    const d = JSON.parse(res.body)
    expect(d.provider).toBe('heuristic')
    expect(d.available.heuristic).toBe(true)
    expect(d.available.anthropic).toBe(false)
    expect(d.available.ollama).toBe(false)
  })

  it('rejects selecting a provider with no server credentials', async () => {
    const res = await call('PUT', '/api/capture/config', kevin, { provider: 'anthropic' })
    expect(res.statusCode).toBe(400)
  })

  it('rejects an unknown provider', async () => {
    expect((await call('PUT', '/api/capture/config', kevin, { provider: 'bogus' })).statusCode).toBe(400)
  })

  it('persists a heuristic selection and round-trips it', async () => {
    expect((await call('PUT', '/api/capture/config', kevin, { provider: 'heuristic' })).statusCode).toBe(200)
    const d = JSON.parse((await call('GET', '/api/capture/config', kevin)).body)
    expect(d.provider).toBe('heuristic')
  })

  it('POST /api/capture defers to the client when the provider is heuristic', async () => {
    const res = await call('POST', '/api/capture', kevin, { text: 'milk' })
    expect(res.statusCode).toBe(200)
    const d = JSON.parse(res.body)
    expect(d.fallback).toBe(true)
    expect(d.intent).toBeNull()
  })
})

describe('finalizeIntent — model JSON → finished intent', () => {
  const ctx = { now: '2026-06-11T09:00:00Z', timezone: 'America/Chicago', people: ['Wally', 'Lottie'] }

  it('maps a grocery item', () => {
    expect(finalizeIntent({ kind: 'grocery', name: 'chicken thighs', quantity: '2 lbs' }, ctx)).toEqual({
      kind: 'grocery', name: 'chicken thighs', quantity: '2 lbs',
    })
  })

  it('maps a recurring chore and labels the schedule', () => {
    const i = finalizeIntent({ kind: 'task', title: 'Take out the trash', personName: 'lottie', rrule: 'FREQ=WEEKLY;BYDAY=TU,TH' }, ctx)
    expect(i).toMatchObject({ kind: 'task', title: 'Take out the trash', personName: 'Lottie', rrule: 'FREQ=WEEKLY;BYDAY=TU,TH', scheduleLabel: 'Tue & Thu' })
  })

  it('drops a person who is not in the family', () => {
    const i = finalizeIntent({ kind: 'task', title: 'X', personName: 'Stranger' }, ctx)
    expect(i.personName).toBeNull()
  })

  it('maps an event and builds a when-label', () => {
    const i = finalizeIntent({ kind: 'event', title: 'Soccer', startsAt: '2026-06-16T21:00:00Z', allDay: false }, ctx)
    expect(i.kind).toBe('event')
    expect(i.whenLabel).toMatch(/·/)
  })

  it('interprets a naive local datetime in the household timezone', () => {
    // 4pm naive, household America/Chicago (CDT -05:00) → 21:00 UTC.
    const i = finalizeIntent({ kind: 'event', title: 'Soccer', startsAt: '2026-06-16T16:00:00', allDay: false }, ctx)
    expect(i.startsAt).toBe('2026-06-16T21:00:00.000Z')
    expect(i.whenLabel).toContain('4:00')
  })

  it('rejects an event with no valid start', () => {
    expect(() => finalizeIntent({ kind: 'event', title: 'x', startsAt: 'not-a-date' }, ctx)).toThrow()
  })

  it('maps a meal, defaulting to dinner + today', () => {
    const i = finalizeIntent({ kind: 'meal', title: 'Shawarma' }, ctx)
    expect(i.kind).toBe('meal')
    expect(i.title).toBe('Shawarma')
    expect(i.mealType).toBe('dinner')
    expect(i.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(i.whenLabel).toContain('Dinner')
  })

  it('keeps an explicit meal date + slot', () => {
    const i = finalizeIntent({ kind: 'meal', title: 'Tacos', mealType: 'lunch', date: '2026-06-12' }, ctx)
    expect(i.mealType).toBe('lunch')
    expect(i.date).toBe('2026-06-12')
  })
})

describe('resolveDayFromText — deterministic meal day (model-independent)', () => {
  const tz = 'America/Chicago'
  const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay()
  const days = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000

  it('returns null when no day is mentioned', () => {
    expect(resolveDayFromText('shawarma on the meal plan', tz)).toBeNull()
  })
  it('"tomorrow" is exactly one day after today', () => {
    expect(days(resolveDayFromText('today', tz)!, resolveDayFromText('burgers tomorrow', tz)!)).toBe(1)
  })
  it('resolves a weekday to that weekday', () => {
    expect(dow(resolveDayFromText('fish for dinner on friday', tz)!)).toBe(5)
    expect(dow(resolveDayFromText('fish for dinner next thursday', tz)!)).toBe(4)
  })
  it('"next <weekday>" lands 7–13 days out', () => {
    const d = days(resolveDayFromText('today', tz)!, resolveDayFromText('next thursday', tz)!)
    expect(d).toBeGreaterThanOrEqual(7)
    expect(d).toBeLessThanOrEqual(13)
  })
})
