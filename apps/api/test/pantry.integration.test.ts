// Pantry module CRUD + the module gate, against a real Postgres (Testcontainers).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
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

  it('marks an item used up and back (soft, recoverable)', async () => {
    let res = await call('PATCH', `/api/pantry/${itemId}`, kevin, { usedUp: true })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).item.usedUp).toBe(true)
    // still listed (used-up is not removal)
    const body = JSON.parse((await call('GET', '/api/pantry', kevin)).body)
    expect(body.items.find((i: { id: string }) => i.id === itemId).usedUp).toBe(true)
    res = await call('PATCH', `/api/pantry/${itemId}`, kevin, { usedUp: false })
    expect(JSON.parse(res.body).item.usedUp).toBe(false)
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

// Open Food Facts lookup + cache + snapshot. fetch is stubbed so no real network.
describe('pantry Open Food Facts integration', () => {
  const FOUND = '11111111'
  const UNKNOWN = '99999999'
  const offProduct = {
    product_name: 'Chicken Pot Pie',
    brands: "Marie Callender's",
    quantity: '2-ct family size',
    serving_size: '1 pie',
    image_front_url: 'https://img/pie.jpg',
    allergens_tags: ['en:gluten', 'en:milk', 'en:soybeans'],
    ingredients_analysis_tags: ['en:non-vegan', 'en:non-vegetarian'],
    nutriscore_grade: 'd',
    nova_group: 4,
    nutriments: { 'energy-kcal_serving': 520, proteins_serving: 13, fat_serving: 31, carbohydrates_serving: 49, sodium_serving: 0.8 },
  }
  let fetchMock: ReturnType<typeof vi.fn>

  beforeAll(() => {
    fetchMock = vi.fn(async (url: string) => {
      const code = String(url).match(/product\/(\d+)/)?.[1] ?? ''
      if (code === FOUND) return { ok: true, json: async () => ({ status: 'success', result: { id: 'product_found' }, product: offProduct }) }
      return { ok: true, json: async () => ({ status: 'failure', result: { id: 'product_not_found' } }) }
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterAll(() => vi.unstubAllGlobals())

  it('looks up a barcode, normalizes it, and caches (no second fetch)', async () => {
    const before = fetchMock.mock.calls.length
    const r1 = await call('GET', `/api/pantry/lookup/${FOUND}`, kevin)
    expect(r1.statusCode).toBe(200)
    const p = JSON.parse(r1.body).product
    expect(p).toMatchObject({ name: 'Chicken Pot Pie', brand: "Marie Callender's", servingBasis: 'per 1 pie' })
    expect(p.nutrition).toEqual({ calories: 520, protein_g: 13, fat_g: 31, carbs_g: 49, sodium_mg: 800 })
    expect(p.allergens.sort()).toEqual(['gluten', 'milk', 'soy'])
    expect(fetchMock.mock.calls.length).toBe(before + 1)

    // Second lookup is served from cache — no new fetch.
    const r2 = await call('GET', `/api/pantry/lookup/${FOUND}`, kevin)
    expect(r2.statusCode).toBe(200)
    expect(fetchMock.mock.calls.length).toBe(before + 1)
  })

  it('404s an unknown barcode (cached not_found)', async () => {
    const r = await call('GET', `/api/pantry/lookup/${UNKNOWN}`, kevin)
    expect(r.statusCode).toBe(404)
    expect(JSON.parse(r.body).found).toBe(false)
  })

  it('stores the OFF snapshot on an added item', async () => {
    const res = await call('POST', '/api/pantry', kevin, {
      name: 'Chicken Pot Pie', location: 'Freezer', barcode: FOUND, brand: "Marie Callender's",
      quantityText: '2-ct family size', servingBasis: 'per 1 pie',
      nutrition: { calories: 520, protein_g: 13 }, allergens: ['gluten', 'milk', 'soy'], dietary: [], source: 'openfoodfacts',
    })
    expect(res.statusCode).toBe(201)
    const item = JSON.parse(res.body).item
    expect(item).toMatchObject({ barcode: FOUND, brand: "Marie Callender's", source: 'openfoodfacts' })
    expect(item.nutrition).toEqual({ calories: 520, protein_g: 13 })
    expect(item.allergens).toEqual(['gluten', 'milk', 'soy'])
  })

  it('round-trips the household avoid-allergen list (known keys only)', async () => {
    const res = await call('PUT', '/api/pantry/config', kevin, { avoidAllergens: ['gluten', 'bogus', 'milk'] })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).avoidAllergens.sort()).toEqual(['gluten', 'milk'])
    const body = JSON.parse((await call('GET', '/api/pantry', kevin)).body)
    expect(body.avoidAllergens.sort()).toEqual(['gluten', 'milk'])
  })

  it('round-trips the running-low threshold and per-location icons', async () => {
    const res = await call('PUT', '/api/pantry/config', kevin, { lowThreshold: 2, locationIcons: { Freezer: '🧊', Fridge: '' } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.lowThreshold).toBe(2)
    expect(body.locationIcons).toEqual({ Freezer: '🧊' }) // blank dropped
    const list = JSON.parse((await call('GET', '/api/pantry', kevin)).body)
    expect(list.lowThreshold).toBe(2)
    expect(list.locationIcons).toEqual({ Freezer: '🧊' })
  })

  it('stores a per-item low_at override', async () => {
    const created = JSON.parse((await call('POST', '/api/pantry', kevin, { name: 'Olive oil', location: 'Pantry', amount: '3', lowAt: 2 })).body).item
    expect(created.lowAt).toBe(2)
    const patched = JSON.parse((await call('PATCH', `/api/pantry/${created.id}`, kevin, { lowAt: null })).body).item
    expect(patched.lowAt).toBeNull()
  })

  it('scan upserts: re-scanning a barcode increments the existing item', async () => {
    const first = await call('POST', '/api/pantry/scan', kevin, { name: 'Sparkling water', location: 'Pantry', amount: '1', barcode: '55550001' })
    expect(first.statusCode).toBe(201)
    expect(JSON.parse(first.body)).toMatchObject({ incremented: false })
    expect(JSON.parse(first.body).item.amount).toBe('1')

    const second = await call('POST', '/api/pantry/scan', kevin, { name: 'Sparkling water', location: 'Pantry', amount: '2', barcode: '55550001' })
    expect(second.statusCode).toBe(200)
    expect(JSON.parse(second.body)).toMatchObject({ incremented: true })
    expect(JSON.parse(second.body).item.amount).toBe('3')

    // No-barcode items match by name.
    await call('POST', '/api/pantry/scan', kevin, { name: 'Bananas', location: 'Pantry', amount: '4' })
    const dup = await call('POST', '/api/pantry/scan', kevin, { name: 'bananas', location: 'Pantry', amount: '1' })
    expect(JSON.parse(dup.body)).toMatchObject({ incremented: true })
    expect(JSON.parse(dup.body).item.amount).toBe('5')
  })

  it("rolls a member's allergens into allergenPeople (known keys only)", async () => {
    const me = JSON.parse((await call('GET', '/api/persons', kevin)).body).persons[0]
    const upd = await call('PATCH', `/api/persons/${me.id}`, kevin, { allergens: ['gluten', 'bogus'] })
    expect(upd.statusCode).toBe(200)
    expect(JSON.parse(upd.body).person.allergens).toEqual(['gluten']) // bogus dropped
    const body = JSON.parse((await call('GET', '/api/pantry', kevin)).body)
    expect(body.allergenPeople.gluten).toContain(me.name)
  })

  let beefId = ''
  it('cook-from-pantry: finds recipes makeable from on-hand items (staple-aware)', async () => {
    const rec = await call('POST', '/api/recipes', kevin, { title: 'Taco Night', ingredients: [{ name: 'Ground beef' }, { name: 'Tortillas' }, { name: 'Salt' }] })
    expect(rec.statusCode).toBe(201)
    beefId = JSON.parse((await call('POST', '/api/pantry', kevin, { name: 'Ground Beef', location: 'Freezer' })).body).item.id
    await call('POST', '/api/pantry', kevin, { name: 'Tortillas', location: 'Pantry' })
    // Salt isn't on hand, but it's a default staple → recipe is still "makeable".
    const ck = await call('GET', '/api/pantry/cookable', kevin)
    expect(ck.statusCode).toBe(200)
    expect(JSON.parse(ck.body).ready.map((r: { title: string }) => r.title)).toContain('Taco Night')
  })

  it('cook-from-pantry: surfaces recipes where you have most of it ("have the main")', async () => {
    await call('POST', '/api/recipes', kevin, { title: 'Veggie Bowl', ingredients: [{ name: 'Broccoli' }, { name: 'Carrots' }, { name: 'Bell peppers' }] })
    await call('POST', '/api/pantry', kevin, { name: 'Broccoli', location: 'Fridge' })
    await call('POST', '/api/pantry', kevin, { name: 'Carrots', location: 'Fridge' })
    // 2 of 3 on hand (no protein tagged) → "have the main" via coverage, missing peppers.
    const ck = JSON.parse((await call('GET', '/api/pantry/cookable', kevin)).body)
    const hm = ck.haveMain.find((r: { title: string }) => r.title === 'Veggie Bowl')
    expect(hm).toBeTruthy()
    expect(hm.missing).toEqual(['Bell peppers'])
  })

  it('cook-from-pantry: lists recipes that use a given item', async () => {
    const r = await call('GET', `/api/pantry/${beefId}/recipes`, kevin)
    expect(r.statusCode).toBe(200)
    expect(JSON.parse(r.body).recipes.map((x: { title: string }) => x.title)).toContain('Taco Night')
  })
})
