// Lists domain — migration + api. Shares one Postgres testcontainer + app.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client } from 'pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'nook-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let url: string
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

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/db')).closePool

  await call('POST', '/api/households', kevin, {
    name: 'Sites',
    timezone: 'America/Chicago',
    person: { name: 'Kevin' },
  })
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

describe('lists schema', () => {
  it('creates lists and list_items', async () => {
    const res = await withClient((c) =>
      c.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema='public' and table_name = any($1)`,
        [['lists', 'list_items']]
      )
    )
    expect(res.rows.map((r) => r.table_name).sort()).toEqual(['list_items', 'lists'])
  })

  it('defaults checked to false and enforces the list_id FK', async () => {
    await withClient(async (c) => {
      const h = await c.query<{ id: string }>(
        `insert into households (name, timezone) values ('L','UTC') returning id`
      )
      const hid = h.rows[0].id
      const l = await c.query<{ id: string }>(
        `insert into lists (household_id, name, list_type) values ($1,'Grocery','grocery') returning id`,
        [hid]
      )
      const item = await c.query<{ checked: boolean; checked_at: Date | null }>(
        `insert into list_items (household_id, list_id, name) values ($1,$2,'Milk')
         returning checked, checked_at`,
        [hid, l.rows[0].id]
      )
      expect(item.rows[0].checked).toBe(false)
      expect(item.rows[0].checked_at).toBeNull()

      await expect(
        c.query(`insert into list_items (household_id, list_id, name) values ($1,$2,'Orphan')`, [
          hid,
          '00000000-0000-0000-0000-000000000000',
        ])
      ).rejects.toThrow()
    })
  })
})

describe('grocery api', () => {
  it('403s for a caller with no household', async () => {
    const res = await call('GET', '/api/lists/grocery', mint('dev|nobody'))
    expect(res.statusCode).toBe(403)
  })

  it('GET /api/lists/grocery get-or-creates an empty grocery list', async () => {
    const res = await call('GET', '/api/lists/grocery', kevin)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.list).toMatchObject({ listType: 'grocery' })
    expect(body.items).toEqual([])
  })

  it('POST adds an item, and GET then shows it', async () => {
    const add = await call('POST', '/api/lists/grocery/items', kevin, { name: 'Bananas' })
    expect(add.statusCode).toBe(201)
    expect(JSON.parse(add.body).item).toMatchObject({ name: 'Bananas', checked: false })

    const res = await call('GET', '/api/lists/grocery', kevin)
    const names = JSON.parse(res.body).items.map((i: { name: string }) => i.name)
    expect(names).toContain('Bananas')
  })

  it('rejects an item with no name (400)', async () => {
    const res = await call('POST', '/api/lists/grocery/items', kevin, { quantity: '2' })
    expect(res.statusCode).toBe(400)
  })
})

describe('grocery item mutations', () => {
  let itemId = ''

  beforeAll(async () => {
    const add = await call('POST', '/api/lists/grocery/items', kevin, { name: 'Eggs' })
    itemId = JSON.parse(add.body).item.id
  })

  it('checks and unchecks an item', async () => {
    const checked = await call('PATCH', `/api/list-items/${itemId}`, kevin, { checked: true })
    expect(checked.statusCode).toBe(200)
    const c = JSON.parse(checked.body).item
    expect(c.checked).toBe(true)
    expect(c.checkedAt).not.toBeNull()

    const unchecked = await call('PATCH', `/api/list-items/${itemId}`, kevin, { checked: false })
    const u = JSON.parse(unchecked.body).item
    expect(u.checked).toBe(false)
    expect(u.checkedAt).toBeNull()
  })

  it('rejects a non-boolean checked (400)', async () => {
    expect(
      (await call('PATCH', `/api/list-items/${itemId}`, kevin, { checked: 'yes' })).statusCode
    ).toBe(400)
  })

  it('404s for unknown / non-uuid / another household', async () => {
    expect((await call('PATCH', '/api/list-items/not-a-uuid', kevin, { checked: true })).statusCode).toBe(404)
    expect(
      (await call('PATCH', '/api/list-items/00000000-0000-0000-0000-000000000000', kevin, { checked: true }))
        .statusCode
    ).toBe(404)
    const kelly = mint('dev|kelly')
    await call('POST', '/api/households', kelly, { name: 'K', timezone: 'UTC', person: { name: 'Kelly' } })
    expect((await call('PATCH', `/api/list-items/${itemId}`, kelly, { checked: true })).statusCode).toBe(404)
  })

  it('soft-deletes an item', async () => {
    expect((await call('DELETE', `/api/list-items/${itemId}`, kevin)).statusCode).toBe(204)
    const names = JSON.parse((await call('GET', '/api/lists/grocery', kevin)).body).items.map(
      (i: { name: string }) => i.name
    )
    expect(names).not.toContain('Eggs')
    expect((await call('DELETE', `/api/list-items/${itemId}`, kevin)).statusCode).toBe(404)
  })
})

describe('lists sidebar + custom-list CRUD', () => {
  it('GET /api/lists seeds + returns the grocery list with a live count', async () => {
    const res = await call('GET', '/api/lists', kevin)
    expect(res.statusCode).toBe(200)
    const lists = JSON.parse(res.body).lists as Array<{ name: string; listType: string; itemCount: number }>
    const groc = lists.find((l) => l.listType === 'grocery')
    expect(groc).toBeTruthy()
    expect(groc!.name).toBe('Grocery') // seeded name (Today's Grocery card depends on this)
    // grocery list sorts first in the rail
    expect(lists[0].listType).toBe('grocery')
  })

  it('requires a tenant', async () => {
    expect((await call('GET', '/api/lists')).statusCode).toBe(401)
  })

  it('creates → renames → deletes a named list', async () => {
    const created = await call('POST', '/api/lists', kevin, { name: 'Lake trip packing', emoji: '🧳' })
    expect(created.statusCode).toBe(201)
    const list = JSON.parse(created.body).list
    expect(list).toMatchObject({ name: 'Lake trip packing', emoji: '🧳', listType: 'custom' })

    // shows in the sidebar with a zero count
    const sidebar = JSON.parse((await call('GET', '/api/lists', kevin)).body).lists as Array<{ id: string; itemCount: number }>
    expect(sidebar.find((l) => l.id === list.id)?.itemCount).toBe(0)

    const renamed = await call('PATCH', `/api/lists/${list.id}`, kevin, { name: 'Lake packing', emoji: '🏖️' })
    expect(renamed.statusCode).toBe(200)
    expect(JSON.parse(renamed.body).list).toMatchObject({ name: 'Lake packing', emoji: '🏖️' })

    expect((await call('DELETE', `/api/lists/${list.id}`, kevin)).statusCode).toBe(204)
    expect((await call('GET', `/api/lists/${list.id}`, kevin)).statusCode).toBe(404)
  })

  it('rejects an empty list name (400) and 404s bad ids', async () => {
    expect((await call('POST', '/api/lists', kevin, { name: '  ' })).statusCode).toBe(400)
    expect((await call('GET', '/api/lists/not-a-uuid', kevin)).statusCode).toBe(404)
    expect((await call('GET', '/api/lists/00000000-0000-0000-0000-000000000000', kevin)).statusCode).toBe(404)
  })
})

describe('list items — sections, quantity, assignee', () => {
  let listId = ''
  let kellyId = ''
  let itemId = ''

  beforeAll(async () => {
    const p = await call('POST', '/api/persons', kevin, {
      name: 'Kelly',
      memberType: 'adult',
      avatarEmoji: '🦊',
      colorHex: '#EC6049',
    })
    kellyId = JSON.parse(p.body).person.id
    listId = JSON.parse((await call('POST', '/api/lists', kevin, { name: 'Packing', emoji: '🧳' })).body).list.id
  })

  it('adds an item with section, quantity and assignee (resolves the avatar)', async () => {
    const res = await call('POST', `/api/lists/${listId}/items`, kevin, {
      name: 'Swimsuits',
      quantity: '×4',
      category: 'Clothes',
      assignedTo: kellyId,
    })
    expect(res.statusCode).toBe(201)
    const item = JSON.parse(res.body).item
    expect(item).toMatchObject({ name: 'Swimsuits', quantity: '×4', section: 'Clothes' })
    expect(item.assignee).toMatchObject({ personId: kellyId, avatarEmoji: '🦊', colorHex: '#EC6049' })
    itemId = item.id
  })

  it('returns items with their sections in the list detail', async () => {
    await call('POST', `/api/lists/${listId}/items`, kevin, { name: 'Sunscreen', category: 'Gear' })
    const res = await call('GET', `/api/lists/${listId}`, kevin)
    const items = JSON.parse(res.body).items as Array<{ name: string; section: string | null }>
    expect(items.map((i) => i.name).sort()).toEqual(['Sunscreen', 'Swimsuits'])
    expect(new Set(items.map((i) => i.section))).toEqual(new Set(['Clothes', 'Gear']))
  })

  it('rejects an item with no name (400) and 404s an unknown list', async () => {
    expect((await call('POST', `/api/lists/${listId}/items`, kevin, { name: '' })).statusCode).toBe(400)
    expect(
      (await call('POST', `/api/lists/00000000-0000-0000-0000-000000000000/items`, kevin, { name: 'X' })).statusCode
    ).toBe(404)
  })

  it('patches an item: reassign + re-quantity, then clears the assignee', async () => {
    const re = await call('PATCH', `/api/list-items/${itemId}`, kevin, { quantity: '×2', assignedTo: null })
    expect(re.statusCode).toBe(200)
    const item = JSON.parse(re.body).item
    expect(item.quantity).toBe('×2')
    expect(item.assignee).toBeNull()
  })

  it('rejects a patch with no known fields (400)', async () => {
    expect((await call('PATCH', `/api/list-items/${itemId}`, kevin, { bogus: 1 })).statusCode).toBe(400)
  })
})

describe('grocery auto-build from a recipe', () => {
  let recipeId = ''

  beforeAll(async () => {
    const r = await call('POST', '/api/recipes', kevin, { title: 'Chorizo Tacos', emoji: '🌮' })
    recipeId = JSON.parse(r.body).recipe.id
    await call('POST', `/api/recipes/${recipeId}/ingredients`, kevin, {
      ingredients: [
        { name: 'Tortillas', amount: 8, unit: 'count' },
        { name: 'Chorizo', amount: 1, unit: 'lb' },
        { name: 'Bananas' }, // already on the list from the 'grocery api' describe → skip
      ],
    })
  })

  it("adds a recipe's ingredients, skipping duplicates", async () => {
    const res = await call('POST', `/api/lists/grocery/from-recipe/${recipeId}`, kevin)
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body).added).toBe(2) // Tortillas + Chorizo; Bananas skipped

    const names = JSON.parse((await call('GET', '/api/lists/grocery', kevin)).body).items.map(
      (i: { name: string }) => i.name
    )
    expect(names).toContain('Tortillas')
    expect(names).toContain('Chorizo')
    expect(names.filter((n: string) => n === 'Bananas')).toHaveLength(1)
  })

  it('404 for an unknown recipe', async () => {
    expect(
      (await call('POST', '/api/lists/grocery/from-recipe/00000000-0000-0000-0000-000000000000', kevin))
        .statusCode
    ).toBe(404)
  })
})
