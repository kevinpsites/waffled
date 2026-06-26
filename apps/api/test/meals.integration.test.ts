// Meals domain — migration + api. Shares one Postgres testcontainer + app.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client } from 'pg'
import jwt from 'jsonwebtoken'
import { stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
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
let mediaDir = ''

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  mediaDir = join(tmpdir(), `nook-meals-it-${randomBytes(8).toString('hex')}`)
  process.env.MEDIA_DIR = mediaDir
  delete process.env.STORAGE_DRIVER
  delete process.env.MEDIA_BASE_URL
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  kevinId = JSON.parse(setup.body).person.id
  const householdId = JSON.parse(setup.body).household.id
  // Seed an identity so the legacy mint('dev|kevin') token resolves to the owner.
  await withClient((c) =>
    c.query(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
      [householdId, kevinId]
    )
  )
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
  await rm(mediaDir, { recursive: true, force: true })
})

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

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

describe('recipe overrides api', () => {
  let recipeId = ''

  beforeAll(async () => {
    const r = await call('POST', '/api/recipes', kevin, { title: 'Turkey Chili', emoji: '🌶️', protein: 'turkey', tags: ['bowl', 'spicy'] })
    recipeId = JSON.parse(r.body).recipe.id
    await call('POST', `/api/recipes/${recipeId}/ingredients`, kevin, {
      ingredients: [{ name: 'Ground turkey', amount: 1, unit: 'lb' }],
    })
    // seed one step so step-note overrides have something to attach to
    await withClient((c) =>
      c.query(
        `insert into recipe_steps (household_id, recipe_id, step_number, instruction)
         select household_id, id, 1, 'Brown the meat.' from recipes where id = $1`,
        [recipeId]
      )
    )
  })

  it('merges metadata + dietary + added tags over the source at read time', async () => {
    const patch = await call('PATCH', `/api/recipes/${recipeId}`, kevin, {
      overrides: {
        meta: { protein: 'chicken' },
        dietary: ['gluten-free'],
        addedTags: ['family-favorite'],
      },
    })
    expect(patch.statusCode).toBe(200)

    const detail = JSON.parse((await call('GET', `/api/recipes/${recipeId}`, kevin)).body)
    expect(detail.recipe.protein).toBe('chicken') // override wins over 'turkey'
    expect(detail.recipe.dietary).toEqual(['gluten-free'])
    expect(detail.recipe.tags).toContain('family-favorite')
    expect(detail.recipe.tags).toContain('bowl') // source tags still present
    expect(detail.recipe.addedTags).toEqual(['family-favorite'])

    // and the override surfaces on the list shape, so library filters see it
    const list = JSON.parse((await call('GET', '/api/recipes', kevin)).body)
    const chili = list.recipes.find((r: { id: string }) => r.id === recipeId)
    expect(chili.protein).toBe('chicken')
  })

  it('hides a removed source tag while keeping the rest', async () => {
    await call('PATCH', `/api/recipes/${recipeId}`, kevin, {
      overrides: { addedTags: ['family-favorite'], removedTags: ['bowl'] },
    })
    const detail = JSON.parse((await call('GET', `/api/recipes/${recipeId}`, kevin)).body)
    expect(detail.recipe.tags).not.toContain('bowl') // dropped source tag
    expect(detail.recipe.tags).toContain('spicy') // other source tag stays
    expect(detail.recipe.tags).toContain('family-favorite')
    // restore for the subsequent tests
    await call('PATCH', `/api/recipes/${recipeId}`, kevin, { overrides: { meta: { protein: 'chicken' } } })
  })

  it('attaches ingredient subs (by name) and step notes (by number)', async () => {
    await call('PATCH', `/api/recipes/${recipeId}`, kevin, {
      overrides: {
        meta: { protein: 'chicken' },
        subs: { 'ground turkey': 'ground chicken' },
        stepNotes: { '1': 'we sear it harder' },
      },
    })
    const detail = JSON.parse((await call('GET', `/api/recipes/${recipeId}`, kevin)).body)
    const ing = detail.ingredients.find((i: { name: string }) => i.name === 'Ground turkey')
    expect(ing.sub).toBe('ground chicken')
    expect(detail.steps[0].note).toBe('we sear it harder')
  })

  it('survives re-importing the source ingredients (sub re-keyed by name)', async () => {
    // simulate a re-import: delete + recreate the ingredient row (new id)
    await withClient((c) =>
      c.query(`delete from recipe_ingredients where recipe_id = $1`, [recipeId])
    )
    await call('POST', `/api/recipes/${recipeId}/ingredients`, kevin, {
      ingredients: [{ name: 'Ground turkey', amount: 1, unit: 'lb' }],
    })
    const detail = JSON.parse((await call('GET', `/api/recipes/${recipeId}`, kevin)).body)
    const ing = detail.ingredients.find((i: { name: string }) => i.name === 'Ground turkey')
    expect(ing.sub).toBe('ground chicken') // still applied to the re-created ingredient
    expect(detail.recipe.protein).toBe('chicken')
  })
})

describe('recipe create / edit / delete api (6.3-edit)', () => {
  it('creates a full recipe (metadata + ingredients + steps) in one call', async () => {
    const add = await call('POST', '/api/recipes', kevin, {
      title: 'Weeknight Stir Fry',
      emoji: '🥡',
      servings: 3,
      cookTimeMinutes: 20,
      cuisine: 'Asian',
      protein: 'chicken',
      dietary: ['gluten-free'],
      vegetables: ['broccoli', 'pepper'],
      ingredients: [
        { name: 'chicken thighs', amount: 1, unit: 'lb', section: 'Protein' },
        { name: 'soy sauce', amount: 2, unit: 'tbsp', prepNote: 'low-sodium', section: 'Sauce' },
      ],
      steps: [
        { instruction: 'Sear the chicken.', ingredients: ['1 lb chicken thighs'] },
        { instruction: 'Add veg and sauce; toss.' },
      ],
    })
    expect(add.statusCode).toBe(201)
    const id = JSON.parse(add.body).recipe.id

    const detail = JSON.parse((await call('GET', `/api/recipes/${id}`, kevin)).body)
    expect(detail.recipe).toMatchObject({ title: 'Weeknight Stir Fry', servings: 3, cuisine: 'Asian', protein: 'chicken' })
    expect(detail.recipe.dietary).toEqual(['gluten-free'])
    expect(detail.recipe.vegetables).toEqual(['broccoli', 'pepper'])
    expect(detail.ingredients).toHaveLength(2)
    const soy = detail.ingredients.find((i: { name: string }) => i.name === 'soy sauce')
    expect(soy).toMatchObject({ amount: 2, unit: 'tbsp', section: 'Sauce' })
    expect(soy.aisle).toBeTruthy() // computed from the name
    expect(detail.steps).toHaveLength(2)
    expect(detail.steps[0]).toMatchObject({ stepNumber: 1, instruction: 'Sear the chicken.' })
    expect(detail.steps[0].ingredients).toEqual(['1 lb chicken thighs'])
  })

  it('400 when a create includes a nameless ingredient', async () => {
    const r = await call('POST', '/api/recipes', kevin, {
      title: 'Bad Recipe',
      ingredients: [{ amount: 1, unit: 'cup' }],
    })
    expect(r.statusCode).toBe(400)
  })

  it('edits scalar + metadata fields via PATCH', async () => {
    const add = await call('POST', '/api/recipes', kevin, { title: 'Plain Pasta', servings: 2 })
    const id = JSON.parse(add.body).recipe.id

    const patch = await call('PATCH', `/api/recipes/${id}`, kevin, {
      title: 'Cacio e Pepe',
      servings: 4,
      cuisine: 'Italian',
      cookTimeMinutes: 15,
      emoji: '🧀',
    })
    expect(patch.statusCode).toBe(200)
    const detail = JSON.parse((await call('GET', `/api/recipes/${id}`, kevin)).body)
    expect(detail.recipe).toMatchObject({ title: 'Cacio e Pepe', servings: 4, cuisine: 'Italian', cookTimeMinutes: 15, emoji: '🧀' })
  })

  it('full-replaces ingredients/steps and detaches an imported recipe (source_type → manual)', async () => {
    // seed a recipe that looks imported
    const id = await withClient(async (c) => {
      const r = await c.query<{ id: string }>(
        `insert into recipes (household_id, title, source_type) values ($1,'Imported Dish','markdown_import') returning id`,
        [await householdOf(c)]
      )
      await c.query(
        `insert into recipe_ingredients (household_id, recipe_id, name) select household_id, id, 'old item' from recipes where id=$1`,
        [r.rows[0].id]
      )
      return r.rows[0].id
    })

    const patch = await call('PATCH', `/api/recipes/${id}`, kevin, {
      ingredients: [
        { name: 'new item A', amount: 1, unit: 'cup' },
        { name: 'new item B' },
      ],
      steps: [{ instruction: 'Do the thing.' }],
    })
    expect(patch.statusCode).toBe(200)

    const detail = JSON.parse((await call('GET', `/api/recipes/${id}`, kevin)).body)
    const names = detail.ingredients.map((i: { name: string }) => i.name)
    expect(names).toEqual(['new item A', 'new item B']) // old ones gone
    expect(detail.steps).toHaveLength(1)

    const srcType = await withClient((c) =>
      c.query<{ source_type: string }>(`select source_type from recipes where id=$1`, [id])
    )
    expect(srcType.rows[0].source_type).toBe('manual') // detached
  })

  it('soft-deletes a recipe (204) and drops it from the list; 404 second time', async () => {
    const add = await call('POST', '/api/recipes', kevin, { title: 'To Be Deleted' })
    const id = JSON.parse(add.body).recipe.id

    const del = await call('DELETE', `/api/recipes/${id}`, kevin)
    expect(del.statusCode).toBe(204)

    expect((await call('GET', `/api/recipes/${id}`, kevin)).statusCode).toBe(404)
    const titles = JSON.parse((await call('GET', '/api/recipes', kevin)).body).recipes.map((r: { title: string }) => r.title)
    expect(titles).not.toContain('To Be Deleted')

    expect((await call('DELETE', `/api/recipes/${id}`, kevin)).statusCode).toBe(404)
  })

  it('parses pasted markdown into the structured editor shape (without saving)', async () => {
    const markdown = [
      '---', 'type: dinner', 'cuisine: Mexican', 'tags: [quick]', '---', '',
      '# Quick Tacos', '', '*2 servings*', '', '## Ingredients', '',
      '### Filling', '- 1 lb ground beef', '- 1 packet taco seasoning', '',
      '## Instructions', '', '1. Brown the beef.', '2. Add seasoning and serve.', '',
      '## Notes', 'Source: Tuesday nights',
    ].join('\n')

    const res = await call('POST', '/api/recipes/parse-markdown', kevin, { markdown })
    expect(res.statusCode).toBe(200)
    const parsed = JSON.parse(res.body)
    expect(parsed.recipe).toMatchObject({ title: 'Quick Tacos', servings: 2, cuisine: 'Mexican', mealType: 'dinner' })
    expect(parsed.recipe.sourceName).toBe('Tuesday nights')
    expect(parsed.ingredients).toHaveLength(2)
    expect(parsed.ingredients[0].name).toBe('ground beef')
    expect(parsed.steps).toHaveLength(2)
    expect(parsed.steps[0].instruction).toContain('Brown the beef')

    // 400 on empty markdown
    expect((await call('POST', '/api/recipes/parse-markdown', kevin, { markdown: '' })).statusCode).toBe(400)
  })

  it('suggest-metadata requires a title (400) and 501s with no AI provider configured', async () => {
    expect((await call('POST', '/api/recipes/suggest-metadata', kevin, { ingredients: ['pasta'] })).statusCode).toBe(400)
    // The test container has no LLM provider selected → heuristic → 501.
    const res = await call('POST', '/api/recipes/suggest-metadata', kevin, {
      title: 'Spaghetti', ingredients: ['noodles', 'pasta sauce'], steps: ['Boil noodles', 'Add sauce'],
    })
    expect(res.statusCode).toBe(501)
  })
})

describe('recipe images (blob storage)', () => {
  async function upload(): Promise<string> {
    const up = await call('POST', '/api/media', kevin, { data: PNG_B64, contentType: 'image/png' })
    expect(up.statusCode).toBe(201)
    return (JSON.parse(up.body) as { key: string }).key
  }

  it('creates a recipe with storageKey and resolves imageUrl to a /media URL', async () => {
    const key = await upload()
    const res = await call('POST', '/api/recipes', kevin, { title: 'Tacos', storageKey: key, contentType: 'image/png' })
    expect(res.statusCode).toBe(201)
    const recipe = JSON.parse(res.body).recipe
    expect(recipe.imageUrl).toBe(`/media/${key}`)
    // And it survives a GET (presenter path).
    const got = JSON.parse((await call('GET', `/api/recipes/${recipe.id}`, kevin)).body).recipe
    expect(got.imageUrl).toBe(`/media/${key}`)
  })

  it('PATCH replacing the image drops the old blob; soft-delete drops the current one', async () => {
    const key1 = await upload()
    const created = JSON.parse((await call('POST', '/api/recipes', kevin, { title: 'Curry', storageKey: key1 })).body).recipe
    await stat(join(mediaDir, key1))

    const key2 = await upload()
    const patched = JSON.parse((await call('PATCH', `/api/recipes/${created.id}`, kevin, { storageKey: key2 })).body).recipe
    expect(patched.imageUrl).toBe(`/media/${key2}`)
    // Old blob is gone, new blob remains.
    await expect(stat(join(mediaDir, key1))).rejects.toMatchObject({ code: 'ENOENT' })
    await stat(join(mediaDir, key2))

    // Soft-delete drops the current blob.
    expect((await call('DELETE', `/api/recipes/${created.id}`, kevin)).statusCode).toBe(204)
    await expect(stat(join(mediaDir, key2))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('falls back to the external image_url when there is no storageKey', async () => {
    const res = await call('POST', '/api/recipes', kevin, { title: 'Soup', imageUrl: 'https://example.com/soup.jpg' })
    const recipe = JSON.parse(res.body).recipe
    expect(recipe.imageUrl).toBe('https://example.com/soup.jpg')
  })
})

// Helper: the household id for Kevin's tenant (used to seed an "imported" recipe).
async function householdOf(c: Client): Promise<string> {
  const r = await c.query<{ household_id: string }>(
    `select household_id from persons where name='Kevin' order by created_at limit 1`
  )
  return r.rows[0].household_id
}
