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

// Provisioned via /api/auth/setup in beforeAll (first-run onboarding).
let kevin = ''

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  process.env.LOCAL_JWT_SECRET = SECRET
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  const db = await import('../src/platform/db')
  closePool = db.closePool
  const query = db.query

  // First-run onboarding: creates the first household + owner admin, returns a token.
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  kevin = JSON.parse(setup.body).accessToken

  // Second tenant for the cross-household isolation test. Setup is now locked, so
  // seed kelly's household directly; mint('dev|kelly') resolves via this identity.
  const kh = await query<{ id: string }>(`insert into households (name, timezone) values ('K','UTC') returning id`)
  const kHid = kh.rows[0].id
  const kp = await query<{ id: string }>(
    `insert into persons (household_id, name, member_type, is_admin) values ($1,'Kelly','adult',true) returning id`,
    [kHid]
  )
  const kPid = kp.rows[0].id
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email, email_verified)
     values ($1,$2,'password','dev|kelly','kelly@example.com',true)`,
    [kHid, kPid]
  )
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

  it('attributes a hand-added item to the acting person (addedBy) and marks it manual', async () => {
    const kevinId = (
      await withClient((c) => c.query<{ id: string }>(`select id from persons where name='Kevin' limit 1`))
    ).rows[0].id

    const add = await call('POST', '/api/lists/grocery/items', kevin, { name: 'Yogurt' })
    expect(add.statusCode).toBe(201)
    const created = JSON.parse(add.body).item
    expect(created.source).toBe('manual')
    expect(created.sourceRecipeIds).toEqual([])
    expect(created.addedBy).toMatchObject({ personId: kevinId, name: 'Kevin' })

    // and the attribution survives a read-back
    const item = JSON.parse((await call('GET', '/api/lists/grocery', kevin)).body).items.find(
      (i: { name: string }) => i.name === 'Yogurt'
    )
    expect(item.source).toBe('manual')
    expect(item.addedBy).toMatchObject({ personId: kevinId, name: 'Kevin' })
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
    const kelly = mint('dev|kelly') // resolves via the identity seeded in beforeAll
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

  it('deleting a list cascades to its items — no orphans left behind', async () => {
    const list = JSON.parse((await call('POST', '/api/lists', kevin, { name: 'Costco run' })).body).list
    await call('POST', `/api/lists/${list.id}/items`, kevin, { name: 'Paper towels' })
    await call('POST', `/api/lists/${list.id}/items`, kevin, { name: 'Rotisserie chicken' })

    // grab one item id to prove it's gone after the list delete
    const items = JSON.parse((await call('GET', `/api/lists/${list.id}`, kevin)).body).items
    expect(items).toHaveLength(2)
    const itemId = items[0].id

    expect((await call('DELETE', `/api/lists/${list.id}`, kevin)).statusCode).toBe(204)

    // the item is soft-deleted with the list, not orphaned (live)
    const row = await withClient((c) => c.query(`select deleted_at from list_items where id=$1`, [itemId]))
    expect(row.rows[0].deleted_at).not.toBeNull()
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

    const items = JSON.parse((await call('GET', '/api/lists/grocery', kevin)).body).items
    const names = items.map((i: { name: string }) => i.name)
    expect(names).toContain('Tortillas')
    expect(names).toContain('Chorizo')
    expect(names.filter((n: string) => n === 'Bananas')).toHaveLength(1)

    // auto-built items carry source='auto', the originating recipe, and the actor
    const kevinId = (
      await withClient((c) => c.query<{ id: string }>(`select id from persons where name='Kevin' limit 1`))
    ).rows[0].id
    const tortillas = items.find((i: { name: string }) => i.name === 'Tortillas')
    expect(tortillas.source).toBe('auto')
    expect(tortillas.sourceRecipeIds).toContain(recipeId)
    expect(tortillas.addedBy).toMatchObject({ personId: kevinId, name: 'Kevin' })
  })

  it('404 for an unknown recipe', async () => {
    expect(
      (await call('POST', '/api/lists/grocery/from-recipe/00000000-0000-0000-0000-000000000000', kevin))
        .statusCode
    ).toBe(404)
  })

  it('bumps the quantity when two recipes need the same item (no silent skip)', async () => {
    const mk = async (title: string) => {
      const r = await call('POST', '/api/recipes', kevin, { title, emoji: '🍋' })
      const rid = JSON.parse(r.body).recipe.id
      await call('POST', `/api/recipes/${rid}/ingredients`, kevin, {
        ingredients: [{ name: 'Limes', amount: 1, unit: 'count' }],
      })
      return rid
    }
    const a = await mk('Lime Tart A')
    const b = await mk('Lime Tart B')
    await call('POST', `/api/lists/grocery/from-recipe/${a}`, kevin)
    await call('POST', `/api/lists/grocery/from-recipe/${b}`, kevin)
    const items = JSON.parse((await call('GET', '/api/lists/grocery', kevin)).body).items
    const limes = items.filter((i: { name: string }) => i.name === 'Limes')
    expect(limes).toHaveLength(1) // one row, not two
    expect(limes[0].quantity).toBe('2 count') // 1 + 1 summed
  })

  it('leaves pantry staples off the list', async () => {
    const r = await call('POST', '/api/recipes', kevin, { title: 'Garlic Bread', emoji: '🧄' })
    const rid = JSON.parse(r.body).recipe.id
    await call('POST', `/api/recipes/${rid}/ingredients`, kevin, {
      ingredients: [
        { name: 'Garlic', amount: 3, unit: 'clove' }, // staple → skipped
        { name: 'Baguette', amount: 1 },
      ],
    })
    await call('POST', `/api/lists/grocery/from-recipe/${rid}`, kevin)
    const names = JSON.parse((await call('GET', '/api/lists/grocery', kevin)).body).items.map((i: { name: string }) => i.name)
    expect(names).toContain('Baguette')
    expect(names).not.toContain('Garlic')
  })

  it('shops for the substitution, not the original ingredient', async () => {
    const r = await call('POST', '/api/recipes', kevin, { title: 'Turkey Burgers', emoji: '🍔' })
    const rid = JSON.parse(r.body).recipe.id
    await call('POST', `/api/recipes/${rid}/ingredients`, kevin, {
      ingredients: [{ name: 'Ground turkey', amount: 1, unit: 'lb' }],
    })
    await call('PATCH', `/api/recipes/${rid}`, kevin, { overrides: { subs: { 'ground turkey': 'ground chicken' } } })

    const res = await call('POST', `/api/lists/grocery/from-recipe/${rid}`, kevin)
    expect(res.statusCode).toBe(201)
    const names = JSON.parse((await call('GET', '/api/lists/grocery', kevin)).body).items.map(
      (i: { name: string }) => i.name
    )
    expect(names).toContain('ground chicken') // the swap
    expect(names).not.toContain('Ground turkey') // not the original
  })
})

function thisSunday(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - d.getDay())
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Runs last so its auto-built items don't pollute the earlier "empty grocery" test.
describe('grocery auto-build + pantry staples', () => {
  it('builds the grocery list from the week, aggregating + excluding staples', async () => {
    const householdId = (await withClient((c) => c.query<{ id: string }>(`select id from households limit 1`))).rows[0].id
    const recipeId = (
      await withClient((c) =>
        c.query<{ id: string }>(
          `insert into recipes (household_id, title, category, servings) values ($1,'Test Salmon','dinner',4) returning id`,
          [householdId]
        )
      )
    ).rows[0].id
    await withClient((c) =>
      c.query(
        `insert into recipe_ingredients (household_id, recipe_id, name, amount, unit, aisle, is_staple) values
           ($1,$2,'Salmon fillets',1.5,'lb','Meat & Seafood',false),
           ($1,$2,'Olive oil',2,'Tbsp','Pantry',true)`,
        [householdId, recipeId]
      )
    )

    const ws = thisSunday()
    const planDate = (() => {
      const d = new Date(ws + 'T00:00:00Z')
      d.setUTCDate(d.getUTCDate() + 1)
      return d.toISOString().slice(0, 10)
    })()
    expect((await call('POST', '/api/meals/plan', kevin, { date: planDate, mealType: 'dinner', recipeId })).statusCode).toBeLessThan(300)

    const rebuilt = await call('POST', `/api/lists/grocery/rebuild?weekStart=${ws}`, kevin)
    expect(rebuilt.statusCode).toBe(200)
    const board = JSON.parse(rebuilt.body).board
    const names = board.items.map((i: { name: string }) => i.name)
    expect(names).toContain('Salmon fillets')
    expect(names).not.toContain('Olive oil')
    const salmon = board.items.find((i: { name: string }) => i.name === 'Salmon fillets')
    expect(salmon).toMatchObject({ aisle: 'Meat & Seafood', quantity: '1.5 lb', source: 'auto' })
    expect(salmon.sourceRecipeIds).toContain(recipeId)
    expect(board.meals.some((d: { recipeId: string; mealType: string }) => d.recipeId === recipeId && d.mealType === 'dinner')).toBe(true)
  })

  it('manages pantry staples (defaults, add, delete)', async () => {
    const staples = JSON.parse((await call('GET', '/api/pantry-staples', kevin)).body).staples
    expect(staples.map((s: { name: string }) => s.name)).toContain('Olive oil')
    const add = await call('POST', '/api/pantry-staples', kevin, { name: 'Quinoa' })
    expect(add.statusCode).toBe(201)
    const id = JSON.parse(add.body).staple.id
    expect((await call('DELETE', `/api/pantry-staples/${id}`, kevin)).statusCode).toBe(204)
    expect((await call('POST', '/api/pantry-staples', kevin, {})).statusCode).toBe(400)
  })
})
