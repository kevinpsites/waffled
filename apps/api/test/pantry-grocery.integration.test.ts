// The pantry ↔ grocery bridge: the grocery board FLAGS rows you already have on hand
// (it never filters them out), and the recipe payload marks each ingredient so the
// "add to grocery" picker can pre-uncheck what's in the pantry.
//
// Two rules this file exists to pin down, because both are easy to break quietly:
//
//   1. FLAG, NEVER FILTER. The matcher is presence-only — it never compares quantities
//      (see pantry/match.ts) — so "you have eggs" can be true while you have one egg and
//      the recipe wants twelve. Dropping the row would be a worse bug than the one the
//      badge fixes, so a matched row must still be ON the list.
//   2. STAPLES ARE UNTOUCHED. `inPantry` is a *pantry* signal, distinct from `isStaple`.
//      The picker deliberately defaults staples to checked (an item missing at the shop
//      costs more than an extra one to uncheck), and adding pantry awareness must not
//      quietly reverse that.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { Client } from 'pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let url = ''
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}

function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  // lambda-api does NOT parse a query string out of `path` — it reads
  // `queryStringParameters`. Passing `{}` (as the older list tests do) makes every
  // `?weekStart=` silently vanish, so the route falls back to the household's CURRENT
  // week. That reads as passing whenever the test's week IS the current week, which is
  // how a month-scoped rebuild bug went unnoticed. Split and hand it over properly.
  const [bare, qs] = path.split('?')
  const queryStringParameters = Object.fromEntries(new URLSearchParams(qs ?? '').entries())
  return app.run(
    { httpMethod: method, path: bare, headers, queryStringParameters, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<{ statusCode: number; body: string }>
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

const kevin = mint('dev|kevin')
let householdId = ''
let recipeId = ''

// The household's week starts Sunday by default, and the board is week-scoped.
function thisSunday(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - d.getDay())
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const ws = thisSunday()

type BoardItem = { name: string; pantry: { name: string; amount: string; unit: string } | null }
type Ingredient = { name: string; isStaple: boolean; inPantry: boolean }

// GET returns the board unwrapped (POST /rebuild is the one that nests it under `board`).
const board = async (): Promise<{ items: BoardItem[] }> =>
  JSON.parse((await call('GET', `/api/lists/grocery/board?weekStart=${ws}`, kevin)).body)
const item = (b: { items: BoardItem[] }, name: string): BoardItem | undefined => b.items.find((i) => i.name === name)
const ingredients = async (): Promise<Ingredient[]> =>
  JSON.parse((await call('GET', `/api/recipes/${recipeId}`, kevin)).body).ingredients
const ing = (list: Ingredient[], name: string): Ingredient | undefined => list.find((i) => i.name === name)

const setModules = (mods: Record<string, boolean>) => call('PATCH', '/api/household/modules', kevin, mods)

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
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
  await setModules({ pantry: true, meals: true })

  // A recipe whose ingredients cover every case the flag has to distinguish:
  // one thing we have, one we don't, and a staple (which must stay untouched).
  recipeId = (
    await withClient((c) =>
      c.query<{ id: string }>(
        `insert into recipes (household_id, title, category, servings) values ($1,'Test Chowder','dinner',4) returning id`,
        [householdId]
      )
    )
  ).rows[0].id
  await withClient((c) =>
    c.query(
      `insert into recipe_ingredients (household_id, recipe_id, name, amount, unit, aisle, is_staple) values
         ($1,$2,'Salmon fillets',1.5,'lb','Meat & Seafood',false),
         ($1,$2,'Leeks',2,null,'Produce',false),
         ($1,$2,'Heavy cream',1,'cup','Dairy & Chilled',false),
         ($1,$2,'Olive oil',2,'Tbsp','Pantry',true)`,
      [householdId, recipeId]
    )
  )

  // On hand: the salmon (as a bag, deliberately un-countable) and the cream.
  // Nothing for the leeks — that row must stay a plain "to buy".
  expect((await call('POST', '/api/pantry', kevin, { name: 'Salmon fillets', amount: '1', unit: 'bag', location: 'Freezer' })).statusCode).toBe(201)
  expect((await call('POST', '/api/pantry', kevin, { name: 'Heavy cream', amount: '2', unit: 'cups', location: 'Fridge' })).statusCode).toBe(201)

  const planDate = (() => {
    const d = new Date(ws + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + 1)
    return d.toISOString().slice(0, 10)
  })()
  expect((await call('POST', '/api/meals/plan', kevin, { date: planDate, mealType: 'dinner', recipeId })).statusCode).toBeLessThan(300)
  expect((await call('POST', `/api/lists/grocery/rebuild?weekStart=${ws}`, kevin)).statusCode).toBe(200)
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('grocery board — flags what is already on hand', () => {
  it('FLAGS a matched row without filtering it off the list', async () => {
    const b = await board()
    // The whole point: still shopping-visible, now annotated.
    expect(b.items.map((i) => i.name)).toContain('Salmon fillets')
    expect(item(b, 'Salmon fillets')?.pantry).toMatchObject({ name: 'Salmon fillets' })
  })

  it("carries the pantry item's own amount, so bulk goods stay honest", async () => {
    // No unit arithmetic is possible between "1 bag" and "1½ lb" — the cook judges.
    // Reporting the raw amount is the only claim the data actually supports.
    expect(item(await board(), 'Salmon fillets')?.pantry).toMatchObject({ amount: '1', unit: 'bag' })
  })

  it('matches loosely enough to be useful (token subset, not exact string)', async () => {
    expect(item(await board(), 'Heavy cream')?.pantry).toMatchObject({ name: 'Heavy cream', amount: '2', unit: 'cups' })
  })

  it('leaves an unmatched row unflagged', async () => {
    expect(item(await board(), 'Leeks')?.pantry).toBeNull()
  })

  it('ignores used-up items (same predicates as the recipe banner)', async () => {
    const items = JSON.parse((await call('GET', '/api/pantry', kevin)).body).items as Array<{ id: string; name: string }>
    const cream = items.find((i) => i.name === 'Heavy cream')!
    await call('PATCH', `/api/pantry/${cream.id}`, kevin, { usedUp: true })
    expect(item(await board(), 'Heavy cream')?.pantry).toBeNull()
    await call('PATCH', `/api/pantry/${cream.id}`, kevin, { usedUp: false })
    expect(item(await board(), 'Heavy cream')?.pantry).not.toBeNull()
  })

  it('ignores finished meals (is_meal) — leftovers are not an ingredient', async () => {
    const res = await call('POST', '/api/pantry', kevin, { name: 'Leeks', amount: '1', unit: 'tub', location: 'Fridge', isMeal: true })
    expect(res.statusCode).toBe(201)
    expect(item(await board(), 'Leeks')?.pantry).toBeNull()
    await call('DELETE', `/api/pantry/${JSON.parse(res.body).item.id}`, kevin)
  })

  it('makes no on-hand claim at all while the pantry module is off', async () => {
    // Matching the established rule: absent knowledge is null, never a fake "nothing".
    await setModules({ pantry: false })
    const b = await board()
    expect(b.items.length).toBeGreaterThan(0)
    expect(b.items.every((i) => i.pantry === null)).toBe(true)
    await setModules({ pantry: true })
    expect(item(await board(), 'Salmon fillets')?.pantry).not.toBeNull()
  })
})

describe('recipe ingredients — inPantry drives the picker default', () => {
  it('marks an ingredient we have on hand', async () => {
    expect(ing(await ingredients(), 'Salmon fillets')?.inPantry).toBe(true)
  })

  it('leaves an ingredient we lack unmarked', async () => {
    expect(ing(await ingredients(), 'Leeks')?.inPantry).toBe(false)
  })

  it('keeps isStaple independent of inPantry — the picker must not conflate them', async () => {
    // Olive oil is a staple and is NOT in the pantry table. It has to stay
    // isStaple:true / inPantry:false, or the picker would silently start
    // unchecking staples — a default reversal nobody asked for.
    const oil = ing(await ingredients(), 'Olive oil')
    expect(oil).toMatchObject({ isStaple: true, inPantry: false })
  })

  it('reports inPantry false for every ingredient while the pantry module is off', async () => {
    await setModules({ pantry: false })
    expect((await ingredients()).every((i) => i.inPantry === false)).toBe(true)
    await setModules({ pantry: true })
    expect(ing(await ingredients(), 'Salmon fillets')?.inPantry).toBe(true)
  })
})
