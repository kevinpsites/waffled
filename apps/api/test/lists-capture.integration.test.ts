// Capture Tier 2 — the 'listItem' target (complete / delete on existing list items).
// Real PG (Testcontainers) + app.run, mirroring the goal/chore capture suites: resolve
// ranks the household's live items (subtitle = the list's name so two "Milk"s
// disambiguate), commit checks off or soft-deletes the chosen row.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { Client } from 'pg'
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
  return app.run({ httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false }, {}) as Promise<RunResult>
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

let kevin = ''
let householdId = ''
let costcoId = ''
let groceryMilk = ''
let costcoMilk = ''
let costcoBread = ''

const resolve = (body: unknown) => call('POST', '/api/capture/resolve', kevin, body)
const commit = (body: unknown) => call('POST', '/api/capture/commit', kevin, body)

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
  householdId = JSON.parse(setup.body).household.id

  // Same-named "Milk" on the grocery list AND a custom Costco list → the picker
  // must disambiguate by list name, and commit must act on the exact row chosen.
  const g = await call('POST', '/api/lists/grocery/items', kevin, { name: 'Milk' })
  expect(g.statusCode).toBe(201)
  groceryMilk = JSON.parse(g.body).item.id
  const costco = await call('POST', '/api/lists', kevin, { name: 'Costco' })
  expect(costco.statusCode).toBe(201)
  costcoId = JSON.parse(costco.body).list.id
  const m = await call('POST', `/api/lists/${costcoId}/items`, kevin, { name: 'Milk' })
  costcoMilk = JSON.parse(m.body).item.id
  const b = await call('POST', `/api/lists/${costcoId}/items`, kevin, { name: 'Bread' })
  costcoBread = JSON.parse(b.body).item.id
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

async function costcoItems(): Promise<Array<{ id: string; name: string; checked: boolean }>> {
  const res = await call('GET', `/api/lists/${costcoId}`, kevin)
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.body).items
}

describe('capture listItem — resolve', () => {
  it('ranks live items and disambiguates same names with the list name subtitle', async () => {
    const res = await resolve({ verb: 'complete', targetKind: 'listItem', target: { description: 'milk' }, args: {} })
    expect(res.statusCode).toBe(200)
    const { candidates } = JSON.parse(res.body)
    expect(candidates).toHaveLength(2)
    const ids = candidates.map((c: { id: string }) => c.id).sort()
    expect(ids).toEqual([costcoMilk, groceryMilk].sort())
    const subtitles = candidates.map((c: { subtitle?: string }) => c.subtitle).sort()
    expect(subtitles).toEqual(['Costco', 'Grocery'])
  })

  it('flags a verb the target does not support (log) as unsupported', async () => {
    const res = await resolve({ verb: 'log', targetKind: 'listItem', target: { description: 'milk' }, args: {} })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.candidates).toEqual([])
    expect(body.unsupported).toBe(true)
    expect(body.disabledReason).toMatch(/list item/i)
  })
})

describe('capture listItem — commit complete', () => {
  it('checks off the chosen item (that row, not its same-named twin)', async () => {
    const res = await commit({ verb: 'complete', targetKind: 'listItem', targetId: costcoMilk, args: {} })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.message).toMatch(/Milk/)
    const items = await costcoItems()
    expect(items.find((i) => i.id === costcoMilk)?.checked).toBe(true)
    // the grocery twin is untouched
    const groc = await call('GET', '/api/lists/grocery', kevin)
    const gi = JSON.parse(groc.body).items.find((i: { id: string }) => i.id === groceryMilk)
    expect(gi.checked).toBe(false)
  })

  it('drops already-checked items from later complete candidates', async () => {
    const res = await resolve({ verb: 'complete', targetKind: 'listItem', target: { description: 'milk' }, args: {} })
    const { candidates } = JSON.parse(res.body)
    expect(candidates.map((c: { id: string }) => c.id)).toEqual([groceryMilk])
  })

  it('404s a friendly message for a gone item', async () => {
    const res = await commit({ verb: 'complete', targetKind: 'listItem', targetId: '00000000-0000-4000-8000-000000000000', args: {} })
    expect(res.statusCode).toBe(404)
    expect(typeof JSON.parse(res.body).message).toBe('string')
  })
})

describe('capture listItem — commit delete', () => {
  it('soft-deletes the chosen item and names its list in the message', async () => {
    const res = await commit({ verb: 'delete', targetKind: 'listItem', targetId: costcoBread, args: {} })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.message).toMatch(/Bread/)
    expect(body.message).toMatch(/Costco/)
    const items = await costcoItems()
    expect(items.find((i) => i.id === costcoBread)).toBeUndefined()
  })

  it('no longer resolves the deleted item', async () => {
    const res = await resolve({ verb: 'delete', targetKind: 'listItem', target: { description: 'bread' }, args: {} })
    expect(JSON.parse(res.body).candidates).toEqual([])
  })
})

describe('capture listItem — module gate', () => {
  it('returns candidates:[] + disabledReason when Lists is turned off', async () => {
    await withClient((c) =>
      c.query(`update households set settings = coalesce(settings,'{}'::jsonb) || '{"modules":{"lists":false}}'::jsonb where id=$1`, [householdId])
    )
    try {
      const res = await resolve({ verb: 'complete', targetKind: 'listItem', target: { description: 'milk' }, args: {} })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.candidates).toEqual([])
      expect(body.disabledReason).toBe('Lists is turned off.')
    } finally {
      await withClient((c) =>
        c.query(`update households set settings = coalesce(settings,'{}'::jsonb) || '{"modules":{"lists":true}}'::jsonb where id=$1`, [householdId])
      )
    }
  })
})
