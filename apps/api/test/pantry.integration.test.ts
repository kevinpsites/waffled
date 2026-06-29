// Pantry module CRUD + the module gate, against a real Postgres (Testcontainers).
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
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'nook-local', audience: 'nook-api', expiresIn: '1h' })
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
let householdId = ''

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

describe('pantry module gate', () => {
  it('403s while the module is disabled', async () => {
    expect((await call('GET', '/api/pantry', kevin)).statusCode).toBe(403)
    expect((await call('POST', '/api/pantry', kevin, { name: 'x' })).statusCode).toBe(403)
  })

  it('enables the module (admin)', async () => {
    const res = await call('PATCH', '/api/household/modules', kevin, { pantry: true })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).modules).toMatchObject({ pantry: true })
  })
})

describe('pantry CRUD', () => {
  let itemId = ''

  it('starts empty with the default locations + Today on', async () => {
    const res = await call('GET', '/api/pantry', kevin)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.items).toEqual([])
    expect(body.locations).toEqual(['Freezer', 'Fridge', 'Pantry'])
    expect(body.showOnToday).toBe(true)
  })

  it('adds an item with amount + unit + location', async () => {
    const res = await call('POST', '/api/pantry', kevin, { name: 'Ground beef', amount: '2', unit: 'lbs', location: 'Freezer', expiresOn: '2026-07-10' })
    expect(res.statusCode).toBe(201)
    const item = JSON.parse(res.body).item
    itemId = item.id
    expect(item).toMatchObject({ name: 'Ground beef', amount: '2', unit: 'lbs', location: 'Freezer', expiresOn: '2026-07-10' })
  })

  it('rejects a nameless item and a bad date (400)', async () => {
    expect((await call('POST', '/api/pantry', kevin, { amount: '1' })).statusCode).toBe(400)
    expect((await call('POST', '/api/pantry', kevin, { name: 'Eggs', expiresOn: 'soon' })).statusCode).toBe(400)
  })

  it('lists the item', async () => {
    const body = JSON.parse((await call('GET', '/api/pantry', kevin)).body)
    expect(body.items).toHaveLength(1)
    expect(body.items[0].name).toBe('Ground beef')
  })

  it('updates an item', async () => {
    const res = await call('PATCH', `/api/pantry/${itemId}`, kevin, { amount: '1', note: 'half used' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).item).toMatchObject({ amount: '1', note: 'half used', name: 'Ground beef' })
  })

  it('sets custom locations (adds a garage freezer) via config', async () => {
    const res = await call('PUT', '/api/pantry/config', kevin, { locations: ['Freezer', 'Garage freezer', 'Fridge', 'Pantry'] })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).locations).toContain('Garage freezer')
    const body = JSON.parse((await call('GET', '/api/pantry', kevin)).body)
    expect(body.locations).toContain('Garage freezer')
  })

  it('toggles the Today card off via config (locations preserved)', async () => {
    const res = await call('PUT', '/api/pantry/config', kevin, { showOnToday: false })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).showOnToday).toBe(false)
    const body = JSON.parse((await call('GET', '/api/pantry', kevin)).body)
    expect(body.showOnToday).toBe(false)
    expect(body.locations).toContain('Garage freezer') // not clobbered
  })

  it('deletes an item (204) and it stops listing', async () => {
    expect((await call('DELETE', `/api/pantry/${itemId}`, kevin)).statusCode).toBe(204)
    expect(JSON.parse((await call('GET', '/api/pantry', kevin)).body).items).toEqual([])
  })

  it('404s deleting an unknown id', async () => {
    expect((await call('DELETE', '/api/pantry/00000000-0000-0000-0000-000000000000', kevin)).statusCode).toBe(404)
  })

  it('403s for a caller with no household', async () => {
    expect((await call('GET', '/api/pantry', mint('dev|nobody'))).statusCode).toBe(403)
  })
})
