// Meals domain — migration + api. Shares one Postgres testcontainer + app.
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
  const [rawPath, qs] = path.split('?')
  const queryStringParameters: Record<string, string> = {}
  if (qs) {
    for (const pair of qs.split('&')) {
      const [k, v] = pair.split('=')
      queryStringParameters[k] = decodeURIComponent(v ?? '')
    }
  }
  return app.run(
    {
      httpMethod: method,
      path: rawPath,
      headers,
      queryStringParameters,
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

describe('meals schema', () => {
  it('creates recipes, meal_plans, meal_plan_entries', async () => {
    const res = await withClient((c) =>
      c.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema='public' and table_name = any($1)`,
        [['recipes', 'meal_plans', 'meal_plan_entries']]
      )
    )
    expect(res.rows.map((r) => r.table_name).sort()).toEqual([
      'meal_plan_entries',
      'meal_plans',
      'recipes',
    ])
  })

  it('enforces one entry per plan/date/meal_type and links a recipe', async () => {
    await withClient(async (c) => {
      const h = await c.query<{ id: string }>(
        `insert into households (name, timezone) values ('M','UTC') returning id`
      )
      const hid = h.rows[0].id
      const r = await c.query<{ id: string; servings: number }>(
        `insert into recipes (household_id, title) values ($1,'Salmon') returning id, servings`,
        [hid]
      )
      expect(r.rows[0].servings).toBe(4) // default
      const mp = await c.query<{ id: string }>(
        `insert into meal_plans (household_id, start_date, end_date) values ($1,'2026-06-08','2026-06-14') returning id`,
        [hid]
      )
      const planId = mp.rows[0].id

      await c.query(
        `insert into meal_plan_entries (household_id, meal_plan_id, date, meal_type, recipe_id)
         values ($1,$2,'2026-06-08','dinner',$3)`,
        [hid, planId, r.rows[0].id]
      )
      await expect(
        c.query(
          `insert into meal_plan_entries (household_id, meal_plan_id, date, meal_type)
           values ($1,$2,'2026-06-08','dinner')`,
          [hid, planId]
        )
      ).rejects.toThrow()
    })
  })
})

describe('recipe_ingredients schema', () => {
  it('creates the recipe_ingredients table', async () => {
    const res = await withClient((c) =>
      c.query(`select table_name from information_schema.tables where table_name='recipe_ingredients'`)
    )
    expect(res.rowCount).toBe(1)
  })

  it('stores structured + display fields and enforces the recipe FK', async () => {
    await withClient(async (c) => {
      const h = await c.query<{ id: string }>(
        `insert into households (name,timezone) values ('RI','UTC') returning id`
      )
      const hid = h.rows[0].id
      const r = await c.query<{ id: string }>(
        `insert into recipes (household_id,title) values ($1,'Chicken Parm') returning id`,
        [hid]
      )
      const ing = await c.query<{ amount: string; unit: string; display: string; section: string }>(
        `insert into recipe_ingredients (household_id, recipe_id, name, amount, unit, display, section)
         values ($1,$2,'all-purpose flour',1.5,'cup','1½ cups (225g) flour','Breading')
         returning amount, unit, display, section`,
        [hid, r.rows[0].id]
      )
      expect(Number(ing.rows[0].amount)).toBe(1.5)
      expect(ing.rows[0].unit).toBe('cup')
      expect(ing.rows[0].section).toBe('Breading')

      await expect(
        c.query(`insert into recipe_ingredients (household_id, recipe_id, name) values ($1,$2,'x')`, [
          hid,
          '00000000-0000-0000-0000-000000000000',
        ])
      ).rejects.toThrow()
    })
  })
})

describe('recipes api', () => {
  let recipeId = ''

  it('403s for a caller with no household', async () => {
    expect((await call('GET', '/api/recipes', mint('dev|nobody'))).statusCode).toBe(403)
  })

  it('requires a title (400)', async () => {
    expect((await call('POST', '/api/recipes', kevin, { emoji: '🐟' })).statusCode).toBe(400)
  })

  it('creates a recipe and lists it', async () => {
    const add = await call('POST', '/api/recipes', kevin, {
      title: 'Sheet-Pan Salmon',
      emoji: '🐟',
      cookTimeMinutes: 25,
      servings: 4,
    })
    expect(add.statusCode).toBe(201)
    recipeId = JSON.parse(add.body).recipe.id
    expect(JSON.parse(add.body).recipe).toMatchObject({ title: 'Sheet-Pan Salmon', servings: 4 })

    const titles = JSON.parse((await call('GET', '/api/recipes', kevin)).body).recipes.map(
      (r: { title: string }) => r.title
    )
    expect(titles).toContain('Sheet-Pan Salmon')
  })

  it('reads one recipe by id; 404 for unknown', async () => {
    expect((await call('GET', `/api/recipes/${recipeId}`, kevin)).statusCode).toBe(200)
    expect((await call('GET', '/api/recipes/not-a-uuid', kevin)).statusCode).toBe(404)
    expect(
      (await call('GET', '/api/recipes/00000000-0000-0000-0000-000000000000', kevin)).statusCode
    ).toBe(404)
  })
})

describe('meal planning api', () => {
  let recipeId = ''

  beforeAll(async () => {
    const r = await call('POST', '/api/recipes', kevin, {
      title: 'Chorizo Tacos',
      emoji: '🌮',
      cookTimeMinutes: 30,
      servings: 4,
    })
    recipeId = JSON.parse(r.body).recipe.id
  })

  it('400 without date or mealType', async () => {
    expect((await call('POST', '/api/meals/plan', kevin, { recipeId })).statusCode).toBe(400)
  })

  it('rejects a malformed recipeId (400) but allows none (leftovers)', async () => {
    expect(
      (await call('POST', '/api/meals/plan', kevin, { date: '2026-06-10', mealType: 'dinner', recipeId: 'nope' }))
        .statusCode
    ).toBe(400)
    const none = await call('POST', '/api/meals/plan', kevin, { date: '2026-06-11', mealType: 'lunch' })
    expect([200, 201]).toContain(none.statusCode)
  })

  it('plans a dinner and surfaces it in the week (joined to the recipe)', async () => {
    const plan = await call('POST', '/api/meals/plan', kevin, {
      date: '2026-06-09',
      mealType: 'dinner',
      recipeId,
    })
    expect([200, 201]).toContain(plan.statusCode)
    expect(JSON.parse(plan.body).entry).toMatchObject({ date: '2026-06-09', mealType: 'dinner' })

    const week = JSON.parse((await call('GET', '/api/meals/week?start=2026-06-08', kevin)).body)
    const tue = week.entries.find(
      (e: { date: string; mealType: string }) => e.date === '2026-06-09' && e.mealType === 'dinner'
    )
    expect(tue.recipe).toMatchObject({ title: 'Chorizo Tacos', emoji: '🌮' })
  })

  it('upserts — re-planning the same slot replaces, not duplicates', async () => {
    const r2 = await call('POST', '/api/recipes', kevin, { title: 'Madras Lentils', emoji: '🍛' })
    const r2id = JSON.parse(r2.body).recipe.id
    await call('POST', '/api/meals/plan', kevin, { date: '2026-06-09', mealType: 'dinner', recipeId: r2id })

    const week = JSON.parse((await call('GET', '/api/meals/week?start=2026-06-08', kevin)).body)
    const dinners = week.entries.filter(
      (e: { date: string; mealType: string }) => e.date === '2026-06-09' && e.mealType === 'dinner'
    )
    expect(dinners).toHaveLength(1)
    expect(dinners[0].recipe.title).toBe('Madras Lentils')
  })
})
