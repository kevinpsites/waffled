// Mealie integration — connection, client error mapping. Shares one Postgres container + a fake Mealie.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { startFakeMealie, type FakeMealie } from './helpers/fake-mealie'
import { Client } from 'pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'
import { __resetMealieCache } from '../src/modules/mealie/mealie-cache'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let fake: FakeMealie
let kevinId = ''
let householdId = ''

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
const kid = mint('dev|kid')

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

const connect = (extra: Record<string, unknown> = {}) =>
  call('PUT', '/api/mealie/connection', kevin, { baseUrl: fake.url + '/', token: fake.token, ...extra })

const disconnect = () => call('DELETE', '/api/mealie/connection', kevin)

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64')
  delete process.env.AUTH0_DOMAIN
  fake = await startFakeMealie()
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  kevinId = JSON.parse(setup.body).person.id
  householdId = JSON.parse(setup.body).household.id
  await withClient(async (c) => {
    await c.query(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
      [householdId, kevinId]
    )
    const p = await c.query<{ id: string }>(
      `insert into persons (household_id, name, member_type, is_admin) values ($1, 'Kiddo', 'kid', false) returning id`,
      [householdId]
    )
    await c.query(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kid',true)`,
      [householdId, p.rows[0].id]
    )
  })
})

afterAll(async () => {
  await fake?.close()
  await closePool?.()
  await pg?.stop()
})

beforeEach(async () => {
  fake.state.down = false
  fake.state.version = '3.29.0'
  fake.token = 'fake-mealie-api-token'
  fake.state.requests.length = 0
  fake.state.mealplans = []
  fake.state.items = []
  fake.state.failItemPut = false
  fake.state.recipes = []
  fake.state.images = {}
  __resetMealieCache()
  await disconnect()
})

describe('mealie schema', () => {
  it('creates mealie_connections', async () => {
    const res = await withClient((c) => c.query(`select 1 from information_schema.tables where table_schema='public' and table_name='mealie_connections'`))
    expect(res.rowCount).toBe(1)
  })

  it('nulls connected_by when the person is deleted, keeping the row', async () => {
    await withClient(async (c) => {
      const p = await c.query<{ id: string }>(
        `insert into persons (household_id, name, member_type) values ($1, 'Temp', 'adult') returning id`,
        [householdId]
      )
      await c.query(
        `insert into mealie_connections (household_id, base_url, token_encrypted, connected_by) values ($1,'http://x','enc',$2)`,
        [householdId, p.rows[0].id]
      )
      await c.query(`delete from persons where id = $1`, [p.rows[0].id])
      const after = await c.query<{ connected_by: string | null }>(`select connected_by from mealie_connections where household_id = $1`, [householdId])
      expect(after.rowCount).toBe(1)
      expect(after.rows[0].connected_by).toBeNull()
    })
  })
})

describe('mealie connection', () => {
  it('connects, hides the token and stores it encrypted', async () => {
    const res = await connect()
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ connected: true, baseUrl: fake.url, mealieVersion: '3.29.0', shoppingListId: null })
    expect(res.body).not.toContain(fake.token)
    const row = await withClient((c) => c.query<{ token_encrypted: string }>(`select token_encrypted from mealie_connections where household_id = $1`, [householdId]))
    expect(row.rows[0].token_encrypted).not.toBe(fake.token)
    expect(row.rows[0].token_encrypted).not.toContain(fake.token)
  })

  it('rejects Mealie older than 2.0', async () => {
    fake.state.version = '1.12.0'
    const res = await connect()
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toBe('Mealie 2.0 or newer is required')
  })

  it('rejects a v-prefixed pre-2.0 version', async () => {
    fake.state.version = 'v1.12.0'
    const res = await connect()
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toBe('Mealie 2.0 or newer is required')
  })

  it('accepts a nightly version string', async () => {
    fake.state.version = 'nightly'
    expect((await connect()).statusCode).toBe(200)
  })

  it('rejects a bad token and stores nothing', async () => {
    const res = await connect({ token: 'wrong' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toBe('Mealie rejected that token')
    const rows = await withClient((c) => c.query(`select 1 from mealie_connections where household_id = $1`, [householdId]))
    expect(rows.rowCount).toBe(0)
  })

  it.each(['ftp://x', 'http://u:p@x', 'not a url'])('rejects the URL %s', async (baseUrl) => {
    expect((await connect({ baseUrl })).statusCode).toBe(400)
  })

  it('keeps the stored token when re-saved without one', async () => {
    await connect()
    const res = await call('PUT', '/api/mealie/connection', kevin, { baseUrl: fake.url })
    expect(res.statusCode).toBe(200)
    expect((await call('GET', '/api/mealie/shopping-lists', kevin)).statusCode).toBe(200)
    const auths = fake.state.requests.filter((r) => r.path.startsWith('/api/users/self')).map((r) => r.auth)
    expect(auths).toEqual([`Bearer ${fake.token}`, `Bearer ${fake.token}`])
  })

  it('lets a kid read status but not change it', async () => {
    await connect()
    const get = await call('GET', '/api/mealie/connection', kid)
    expect(get.statusCode).toBe(200)
    expect(JSON.parse(get.body)).toMatchObject({ connected: true })
    expect(get.body).not.toContain(fake.token)
    expect((await call('PUT', '/api/mealie/connection', kid, { baseUrl: fake.url, token: fake.token })).statusCode).toBe(403)
    expect((await call('DELETE', '/api/mealie/connection', kid)).statusCode).toBe(403)
  })

  it('lists shopping lists and stores the chosen list id and name', async () => {
    await connect()
    const lists = await call('GET', '/api/mealie/shopping-lists', kevin)
    expect(JSON.parse(lists.body)).toEqual([{ id: 'list-1', name: 'Groceries' }, { id: 'list-2', name: 'Costco' }])
    const put = await call('PUT', '/api/mealie/connection', kevin, { baseUrl: fake.url, shoppingListId: 'list-2' })
    expect(JSON.parse(put.body)).toMatchObject({ shoppingListId: 'list-2', shoppingListName: 'Costco' })
    const row = await withClient((c) => c.query(`select shopping_list_id, shopping_list_name from mealie_connections where household_id = $1`, [householdId]))
    expect(row.rows[0]).toEqual({ shopping_list_id: 'list-2', shopping_list_name: 'Costco' })
  })

  it('disconnects', async () => {
    await connect()
    expect((await disconnect()).statusCode).toBe(204)
    expect(JSON.parse((await call('GET', '/api/mealie/connection', kevin)).body)).toEqual({ connected: false })
  })
})

describe('mealie client errors', () => {
  it('maps an unreachable Mealie to 502 MealieUnavailable', async () => {
    await connect()
    fake.state.down = true
    const res = await call('GET', '/api/mealie/shopping-lists', kevin)
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body).error).toBe('MealieUnavailable')
  })

  it('maps a revoked token to 502 MealieAuthFailed without leaking it', async () => {
    await connect()
    const old = fake.token
    fake.token = 'rotated-token'
    const res = await call('GET', '/api/mealie/shopping-lists', kevin)
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body).error).toBe('MealieAuthFailed')
    expect(res.body).not.toContain(old)
  })
})

const RID = '3f2b8a52-9d3e-4c1a-8f6e-0a1b2c3d4e5f'
const RID2 = '4a2b8a52-9d3e-4c1a-8f6e-0a1b2c3d4e5f'
const planPaths = () => fake.state.requests.filter((r) => r.path.startsWith('/api/households/mealplans'))

describe('mealie meal plan read', () => {
  it('sorts by date then meal order, falls back to the recipe name, and forwards the range', async () => {
    await connect()
    const recipe = { id: RID, slug: 'soup', name: 'Soup', image: 'abc' }
    fake.state.mealplans = [
      { id: 3, date: '2026-05-04', entryType: 'side', title: 'Rolls', recipe: null },
      { id: 1, date: '2026-05-04', entryType: 'dinner', title: '', recipe },
      { id: 2, date: '2026-05-04', entryType: 'breakfast', title: 'Eggs', recipe: null },
      { id: 4, date: '2026-05-04', entryType: 'snack', title: 'Chips', recipe: null },
    ]
    const res = await call('GET', '/api/mealie/mealplan?start=2026-05-01&end=2026-05-07', kid)
    expect(res.statusCode).toBe(200)
    const { entries } = JSON.parse(res.body)
    expect(entries.map((e: { id: number }) => e.id)).toEqual([2, 1, 3, 4])
    expect(entries[1]).toMatchObject({ title: 'Soup', recipe: { id: RID, slug: 'soup', name: 'Soup', imageUrl: `/api/mealie/images/${RID}/min` } })
    expect(entries[0].recipe).toBeNull()
    const seen = planPaths()[0].path
    expect(seen).toContain('start_date=2026-05-01')
    expect(seen).toContain('end_date=2026-05-07')
  })

  it('gives a null imageUrl when the recipe has no image', async () => {
    await connect()
    fake.state.mealplans = [{ id: 1, date: '2026-05-04', entryType: 'dinner', title: 'X', recipe: { id: RID, slug: 's', name: 'S', image: null } }]
    const { entries } = JSON.parse((await call('GET', '/api/mealie/mealplan?start=2026-05-01&end=2026-05-07', kid)).body)
    expect(entries[0].recipe.imageUrl).toBeNull()
  })

  it('rejects a range over 62 days and a bad date', async () => {
    await connect()
    expect((await call('GET', '/api/mealie/mealplan?start=2026-01-01&end=2026-03-05', kid)).statusCode).toBe(400)
    expect((await call('GET', '/api/mealie/mealplan?start=2026-01-01&end=2026-03-03', kid)).statusCode).toBe(200)
    expect((await call('GET', '/api/mealie/mealplan?start=05/01/2026&end=2026-05-07', kid)).statusCode).toBe(400)
    expect((await call('GET', '/api/mealie/mealplan?end=2026-05-07', kid)).statusCode).toBe(400)
  })

  it('returns 409 MealieNotConnected without a connection', async () => {
    const res = await call('GET', '/api/mealie/mealplan?start=2026-05-01&end=2026-05-07', kid)
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toBe('MealieNotConnected')
  })

  it('serves a second read within the TTL from the cache', async () => {
    await connect()
    const path = '/api/mealie/mealplan?start=2026-05-01&end=2026-05-07'
    await call('GET', path, kid)
    await call('GET', path, kid)
    expect(planPaths()).toHaveLength(1)
  })

  it('drops the cache when the connection is deleted', async () => {
    await connect()
    const path = '/api/mealie/mealplan?start=2026-05-01&end=2026-05-07'
    await call('GET', path, kid)
    await disconnect()
    await connect()
    await call('GET', path, kid)
    expect(planPaths()).toHaveLength(2)
  })
})

describe('mealie recipes read', () => {
  const recipe = (n: number, extra: Record<string, unknown> = {}) => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, slug: `r-${n}`, name: `Recipe ${n}`, image: 'x', description: 'd', totalTime: '30 min', ...extra,
  })

  it('forwards search, page and perPage, and maps the page', async () => {
    await connect()
    fake.state.recipes = [recipe(1, { name: 'Tomato soup' }), recipe(2, { name: 'Pasta', image: null })]
    const res = await call('GET', '/api/mealie/recipes?search=soup&page=2', kid)
    expect(res.statusCode).toBe(200)
    const sent = fake.state.requests.find((r) => r.path.startsWith('/api/recipes?'))!.path
    expect(sent).toContain('search=soup')
    expect(sent).toContain('page=2')
    expect(sent).toContain('perPage=24')
    expect(sent).not.toContain('orderBy')
    const all = JSON.parse((await call('GET', '/api/mealie/recipes', kid)).body)
    expect(fake.state.requests.filter((r) => r.path.startsWith('/api/recipes?')).at(-1)!.path).toContain('orderBy=name')
    expect(all).toMatchObject({ page: 1, totalPages: 1 })
    expect(all.items[0]).toEqual({ id: recipe(1).id, slug: 'r-1', name: 'Tomato soup', imageUrl: `/api/mealie/images/${recipe(1).id}/min`, totalTime: '30 min', description: 'd' })
    expect(all.items[1].imageUrl).toBeNull()
  })

  it('maps recipe detail and builds mealieUrl from publicUrl when set', async () => {
    await connect({ publicUrl: 'https://mealie.example.com' })
    fake.state.recipes = [recipe(1, {
      recipeServings: 4, recipeYield: '4 servings',
      recipeIngredient: [{ title: 'Sauce', display: '1 cup tomatoes', note: 'x' }, { title: null, display: '2 onions' }],
      recipeInstructions: [{ title: '', text: 'Chop.' }, { title: 'Cook', text: 'Simmer.' }],
    })]
    const res = await call('GET', '/api/mealie/recipes/r-1', kid)
    expect(res.statusCode).toBe(200)
    const { recipe: r } = JSON.parse(res.body)
    expect(r).toMatchObject({ slug: 'r-1', recipeYield: '4 servings', mealieUrl: 'https://mealie.example.com/r/r-1' })
    expect(r.ingredients).toEqual([{ title: 'Sauce', display: '1 cup tomatoes' }, { title: null, display: '2 onions' }])
    expect(r.steps).toEqual([{ title: null, text: 'Chop.' }, { title: 'Cook', text: 'Simmer.' }])
  })

  it('falls back to the base URL for mealieUrl', async () => {
    await connect()
    fake.state.recipes = [recipe(1)]
    const { recipe: r } = JSON.parse((await call('GET', '/api/mealie/recipes/r-1', kid)).body)
    expect(r.mealieUrl).toBe(`${fake.url}/r/r-1`)
  })

  it('returns 404 for a missing slug', async () => {
    await connect()
    expect((await call('GET', '/api/mealie/recipes/nope', kid)).statusCode).toBe(404)
  })
})

describe('mealie image proxy', () => {
  it('fetches the fixed file, returns the bytes with content-type and cache headers', async () => {
    await connect()
    const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 250, 251])
    fake.state.images[RID] = bytes
    const res = await call('GET', `/api/mealie/images/${RID}/min`, kid)
    expect(res.statusCode).toBe(200)
    const r = res as unknown as { headers: Record<string, string>; isBase64Encoded: boolean }
    expect(r.isBase64Encoded).toBe(true)
    expect(Buffer.from(res.body, 'base64').equals(bytes)).toBe(true)
    expect(r.headers['content-type']).toBe('image/webp')
    expect(r.headers['cache-control']).toBe('private, max-age=3600')
    expect(fake.state.requests.some((q) => q.path === `/api/media/recipes/${RID}/images/min-original.webp`)).toBe(true)
  })

  it('maps original and tiny sizes', async () => {
    await connect()
    fake.state.images[RID] = Buffer.from([1])
    await call('GET', `/api/mealie/images/${RID}/original`, kid)
    await call('GET', `/api/mealie/images/${RID}/tiny`, kid)
    const paths = fake.state.requests.map((q) => q.path)
    expect(paths).toContain(`/api/media/recipes/${RID}/images/original.webp`)
    expect(paths).toContain(`/api/media/recipes/${RID}/images/tiny-original.webp`)
  })

  it('rejects an unknown size and a non-uuid id, and 404s an unknown image', async () => {
    await connect()
    expect((await call('GET', `/api/mealie/images/${RID}/huge`, kid)).statusCode).toBe(400)
    expect((await call('GET', '/api/mealie/images/not-a-uuid/min', kid)).statusCode).toBe(400)
    expect((await call('GET', `/api/mealie/images/${RID2}/min`, kid)).statusCode).toBe(404)
  })
})

const shopReqs = (method?: string) =>
  fake.state.requests.filter((r) => r.path.startsWith('/api/households/shopping') && (!method || r.method === method))
const shopGets = () => shopReqs('GET').filter((r) => r.path.startsWith('/api/households/shopping/lists/'))
const item = (id: string, over: Record<string, unknown> = {}) => ({
  id, shoppingListId: 'list-1', note: id, display: id, quantity: 1, checked: false, position: 0, label: null, ...over,
})

describe('mealie shopping list', () => {
  it('sorts unchecked first, then label name (nulls last), then position', async () => {
    await connect({ shoppingListId: 'list-1' })
    fake.state.items = [
      item('done', { checked: true, position: 0 }),
      item('nolabel', { position: 0 }),
      item('dairy2', { position: 2, label: { name: 'Dairy', color: '#fff' } }),
      item('produce', { position: 0, label: { name: 'Produce', color: '#0f0' } }),
      item('dairy1', { position: 1, label: { name: 'Dairy', color: '#fff' } }),
      item('other-list', { shoppingListId: 'list-2' }),
    ]
    const res = await call('GET', '/api/mealie/shopping', kid)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.listId).toBe('list-1')
    expect(body.listName).toBe('Groceries')
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(['dairy1', 'dairy2', 'produce', 'nolabel', 'done'])
    expect(body.items[0]).toEqual({ id: 'dairy1', display: 'dairy1', checked: false, label: { name: 'Dairy', color: '#fff' }, position: 1 })
  })

  it('409s MealieNoShoppingList when no list is chosen', async () => {
    await connect()
    const res = await call('GET', '/api/mealie/shopping', kid)
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toBe('MealieNoShoppingList')
  })

  it('409s MealieNotConnected with no connection', async () => {
    const res = await call('GET', '/api/mealie/shopping', kid)
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toBe('MealieNotConnected')
  })

  it('adds an item as a note on the chosen list, and clears the cache', async () => {
    await connect({ shoppingListId: 'list-1' })
    await call('GET', '/api/mealie/shopping', kid)
    const res = await call('POST', '/api/mealie/shopping/items', kid, { text: '  milk ' })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
    const post = shopReqs('POST')[0]
    expect(post.path).toBe('/api/households/shopping/items')
    expect(post.body).toEqual({ shoppingListId: 'list-1', note: 'milk' })
    const before = shopGets().length
    const after = JSON.parse((await call('GET', '/api/mealie/shopping', kid)).body)
    expect(shopGets().length).toBe(before + 1)
    expect(after.items.map((i: { display: string }) => i.display)).toEqual(['milk'])
  })

  it('rejects blank and over-long text', async () => {
    await connect({ shoppingListId: 'list-1' })
    expect((await call('POST', '/api/mealie/shopping/items', kid, { text: '  ' })).statusCode).toBe(400)
    expect((await call('POST', '/api/mealie/shopping/items', kid, { text: 'x'.repeat(201) })).statusCode).toBe(400)
    expect((await call('POST', '/api/mealie/shopping/items', kid, {})).statusCode).toBe(400)
    expect((await call('POST', '/api/mealie/shopping/items', kid, { text: 'x'.repeat(200) })).statusCode).toBe(201)
  })

  it('409s on add when no list is chosen', async () => {
    await connect()
    expect((await call('POST', '/api/mealie/shopping/items', kid, { text: 'milk' })).statusCode).toBe(409)
  })

  it('checks an item by GET then a PUT of the full item, and clears the cache', async () => {
    await connect({ shoppingListId: 'list-1' })
    const original = item('i1', { note: 'eggs', quantity: 12, label: { name: 'Dairy', color: '#fff' }, labelId: 'l1' })
    fake.state.items = [original]
    await call('GET', '/api/mealie/shopping', kid)
    fake.state.requests.length = 0
    const res = await call('PATCH', '/api/mealie/shopping/items/i1', kid, { checked: true })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
    expect(shopReqs().map((r) => r.method)).toEqual(['GET', 'PUT'])
    const put = shopReqs('PUT')[0]
    expect(put.path).toBe('/api/households/shopping/items/i1')
    expect(put.body).toEqual({ ...original, checked: true })
    expect(fake.state.items[0]).toEqual({ ...original, checked: true })
    fake.state.requests.length = 0
    await call('GET', '/api/mealie/shopping', kid)
    expect(shopGets().length).toBe(1)
  })

  it('maps a Mealie 422 on check to 400, and rejects a non-boolean checked', async () => {
    await connect({ shoppingListId: 'list-1' })
    fake.state.items = [item('i1')]
    fake.state.failItemPut = true
    const res = await call('PATCH', '/api/mealie/shopping/items/i1', kid, { checked: true })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toBe('Unprocessable item')
    expect((await call('PATCH', '/api/mealie/shopping/items/i1', kid, { checked: 'yes' })).statusCode).toBe(400)
  })

  it('404s checking an unknown item', async () => {
    await connect({ shoppingListId: 'list-1' })
    expect((await call('PATCH', '/api/mealie/shopping/items/nope', kid, { checked: true })).statusCode).toBe(404)
  })
})

describe('mealie meal plan writes', () => {
  const RECIPE = '11111111-2222-3333-4444-555555555555'

  it('creates an entry from a recipe id, and from a title', async () => {
    await connect()
    const a = await call('POST', '/api/mealie/mealplan', kid, { date: '2026-05-04', entryType: 'dinner', recipeId: RECIPE })
    expect(a.statusCode).toBe(201)
    expect(JSON.parse(a.body)).toEqual({ ok: true })
    const b = await call('POST', '/api/mealie/mealplan', kid, { date: '2026-05-05', entryType: 'lunch', title: ' Leftovers ' })
    expect(b.statusCode).toBe(201)
    const posts = planPaths().filter((r) => r.method === 'POST')
    expect(posts[0].body).toEqual({ date: '2026-05-04', entryType: 'dinner', recipeId: RECIPE })
    expect(posts[1].body).toEqual({ date: '2026-05-05', entryType: 'lunch', title: 'Leftovers' })
  })

  it('rejects neither recipeId nor title, a bad entryType, a bad date and a non-uuid recipe', async () => {
    await connect()
    const bad = (body: Record<string, unknown>) => call('POST', '/api/mealie/mealplan', kid, body)
    expect((await bad({ date: '2026-05-04', entryType: 'dinner' })).statusCode).toBe(400)
    expect((await bad({ date: '2026-05-04', entryType: 'snack', title: 'x' })).statusCode).toBe(400)
    expect((await bad({ date: '05/04/2026', entryType: 'dinner', title: 'x' })).statusCode).toBe(400)
    expect((await bad({ date: '2026-05-04', entryType: 'dinner', recipeId: 'nope' })).statusCode).toBe(400)
    expect(planPaths().filter((r) => r.method === 'POST')).toHaveLength(0)
  })

  it('clears the plan cache after creating and after deleting', async () => {
    await connect()
    const path = '/api/mealie/mealplan?start=2026-05-01&end=2026-05-07'
    const gets = () => planPaths().filter((r) => r.method === 'GET').length
    await call('GET', path, kid)
    await call('POST', '/api/mealie/mealplan', kid, { date: '2026-05-04', entryType: 'dinner', title: 'Soup' })
    const created = JSON.parse((await call('GET', path, kid)).body)
    expect(gets()).toBe(2)
    expect(created.entries.map((e: { title: string }) => e.title)).toEqual(['Soup'])
    const id = fake.state.mealplans[0].id
    expect((await call('DELETE', `/api/mealie/mealplan/${id}`, kid)).statusCode).toBe(204)
    await call('GET', path, kid)
    expect(gets()).toBe(3)
  })

  it('deletes by integer id, and rejects a non-integer one', async () => {
    await connect()
    fake.state.mealplans = [{ id: 12, date: '2026-05-04', entryType: 'dinner', title: 'X', recipe: null }]
    expect((await call('DELETE', '/api/mealie/mealplan/12', kid)).statusCode).toBe(204)
    expect(planPaths().some((r) => r.method === 'DELETE' && r.path === '/api/households/mealplans/12')).toBe(true)
    expect((await call('DELETE', '/api/mealie/mealplan/abc', kid)).statusCode).toBe(400)
    expect((await call('DELETE', '/api/mealie/mealplan/1.5', kid)).statusCode).toBe(400)
  })
})
