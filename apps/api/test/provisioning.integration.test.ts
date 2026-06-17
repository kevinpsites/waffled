// First-login provisioning, end to end against a real Postgres (Testcontainers).
// The API resolves sub → household from the DB, so this exercises the whole
// onboarding slice with zero Auth0 dependency (local HS256 tokens).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'nook-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

function mint(sub: string): string {
  return jwt.sign({}, SECRET, {
    algorithm: 'HS256',
    subject: sub,
    issuer: 'nook-local',
    audience: 'nook-api',
    expiresIn: '1h',
  })
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
    {
      httpMethod: method,
      path,
      headers,
      queryStringParameters: {},
      body: body !== undefined ? JSON.stringify(body) : null,
      isBase64Encoded: false,
    },
    {}
  ) as Promise<RunResult>
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN // ensure local HS256 mode in this fork
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('first-login provisioning', () => {
  const kevin = mint('dev|kevin')

  it('reports unprovisioned before onboarding', async () => {
    const res = await call('GET', '/api/household', kevin)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ provisioned: false })
  })

  it('rejects provisioning with an incomplete body (400)', async () => {
    const res = await call('POST', '/api/households', kevin, { name: 'X' })
    expect(res.statusCode).toBe(400)
  })

  it('creates a household with the caller as owner + admin', async () => {
    const res = await call('POST', '/api/households', kevin, {
      name: 'The Sites Family',
      timezone: 'America/Chicago',
      person: { name: 'Kevin', avatarEmoji: '🐻' },
    })
    expect(res.statusCode).toBe(201)
    const { household, person } = JSON.parse(res.body)
    expect(person).toMatchObject({
      name: 'Kevin',
      memberType: 'adult',
      isAdmin: true,
      avatarEmoji: '🐻',
    })
    expect(household).toMatchObject({
      name: 'The Sites Family',
      timezone: 'America/Chicago',
      ownerPersonId: person.id,
    })
    expect(person.householdId).toBe(household.id)
  })

  it('reports provisioned afterward with the same household', async () => {
    const res = await call('GET', '/api/household', kevin)
    const body = JSON.parse(res.body)
    expect(body.provisioned).toBe(true)
    expect(body.household.name).toBe('The Sites Family')
    expect(body.person.name).toBe('Kevin')
  })

  it('refuses to provision the same account twice (409)', async () => {
    const res = await call('POST', '/api/households', kevin, {
      name: 'Another',
      timezone: 'UTC',
      person: { name: 'Dup' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('provisions a different account into a separate household', async () => {
    const kelly = mint('dev|kelly')
    const create = await call('POST', '/api/households', kelly, {
      name: 'Kelly HQ',
      timezone: 'UTC',
      person: { name: 'Kelly' },
    })
    expect(create.statusCode).toBe(201)
    const kellyHousehold = JSON.parse(create.body).household.id

    const kevinCtx = JSON.parse((await call('GET', '/api/household', kevin)).body)
    expect(kevinCtx.household.id).not.toBe(kellyHousehold)
  })
})
