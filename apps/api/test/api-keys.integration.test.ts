// Per-user API keys: management CRUD (session-authed) + the x-api-key auth path and
// its central scope gate, against a real Postgres (Testcontainers).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
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

// Bearer (session) call.
function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<{ statusCode: number; body: string }>
}

// API-key call (x-api-key header).
function keyCall(method: string, path: string, key: string, body?: unknown) {
  const headers: Record<string, string> = { 'x-api-key': key }
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<{ statusCode: number; body: string }>
}

const kevin = mint('dev|kevin')
let householdId = ''
let ownerId = ''

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
  householdId = JSON.parse(setup.body).household.id
  ownerId = JSON.parse(setup.body).person.id
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

describe('api-keys management (session)', () => {
  it('requires a session to manage keys', async () => {
    expect((await call('POST', '/api/api-keys', undefined, { name: 'x', scopes: ['lists:read'] })).statusCode).toBe(401)
  })

  it('exposes the grantable scope catalog', async () => {
    const res = await call('GET', '/api/api-keys/scopes', kevin)
    expect(res.statusCode).toBe(200)
    const resources = JSON.parse(res.body).scopes.map((s: { resource: string }) => s.resource)
    expect(resources).toEqual(expect.arrayContaining(['family', 'lists', 'chores', 'meals']))
  })

  it('validates name + scopes on create', async () => {
    expect((await call('POST', '/api/api-keys', kevin, { scopes: ['lists:read'] })).statusCode).toBe(400)
    expect((await call('POST', '/api/api-keys', kevin, { name: 'x', scopes: [] })).statusCode).toBe(400)
    expect((await call('POST', '/api/api-keys', kevin, { name: 'x', scopes: ['bogus:read'] })).statusCode).toBe(400)
    expect((await call('POST', '/api/api-keys', kevin, { name: 'x', scopes: ['family:write'] })).statusCode).toBe(400) // family is read-only
  })

  it('mints a key (secret returned once) and lists it without the secret', async () => {
    const res = await call('POST', '/api/api-keys', kevin, { name: 'Home Assistant', scopes: ['family:read', 'lists:read'] })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.key).toMatch(/^waffled_/)
    expect(body.apiKey).toMatchObject({ name: 'Home Assistant', scopes: ['family:read', 'lists:read'] })
    expect(body.apiKey.prefix).toBe(body.key.slice(0, 12))

    const list = JSON.parse((await call('GET', '/api/api-keys', kevin)).body)
    expect(list.keys).toHaveLength(1)
    expect(list.keys[0]).not.toHaveProperty('key')
    expect(list.keys[0]).not.toHaveProperty('keyHash')
  })
})

describe('api-key authentication + scope gate', () => {
  let readKey = '' // family:read + lists:read
  let writeKey = '' // lists:read + lists:write

  beforeAll(async () => {
    readKey = JSON.parse((await call('POST', '/api/api-keys', kevin, { name: 'reader', scopes: ['family:read', 'lists:read'] })).body).key
    writeKey = JSON.parse((await call('POST', '/api/api-keys', kevin, { name: 'writer', scopes: ['lists:read', 'lists:write'] })).body).key
  })

  it('rejects an unknown key (401)', async () => {
    expect((await keyCall('GET', '/api/household', 'waffled_not_a_real_key')).statusCode).toBe(401)
  })

  it('resolves the owner tenant on a scoped read', async () => {
    const res = await keyCall('GET', '/api/household', readKey)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.provisioned).toBe(true)
    expect(body.household.id).toBe(householdId)
  })

  it('allows reads within scope, denies reads outside it', async () => {
    expect((await keyCall('GET', '/api/lists', readKey)).statusCode).toBe(200)
    // readKey holds no chores scope → 403
    expect((await keyCall('GET', '/api/chores/today', readKey)).statusCode).toBe(403)
  })

  it('requires :write for mutations', async () => {
    // readKey has lists:read only → POST denied
    expect((await keyCall('POST', '/api/lists', readKey, { name: 'Camping' })).statusCode).toBe(403)
    // writeKey has lists:write → allowed (201)
    expect((await keyCall('POST', '/api/lists', writeKey, { name: 'Camping' })).statusCode).toBe(201)
  })

  it('never allows writes to a read-only resource', async () => {
    expect((await keyCall('PATCH', `/api/persons/${ownerId}`, readKey, { name: 'Kev' })).statusCode).toBe(403)
  })

  it('blocks paths not exposed to keys, including key management', async () => {
    expect((await keyCall('GET', '/api/permissions', readKey)).statusCode).toBe(403)
    expect((await keyCall('GET', '/api/api-keys', readKey)).statusCode).toBe(403)
    expect((await keyCall('POST', '/api/api-keys', readKey, { name: 'x', scopes: ['lists:read'] })).statusCode).toBe(403)
  })

  it('stops working once revoked', async () => {
    const created = JSON.parse((await call('POST', '/api/api-keys', kevin, { name: 'temp', scopes: ['lists:read'] })).body)
    const key = created.key
    expect((await keyCall('GET', '/api/lists', key)).statusCode).toBe(200)
    expect((await call('DELETE', `/api/api-keys/${created.apiKey.id}`, kevin)).statusCode).toBe(204)
    expect((await keyCall('GET', '/api/lists', key)).statusCode).toBe(401)
  })

  it('rejects an expired key', async () => {
    const key = JSON.parse((await call('POST', '/api/api-keys', kevin, { name: 'old', scopes: ['lists:read'], expiresAt: '2000-01-01T00:00:00Z' })).body).key
    expect((await keyCall('GET', '/api/lists', key)).statusCode).toBe(401)
  })
})
