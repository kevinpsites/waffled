// Settings domain — household settings read + update, on top of the existing
// persons CRUD. Shares one Postgres testcontainer + app.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let kevinId = ''

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
  const [rawPath, qs] = path.split('?')
  const queryStringParameters: Record<string, string> = {}
  if (qs) for (const pair of qs.split('&')) {
    const [k, v] = pair.split('=')
    queryStringParameters[k] = decodeURIComponent(v ?? '')
  }
  return app.run(
    { httpMethod: method, path: rawPath, headers, queryStringParameters, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}

const kevin = mint('dev|kevin')

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
  const query = (await import('../src/platform/db')).query
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'The Family', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  kevinId = JSON.parse(setup.body).person.id
  const householdId = JSON.parse(setup.body).household.id
  // Seed an identity so the legacy mint('dev|kevin') token resolves to the owner.
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [householdId, kevinId]
  )
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('household settings', () => {
  it('returns the household + members with login/owner flags', async () => {
    // add a kid (no login)
    await call('POST', '/api/persons', kevin, { name: 'Wally', memberType: 'kid', avatarEmoji: '🐢', birthday: '2018-05-01' })

    const res = await call('GET', '/api/household/settings', kevin)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.household).toMatchObject({ name: 'The Family', timezone: 'America/Chicago', weekStart: 'sunday' })

    const kevinM = body.members.find((m: { id: string }) => m.id === kevinId)
    const wally = body.members.find((m: { name: string }) => m.name === 'Wally')
    expect(kevinM).toMatchObject({ isOwner: true, hasLogin: true, memberType: 'adult' })
    expect(wally).toMatchObject({ isOwner: false, hasLogin: false, memberType: 'kid', showOnKiosk: true })
    expect(String(wally.birthday)).toContain('2018-05')
  })

  it('edits household name / week start / timezone (admin)', async () => {
    const res = await call('PATCH', '/api/household', kevin, { name: 'Sites Family', weekStart: 'monday' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).household).toMatchObject({ name: 'Sites Family', weekStart: 'monday' })

    const check = JSON.parse((await call('GET', '/api/household/settings', kevin)).body)
    expect(check.household.weekStart).toBe('monday')
  })

  it('validates the patch (400)', async () => {
    expect((await call('PATCH', '/api/household', kevin, { weekStart: 'someday' })).statusCode).toBe(400)
    expect((await call('PATCH', '/api/household', kevin, { nope: 1 })).statusCode).toBe(400)
  })

  it('403s for a caller with no household', async () => {
    expect((await call('GET', '/api/household/settings', mint('dev|nobody'))).statusCode).toBe(403)
  })
})
