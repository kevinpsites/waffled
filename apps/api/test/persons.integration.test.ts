// Members CRUD against a real Postgres (Testcontainers), scoped per household.
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

const kevin = mint('dev|kevin')
const kelly = mint('dev|kelly')

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/db')).closePool

  // Two separate households to prove isolation.
  await call('POST', '/api/households', kevin, {
    name: 'Sites',
    timezone: 'America/Chicago',
    person: { name: 'Kevin' },
  })
  await call('POST', '/api/households', kelly, {
    name: 'Kelly HQ',
    timezone: 'UTC',
    person: { name: 'Kelly' },
  })
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('GET /api/persons', () => {
  it('403s for a caller with no household', async () => {
    const res = await call('GET', '/api/persons', mint('dev|nobody'))
    expect(res.statusCode).toBe(403)
  })

  it('lists the household owner after provisioning', async () => {
    const res = await call('GET', '/api/persons', kevin)
    expect(res.statusCode).toBe(200)
    const { persons } = JSON.parse(res.body)
    expect(persons).toHaveLength(1)
    expect(persons[0]).toMatchObject({ name: 'Kevin', memberType: 'adult', isAdmin: true })
  })

  it('only returns the caller’s own household members', async () => {
    const mine = JSON.parse((await call('GET', '/api/persons', kevin)).body).persons
    const theirs = JSON.parse((await call('GET', '/api/persons', kelly)).body).persons
    expect(mine.map((p: { name: string }) => p.name)).toEqual(['Kevin'])
    expect(theirs.map((p: { name: string }) => p.name)).toEqual(['Kelly'])
  })
})
