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
let kevinId = ''

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/db')).closePool
  const h = await call('POST', '/api/households', kevin, {
    name: 'Sites',
    timezone: 'America/Chicago',
    person: { name: 'Kevin' },
  })
  kevinId = JSON.parse(h.body).person.id
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

describe('recipe ingredients api', () => {
  let recipeId = ''

  beforeAll(async () => {
    const r = await call('POST', '/api/recipes', kevin, { title: 'Chicken Parmesan', emoji: '🍗' })
    recipeId = JSON.parse(r.body).recipe.id
  })

  it('adds ingredients and returns them on the recipe', async () => {
    const add = await call('POST', `/api/recipes/${recipeId}/ingredients`, kevin, {
      ingredients: [
        { name: 'all-purpose flour', amount: 1.5, unit: 'cup', section: 'Breading', display: '1½ cups (225g) flour' },
        { name: 'kosher salt', display: 'Kosher salt, to taste', section: 'Protein' },
      ],
    })
    expect(add.statusCode).toBe(201)
    expect(JSON.parse(add.body).ingredients).toHaveLength(2)

    const detail = JSON.parse((await call('GET', `/api/recipes/${recipeId}`, kevin)).body)
    const names = detail.ingredients.map((i: { name: string }) => i.name)
    expect(names).toContain('all-purpose flour')
    expect(names).toContain('kosher salt')
    const flour = detail.ingredients.find((i: { name: string }) => i.name === 'all-purpose flour')
    expect(flour).toMatchObject({ amount: 1.5, unit: 'cup', section: 'Breading' })
  })

  it('400 on empty list or a nameless ingredient', async () => {
    expect((await call('POST', `/api/recipes/${recipeId}/ingredients`, kevin, { ingredients: [] })).statusCode).toBe(400)
    expect(
      (await call('POST', `/api/recipes/${recipeId}/ingredients`, kevin, { ingredients: [{ amount: 1 }] }))
        .statusCode
    ).toBe(400)
  })

  it('404 adding to an unknown recipe', async () => {
    expect(
      (await call('POST', '/api/recipes/00000000-0000-0000-0000-000000000000/ingredients', kevin, {
        ingredients: [{ name: 'x' }],
      })).statusCode
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

  it('records who is cooking and surfaces the cook in the week', async () => {
    const plan = await call('POST', '/api/meals/plan', kevin, {
      date: '2026-06-12',
      mealType: 'dinner',
      recipeId,
      cookPersonId: kevinId,
    })
    expect([200, 201]).toContain(plan.statusCode)
    expect(JSON.parse(plan.body).entry.cookPersonId).toBe(kevinId)

    const week = JSON.parse((await call('GET', '/api/meals/week?start=2026-06-08', kevin)).body)
    const fri = week.entries.find(
      (e: { date: string; mealType: string }) => e.date === '2026-06-12' && e.mealType === 'dinner'
    )
    expect(fri.cook).toMatchObject({ personId: kevinId, name: 'Kevin' })
  })

  it('rejects a malformed cookPersonId (400)', async () => {
    expect(
      (await call('POST', '/api/meals/plan', kevin, { date: '2026-06-12', mealType: 'lunch', cookPersonId: 'nope' }))
        .statusCode
    ).toBe(400)
  })

  it('clears a planned slot (204) and removes it from the week; 404 when empty', async () => {
    await call('POST', '/api/meals/plan', kevin, { date: '2026-06-13', mealType: 'breakfast', title: 'Toast' })
    const cleared = await call('DELETE', '/api/meals/plan?date=2026-06-13&mealType=breakfast', kevin)
    expect(cleared.statusCode).toBe(204)

    const week = JSON.parse((await call('GET', '/api/meals/week?start=2026-06-08', kevin)).body)
    const gone = week.entries.find(
      (e: { date: string; mealType: string }) => e.date === '2026-06-13' && e.mealType === 'breakfast'
    )
    expect(gone).toBeUndefined()

    expect((await call('DELETE', '/api/meals/plan?date=2026-06-13&mealType=breakfast', kevin)).statusCode).toBe(404)
  })

  it('400 clearing without a valid date/mealType', async () => {
    expect((await call('DELETE', '/api/meals/plan?date=nope&mealType=dinner', kevin)).statusCode).toBe(400)
  })
})
