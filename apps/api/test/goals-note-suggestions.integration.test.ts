// GET /api/goals/:id/note-suggestions — per-goal (optionally per-person) suggestions
// for the "What did you do?" note field on the log sheet, derived from the notes the
// household has actually logged against this goal. Ranked frequency-then-recency, with
// case/whitespace variants merged. Shares one Postgres testcontainer + app.
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
let kevinId = ''
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
  // Mirror the production adapter (platform/http-server.ts), which parses the URL's
  // query string into queryStringParameters — that's where lambda-api reads req.query.
  const [bare, qs] = path.split('?')
  const queryStringParameters = qs ? Object.fromEntries(new URLSearchParams(qs)) : {}
  return app.run(
    { httpMethod: method, path: bare, headers, queryStringParameters, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
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
  kevinId = JSON.parse(setup.body).person.id
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

async function makeGoal(): Promise<string> {
  const add = await call('POST', '/api/goals', kevin, {
    title: 'Hours Outside',
    goalType: 'total',
    trackingMode: 'shared_total',
    participantMode: 'split',
    unit: 'hrs',
    targetValue: 1000,
  })
  expect(add.statusCode).toBe(201)
  return JSON.parse(add.body).goal.id
}

describe('GET /api/goals/:id/note-suggestions', () => {
  it('404s for an unknown goal', async () => {
    const res = await call('GET', '/api/goals/00000000-0000-0000-0000-000000000000/note-suggestions', kevin)
    expect(res.statusCode).toBe(404)
  })

  it('403s for a caller with no household', async () => {
    const res = await call('GET', '/api/goals/00000000-0000-0000-0000-000000000000/note-suggestions', mint('dev|nobody'))
    expect(res.statusCode).toBe(403)
  })

  it('returns an empty list for a goal with no logged notes', async () => {
    const goalId = await makeGoal()
    const res = await call('GET', `/api/goals/${goalId}/note-suggestions`, kevin)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ suggestions: [] })
  })

  it('ranks by frequency then recency and merges case/whitespace variants', async () => {
    const goalId = await makeGoal()
    // "Family walk" logged twice (once lowercased — should merge, keeping the most
    // recent spelling), plus two singletons on later days.
    await call('POST', `/api/goals/${goalId}/log`, kevin, { amount: 1, personIds: [wallyId], note: 'Family walk', loggedOn: '2026-01-01' })
    await call('POST', `/api/goals/${goalId}/log`, kevin, { amount: 1, personIds: [wallyId], note: '  family walk ', loggedOn: '2026-01-02' })
    await call('POST', `/api/goals/${goalId}/log`, kevin, { amount: 1, personIds: [kevinId], note: 'Solo run', loggedOn: '2026-01-03' })
    await call('POST', `/api/goals/${goalId}/log`, kevin, { amount: 1, personIds: [wallyId], note: 'Park day', loggedOn: '2026-01-04' })

    const res = await call('GET', `/api/goals/${goalId}/note-suggestions`, kevin)
    expect(res.statusCode).toBe(200)
    // family walk (2) first; then the two singletons by recency (Park day 01-04 > Solo run 01-03).
    expect(JSON.parse(res.body).suggestions).toEqual(['family walk', 'Park day', 'Solo run'])
  })

  it('scopes to a person by PARTICIPANT credit, not who recorded it', async () => {
    const goalId = await makeGoal()
    // Kevin records every log. Wally is the credited participant on two of them.
    await call('POST', `/api/goals/${goalId}/log`, kevin, { amount: 1, personIds: [wallyId], note: 'Family walk', loggedOn: '2026-02-01' })
    await call('POST', `/api/goals/${goalId}/log`, kevin, { amount: 1, personIds: [wallyId], note: 'family walk', loggedOn: '2026-02-02' })
    await call('POST', `/api/goals/${goalId}/log`, kevin, { amount: 1, personIds: [kevinId], note: 'Solo run', loggedOn: '2026-02-03' })

    // Wally's suggestions = notes where Wally was credited (even though Kevin recorded them).
    const wally = await call('GET', `/api/goals/${goalId}/note-suggestions?personId=${wallyId}`, kevin)
    expect(wally.statusCode).toBe(200)
    expect(JSON.parse(wally.body).suggestions).toEqual(['family walk'])

    // Kevin's own suggestions do NOT include the notes he merely recorded for Wally.
    const kev = await call('GET', `/api/goals/${goalId}/note-suggestions?personId=${kevinId}`, kevin)
    expect(kev.statusCode).toBe(200)
    expect(JSON.parse(kev.body).suggestions).toEqual(['Solo run'])
  })
})
