// GET /api/goals/:id/activity — day-bucketed log history powering the goal-detail
// data views (Week/Month/Pace/Year/By-person/Year-ring). Shares one Postgres
// testcontainer + app with the other goals integration tests.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { Client } from 'pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let householdId = ''
let wallyId = ''

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}

interface RunResult {
  statusCode: number
  body: string
}

function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}

const kevin = mint('dev|kevin')

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  const kevinId = JSON.parse(setup.body).person.id
  householdId = JSON.parse(setup.body).household.id
  await withClient((c) =>
    c.query(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
      [householdId, kevinId]
    )
  )
  wallyId = (
    await withClient((c) =>
      c.query<{ id: string }>(`insert into persons (household_id, name, member_type) values ($1,'Wally','kid') returning id`, [householdId])
    )
  ).rows[0].id
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('GET /api/goals/:id/activity', () => {
  it('404s for an unknown goal', async () => {
    const res = await call('GET', '/api/goals/00000000-0000-0000-0000-000000000000/activity', kevin)
    expect(res.statusCode).toBe(404)
  })

  it('403s for a caller with no household', async () => {
    const res = await call('GET', '/api/goals/00000000-0000-0000-0000-000000000000/activity', mint('dev|nobody'))
    expect(res.statusCode).toBe(403)
  })

  it('returns startDate/today with an empty days array for a fresh goal', async () => {
    const add = await call('POST', '/api/goals', kevin, {
      title: '1,000 Hours Outside',
      goalType: 'total',
      trackingMode: 'shared_total',
      participantMode: 'split',
      unit: 'hrs',
      targetValue: 1000,
    })
    expect(add.statusCode).toBe(201)
    const goalId = JSON.parse(add.body).goal.id

    const res = await call('GET', `/api/goals/${goalId}/activity`, kevin)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(body.endDate).toBeNull()
    expect(body.days).toEqual([])
  })

  it('buckets logs by local day and splits a shared entry across participants', async () => {
    const add = await call('POST', '/api/goals', kevin, {
      title: 'Read together',
      goalType: 'total',
      trackingMode: 'shared_total',
      participantMode: 'split',
      unit: 'hrs',
      targetValue: 100,
    })
    const goalId = JSON.parse(add.body).goal.id
    const kevinId = (await withClient((c) => c.query<{ id: string }>('select id from persons where name=$1', ['Kevin']))).rows[0].id

    // Two people logging 4 hrs together on 2026-01-01, then Kevin alone for 2 hrs on 2026-01-02.
    await call('POST', `/api/goals/${goalId}/log`, kevin, { amount: 4, personIds: [wallyId, kevinId], loggedOn: '2026-01-01' })
    await call('POST', `/api/goals/${goalId}/log`, kevin, { amount: 2, personIds: [kevinId], loggedOn: '2026-01-02' })

    const res = await call('GET', `/api/goals/${goalId}/activity`, kevin)
    expect(res.statusCode).toBe(200)
    const { days } = JSON.parse(res.body)
    expect(days).toHaveLength(2)

    const jan1 = days.find((d: { dateKey: string }) => d.dateKey === '2026-01-01')
    expect(jan1.total).toBe(4)
    expect(jan1.perMember[wallyId]).toBe(2)
    expect(jan1.perMember[kevinId]).toBe(2)

    const jan2 = days.find((d: { dateKey: string }) => d.dateKey === '2026-01-02')
    expect(jan2.total).toBe(2)
    expect(jan2.perMember[kevinId]).toBe(2)
    expect(jan2.perMember[wallyId]).toBeUndefined()
  })

  it('counts a shared event once for the family total while still marking attendees present (count_once)', async () => {
    const add = await call('POST', '/api/goals', kevin, {
      title: 'Park visits',
      goalType: 'count',
      trackingMode: 'shared_total',
      participantMode: 'count_once',
      unit: 'parks',
      targetValue: 20,
    })
    const goalId = JSON.parse(add.body).goal.id
    const kevinId = (await withClient((c) => c.query<{ id: string }>('select id from persons where name=$1', ['Kevin']))).rows[0].id

    // One shared park visit — the family total gains 1 regardless of headcount, and
    // attendees are recorded at 0 (attendance, not a multiplier) per planLogRows.
    await call('POST', `/api/goals/${goalId}/log`, kevin, { amount: 1, personIds: [wallyId, kevinId], loggedOn: '2026-02-05' })

    const res = await call('GET', `/api/goals/${goalId}/activity`, kevin)
    const { days } = JSON.parse(res.body)
    const day = days.find((d: { dateKey: string }) => d.dateKey === '2026-02-05')
    // family total counts the shared event once
    expect(day.total).toBe(1)
    // both attendees are present in perMember (as 0 — attendance, not credit)
    expect(day.perMember[wallyId]).toBe(0)
    expect(day.perMember[kevinId]).toBe(0)
  })
})
