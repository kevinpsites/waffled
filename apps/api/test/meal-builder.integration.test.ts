// Meal Builder — a "plate" is a named, multi-recipe meal (meals + meal_recipes),
// schedulable into a meal_plan_entries slot or added wholesale to the grocery list.
// Drives the real HTTP routes against a throwaway Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { Client } from 'pg'
import { runMigrations } from '../src/migrate'

let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

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

function json(res: RunResult) {
  return JSON.parse(res.body)
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
let kevinId = ''
let householdId = ''
let sarahId = ''
let foreignMealId = ''

// Turn an optional module on/off for the test household (settings.modules).
async function setModule(key: string, on: boolean) {
  await withClient((c) =>
    c.query(
      `update households set settings = coalesce(settings,'{}'::jsonb)
         || jsonb_build_object('modules', coalesce(settings->'modules','{}'::jsonb) || $2::jsonb)
       where id = $1`,
      [householdId, JSON.stringify({ [key]: on })]
    )
  )
}

async function makeRecipe(title: string, ingredients: Array<Record<string, unknown>> = [], extra: Record<string, unknown> = {}) {
  const res = await call('POST', '/api/recipes', kevin, { title, ingredients, ...extra })
  expect(res.statusCode).toBe(201)
  return json(res).recipe as { id: string; title: string }
}

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
  expect(setup.statusCode).toBe(201)
  kevin = json(setup).accessToken
  kevinId = json(setup).person.id
  householdId = json(setup).household.id
  const sarah = await call('POST', '/api/persons', kevin, { name: 'Sarah', memberType: 'adult' })
  expect(sarah.statusCode).toBe(201)
  sarahId = json(sarah).person.id
  // A meal in someone else's household — every read/write must miss it.
  await withClient(async (c) => {
    const h = await c.query<{ id: string }>(`insert into households (name, timezone) values ('Other plates','UTC') returning id`)
    foreignMealId = (
      await c.query<{ id: string }>(`insert into meals (household_id, name) values ($1,'Foreign plate') returning id`, [h.rows[0].id])
    ).rows[0].id
  })
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

// The worked example from docs/product/meal-builder-plan.md — built once and
// reused across the CRUD / schedule / grocery / calendar blocks below.
let bbqChicken = ''
let potatoSalad = ''
let coleslaw = ''
let peachCobbler = ''

describe('meal builder schema', () => {
  it('creates meals + meal_recipes and adds meal_plan_entries.meal_id', async () => {
    const tables = await withClient((c) =>
      c.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema='public' and table_name = any($1)`,
        [['meals', 'meal_recipes']]
      )
    )
    expect(tables.rows.map((r) => r.table_name).sort()).toEqual(['meal_recipes', 'meals'])

    const cols = await withClient((c) =>
      c.query<{ column_name: string; is_nullable: string }>(
        `select column_name, is_nullable from information_schema.columns
          where table_schema='public' and table_name='meal_plan_entries' and column_name='meal_id'`
      )
    )
    expect(cols.rows[0]?.is_nullable).toBe('YES')
  })

  it('meal_recipes is keyed on (meal_id, recipe_id) and cascades from meals', async () => {
    const pk = await withClient((c) =>
      c.query<{ column_name: string }>(
        `select kcu.column_name from information_schema.table_constraints tc
           join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
          where tc.table_name='meal_recipes' and tc.constraint_type='PRIMARY KEY'
          order by kcu.ordinal_position`
      )
    )
    expect(pk.rows.map((r) => r.column_name)).toEqual(['meal_id', 'recipe_id'])
  })
})

describe('meal CRUD', () => {
  it('creates a plate with dishes, roles, order and per-dish cooks', async () => {
    bbqChicken = (await makeRecipe('BBQ Chicken', [{ name: 'Chicken thighs', amount: 2, unit: 'lb' }, { name: 'Barbecue sauce', amount: 1, unit: 'cup' }], { emoji: '🍗', prepTimeMinutes: 10, cookTimeMinutes: 30 })).id
    potatoSalad = (await makeRecipe('Potato Salad', [{ name: 'Potatoes', amount: 3, unit: 'lb' }, { name: 'Mayonnaise', amount: 1, unit: 'cup' }], { emoji: '🥔', prepTimeMinutes: 15, cookTimeMinutes: 20 })).id
    coleslaw = (await makeRecipe('Coleslaw', [{ name: 'Cabbage', amount: 1 }, { name: 'Mayonnaise', amount: 0.5, unit: 'cup' }], { emoji: '🥬', prepTimeMinutes: 10 })).id
    peachCobbler = (await makeRecipe('Peach Cobbler', [{ name: 'Peaches', amount: 6 }, { name: 'Cinnamon', amount: 1, unit: 'tsp' }], { emoji: '🍑', prepTimeMinutes: 15, cookTimeMinutes: 45 })).id

    const res = await call('POST', '/api/meals', kevin, {
      name: 'BBQ Sunday',
      servings: 6,
      recipes: [
        { recipeId: bbqChicken, role: 'main', cookPersonId: kevinId },
        { recipeId: potatoSalad, role: 'side', cookPersonId: sarahId },
        { recipeId: coleslaw, role: 'side' },
        { recipeId: peachCobbler, role: 'dessert' },
      ],
    })
    expect(res.statusCode).toBe(201)
    const meal = json(res).meal
    expect(meal).toMatchObject({ name: 'BBQ Sunday', servings: 6, isSaved: false, recipeCount: 4 })
    expect(meal.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(meal.recipes.map((r: { recipeId: string }) => r.recipeId)).toEqual([bbqChicken, potatoSalad, coleslaw, peachCobbler])
    expect(meal.recipes.map((r: { role: string }) => r.role)).toEqual(['main', 'side', 'side', 'dessert'])
    expect(meal.recipes.map((r: { sortOrder: number }) => r.sortOrder)).toEqual([0, 1, 2, 3])
    expect(meal.recipes[0]).toMatchObject({ title: 'BBQ Chicken', emoji: '🍗' })
    expect(meal.recipes[0].cook).toMatchObject({ personId: kevinId, name: 'Kevin' })
    expect(meal.recipes[1].cook).toMatchObject({ personId: sarahId, name: 'Sarah' })
    expect(meal.recipes[2].cook).toBe(null)
  })

  it('defaults servings to 4, role to side, and requires a name', async () => {
    const bad = await call('POST', '/api/meals', kevin, { name: '   ' })
    expect(bad.statusCode).toBe(400)
    const res = await call('POST', '/api/meals', kevin, { name: 'Plain plate', recipes: [{ recipeId: coleslaw }] })
    expect(res.statusCode).toBe(201)
    expect(json(res).meal).toMatchObject({ servings: 4, isSaved: false })
    expect(json(res).meal.recipes[0].role).toBe('side')
  })

  it('rejects a recipe from another household', async () => {
    const foreignRecipe = await withClient(async (c) => {
      const h = await c.query<{ id: string }>(`insert into households (name, timezone) values ('Other recipes','UTC') returning id`)
      return (await c.query<{ id: string }>(`insert into recipes (household_id, title) values ($1,'Not yours') returning id`, [h.rows[0].id])).rows[0].id
    })
    const res = await call('POST', '/api/meals', kevin, { name: 'Nope', recipes: [{ recipeId: foreignRecipe }] })
    expect(res.statusCode).toBe(404)
  })

  it('gets a plate, and 404s another household’s plate', async () => {
    const created = json(await call('POST', '/api/meals', kevin, { name: 'Taco Night', recipes: [{ recipeId: coleslaw, role: 'side' }] })).meal
    const res = await call('GET', `/api/meals/${created.id}`, kevin)
    expect(res.statusCode).toBe(200)
    expect(json(res).meal).toMatchObject({ id: created.id, name: 'Taco Night' })
    expect((await call('GET', `/api/meals/${foreignMealId}`, kevin)).statusCode).toBe(404)
    expect((await call('GET', '/api/meals/not-a-uuid', kevin)).statusCode).toBe(404)
  })

  it('updates name, servings and save/unsave', async () => {
    const meal = json(await call('POST', '/api/meals', kevin, { name: 'Rename me' })).meal
    const res = await call('PATCH', `/api/meals/${meal.id}`, kevin, { name: 'Renamed', servings: 8, isSaved: true })
    expect(res.statusCode).toBe(200)
    expect(json(res).meal).toMatchObject({ name: 'Renamed', servings: 8, isSaved: true })
    const off = await call('PATCH', `/api/meals/${meal.id}`, kevin, { isSaved: false })
    expect(json(off).meal.isSaved).toBe(false)
    expect((await call('PATCH', `/api/meals/${foreignMealId}`, kevin, { name: 'hax' })).statusCode).toBe(404)
  })

  it('soft-deletes a plate', async () => {
    const meal = json(await call('POST', '/api/meals', kevin, { name: 'Delete me' })).meal
    expect((await call('DELETE', `/api/meals/${meal.id}`, kevin)).statusCode).toBe(204)
    expect((await call('GET', `/api/meals/${meal.id}`, kevin)).statusCode).toBe(404)
    expect((await call('DELETE', `/api/meals/${meal.id}`, kevin)).statusCode).toBe(404)
  })

  it('adds, patches, reorders and removes a dish', async () => {
    const meal = json(await call('POST', '/api/meals', kevin, { name: 'Dish ops', recipes: [{ recipeId: bbqChicken, role: 'main' }] })).meal
    const add = await call('POST', `/api/meals/${meal.id}/recipes`, kevin, { recipeId: potatoSalad, role: 'side' })
    expect(add.statusCode).toBe(200)
    expect(json(add).meal.recipes.map((r: { recipeId: string }) => r.recipeId)).toEqual([bbqChicken, potatoSalad])
    expect(json(add).meal.recipes[1].sortOrder).toBe(1)

    const patch = await call('PATCH', `/api/meals/${meal.id}/recipes/${potatoSalad}`, kevin, { role: 'veggie', cookPersonId: sarahId })
    expect(patch.statusCode).toBe(200)
    const dish = json(patch).meal.recipes.find((r: { recipeId: string }) => r.recipeId === potatoSalad)
    expect(dish).toMatchObject({ role: 'veggie' })
    expect(dish.cook).toMatchObject({ personId: sarahId })

    const reorder = await call('PUT', `/api/meals/${meal.id}/recipes/order`, kevin, { recipeIds: [potatoSalad, bbqChicken] })
    expect(reorder.statusCode).toBe(200)
    expect(json(reorder).meal.recipes.map((r: { recipeId: string }) => r.recipeId)).toEqual([potatoSalad, bbqChicken])
    expect(json(reorder).meal.recipes.map((r: { sortOrder: number }) => r.sortOrder)).toEqual([0, 1])

    const del = await call('DELETE', `/api/meals/${meal.id}/recipes/${bbqChicken}`, kevin)
    expect(del.statusCode).toBe(200)
    expect(json(del).meal.recipes.map((r: { recipeId: string }) => r.recipeId)).toEqual([potatoSalad])
    expect((await call('DELETE', `/api/meals/${meal.id}/recipes/${bbqChicken}`, kevin)).statusCode).toBe(404)
  })

  it('re-adding the same recipe updates it in place rather than duplicating', async () => {
    const meal = json(await call('POST', '/api/meals', kevin, { name: 'Dupe guard', recipes: [{ recipeId: coleslaw, role: 'side' }] })).meal
    const again = await call('POST', `/api/meals/${meal.id}/recipes`, kevin, { recipeId: coleslaw, role: 'main' })
    expect(again.statusCode).toBe(200)
    expect(json(again).meal.recipes).toHaveLength(1)
    expect(json(again).meal.recipes[0].role).toBe('main')
  })

  it('rejects a cook from another household', async () => {
    const meal = json(await call('POST', '/api/meals', kevin, { name: 'Foreign cook', recipes: [{ recipeId: coleslaw }] })).meal
    const foreignPerson = await withClient(async (c) => {
      const h = await c.query<{ id: string }>(`insert into households (name, timezone) values ('Other cooks','UTC') returning id`)
      return (await c.query<{ id: string }>(`insert into persons (household_id, name, member_type) values ($1,'Stranger','adult') returning id`, [h.rows[0].id])).rows[0].id
    })
    const res = await call('PATCH', `/api/meals/${meal.id}/recipes/${coleslaw}`, kevin, { cookPersonId: foreignPerson })
    expect(res.statusCode).toBe(404)
  })
})

describe('saved-meal library (GET /api/meals)', () => {
  it('lists only saved plates, newest first, and searches by name', async () => {
    const sunday = json(await call('POST', '/api/meals', kevin, { name: 'Sunday Roast Plate', isSaved: true, recipes: [{ recipeId: bbqChicken, role: 'main' }] })).meal
    const taco = json(await call('POST', '/api/meals', kevin, { name: 'Taco Tuesday Plate', isSaved: true, recipes: [{ recipeId: coleslaw }] })).meal
    json(await call('POST', '/api/meals', kevin, { name: 'One-off scratch plate' })).meal // unsaved

    const all = await call('GET', '/api/meals', kevin)
    expect(all.statusCode).toBe(200)
    const names = json(all).meals.map((m: { name: string }) => m.name)
    expect(names).toContain('Sunday Roast Plate')
    expect(names).toContain('Taco Tuesday Plate')
    expect(names).not.toContain('One-off scratch plate')

    const hit = await call('GET', '/api/meals?q=taco', kevin)
    expect(hit.statusCode).toBe(200)
    expect(hit.body).toContain(taco.id)
    expect(hit.body).not.toContain(sunday.id)

    const miss = await call('GET', '/api/meals?q=zzzznotathing', kevin)
    expect(json(miss).meals).toEqual([])
  })

  it('summaries carry enough for a library card', async () => {
    const res = await call('GET', '/api/meals?q=Sunday Roast', kevin)
    const meal = json(res).meals[0]
    expect(meal).toMatchObject({ name: 'Sunday Roast Plate', servings: 4, isSaved: true, recipeCount: 1 })
    expect(meal.emojis).toEqual(['🍗'])
    expect(meal.totalMinutes).toBe(40) // 10 prep + 30 cook
    expect(Array.isArray(meal.recipes)).toBe(true)
    expect(meal.recipes[0]).toMatchObject({ recipeId: bbqChicken, title: 'BBQ Chicken' })
  })
})

describe('flatten: adding a saved meal to a plate', () => {
  it('pulls the saved plate’s recipes in as individual dishes — meals never nest', async () => {
    const saved = json(await call('POST', '/api/meals', kevin, {
      name: 'Sides Combo',
      isSaved: true,
      recipes: [{ recipeId: potatoSalad, role: 'side', cookPersonId: sarahId }, { recipeId: coleslaw, role: 'side' }],
    })).meal

    const target = json(await call('POST', '/api/meals', kevin, { name: 'Flatten target', recipes: [{ recipeId: bbqChicken, role: 'main' }] })).meal
    const res = await call('POST', `/api/meals/${target.id}/recipes`, kevin, { mealId: saved.id })
    expect(res.statusCode).toBe(200)
    const meal = json(res).meal
    expect(meal.recipes.map((r: { recipeId: string }) => r.recipeId)).toEqual([bbqChicken, potatoSalad, coleslaw])
    expect(meal.recipes.map((r: { sortOrder: number }) => r.sortOrder)).toEqual([0, 1, 2])
    // roles + cooks come along, and each dish is now independently editable
    expect(meal.recipes[1]).toMatchObject({ role: 'side' })
    expect(meal.recipes[1].cook).toMatchObject({ personId: sarahId })
    // no nesting anywhere
    const nested = await withClient((c) => c.query(`select 1 from meal_recipes where meal_id = $1 and recipe_id = $2`, [target.id, saved.id]))
    expect(nested.rowCount).toBe(0)

    // editing the flattened copy does not touch the saved source
    await call('PATCH', `/api/meals/${target.id}/recipes/${coleslaw}`, kevin, { role: 'appetizer' })
    const src = json(await call('GET', `/api/meals/${saved.id}`, kevin)).meal
    expect(src.recipes.find((r: { recipeId: string }) => r.recipeId === coleslaw).role).toBe('side')
  })

  it('404s an unknown meal to flatten', async () => {
    const target = json(await call('POST', '/api/meals', kevin, { name: 'Flatten 404' })).meal
    expect((await call('POST', `/api/meals/${target.id}/recipes`, kevin, { mealId: foreignMealId })).statusCode).toBe(404)
    expect((await call('POST', `/api/meals/${target.id}/recipes`, kevin, {})).statusCode).toBe(400)
  })
})

// Real pantry matching (generalised from pantry/cook.ts), not the old staple-count
// proxy. Two DIFFERENT numbers here, and only one of them is pantry-derived:
//   • onHand {have,total} — pantry-derived. Pantry module OFF ⇒ null (omitted), never
//     `have: 0`, which would read as "you have nothing".
//   • toBuy — NOT pantry-derived: the non-staple ingredients that will land on the
//     grocery list. Keeps working with pantry off.
describe('pantry on-hand counts', () => {
  let plate = ''

  beforeAll(async () => {
    plate = json(await call('POST', '/api/meals', kevin, {
      name: 'On-hand plate',
      recipes: [
        { recipeId: bbqChicken, role: 'main' },
        { recipeId: potatoSalad, role: 'side' },
        { recipeId: coleslaw, role: 'side' },
        { recipeId: peachCobbler, role: 'dessert' },
      ],
    })).meal.id
    // Chicken + mayo are in the pantry; nothing else is.
    await withClient((c) =>
      c.query(`insert into pantry_items (household_id, name, amount, unit) values ($1,'Chicken','2','lb'), ($1,'Mayonnaise','1','jar')`, [householdId])
    )
  })

  it('omits on-hand entirely when the pantry module is off, but still counts what to buy', async () => {
    await setModule('pantry', false)
    const meal = json(await call('GET', `/api/meals/${plate}`, kevin)).meal
    expect(meal.onHand).toBe(null)
    // 7 distinct non-staple ingredients across the plate (mayonnaise is shared)
    expect(meal.toBuy).toBe(7)
    const chicken = meal.recipes.find((r: { recipeId: string }) => r.recipeId === bbqChicken)
    expect(chicken.onHand).toBe(null)
    expect(chicken.toBuy).toBe(2)
  })

  it('counts real pantry matches when the pantry module is on', async () => {
    await setModule('pantry', true)
    const meal = json(await call('GET', `/api/meals/${plate}`, kevin)).meal
    // "Chicken" ↔ "Chicken thighs" and "Mayonnaise" ↔ "Mayonnaise" (shared) → 2 of 7
    expect(meal.onHand).toEqual({ have: 2, total: 7 })
    expect(meal.toBuy).toBe(5)
    const chicken = meal.recipes.find((r: { recipeId: string }) => r.recipeId === bbqChicken)
    expect(chicken.onHand).toEqual({ have: 1, total: 2 })
    expect(chicken.toBuy).toBe(1)
    const cobbler = meal.recipes.find((r: { recipeId: string }) => r.recipeId === peachCobbler)
    expect(cobbler.onHand).toEqual({ have: 0, total: 2 })
    expect(cobbler.toBuy).toBe(2)
    // "all on hand" ⟺ toBuy === 0
    expect(meal.recipes.every((r: { onHand: { have: number; total: number }; toBuy: number }) => r.onHand.total - r.onHand.have === r.toBuy)).toBe(true)
  })

  it('never counts a used-up item, a leftover meal, or another household’s pantry', async () => {
    await setModule('pantry', true)
    const solo = json(await call('POST', '/api/meals', kevin, { name: 'Leftovers only', recipes: [{ recipeId: peachCobbler }] })).meal
    await withClient((c) =>
      c.query(
        `insert into pantry_items (household_id, name, is_meal, used_up_at) values ($1,'Peaches',true,null), ($1,'Cinnamon',false,now())`,
        [householdId]
      )
    )
    const again = json(await call('GET', `/api/meals/${solo.id}`, kevin)).meal
    expect(again.onHand).toEqual({ have: 0, total: 2 })
    expect(again.toBuy).toBe(2)
  })

  it('excludes staples from the counts (recipe_ingredients.is_staple and pantry_staples)', async () => {
    await setModule('pantry', true)
    const stapled = await makeRecipe('Garlic Butter Rice', [
      { name: 'Garlic', amount: 2 }, // auto-flagged is_staple + a default pantry staple
      { name: 'Butter', amount: 1, unit: 'tbsp' }, // ditto
      { name: 'Green onions', amount: 3 },
    ])
    const meal = json(await call('POST', '/api/meals', kevin, { name: 'Staple plate', recipes: [{ recipeId: stapled.id }] })).meal
    expect(meal.onHand).toEqual({ have: 0, total: 1 })
    expect(meal.toBuy).toBe(1)
  })

  it('fixes the recipe-detail banner: GET /api/recipes/:id carries the real counts (and none with pantry off)', async () => {
    await setModule('pantry', true)
    const on = json(await call('GET', `/api/recipes/${bbqChicken}`, kevin))
    expect(on.onHand).toEqual({ have: 1, total: 2 })
    expect(on.toBuy).toBe(1)

    await setModule('pantry', false)
    const off = json(await call('GET', `/api/recipes/${bbqChicken}`, kevin))
    expect(off.onHand).toBe(null)
    expect(off.toBuy).toBe(2)
    await setModule('pantry', true)
  })
})

describe('scheduling a plate to a slot', () => {
  it('writes a meal_plan_entries row with meal_id set and recipe_id NULL', async () => {
    const plate = json(await call('POST', '/api/meals', kevin, {
      name: 'Schedule me',
      recipes: [{ recipeId: bbqChicken, role: 'main' }, { recipeId: coleslaw, role: 'side' }],
    })).meal
    const res = await call('POST', `/api/meals/${plate.id}/schedule`, kevin, { date: '2026-06-07', mealType: 'dinner' })
    expect(res.statusCode).toBe(200)
    const entry = json(res).entry
    expect(entry).toMatchObject({ date: '2026-06-07', mealType: 'dinner', recipeId: null, title: 'Schedule me' })
    expect(entry.mealId).toBeTruthy()
    const row = await withClient((c) =>
      c.query<{ recipe_id: string | null; meal_id: string | null }>(
        `select recipe_id, meal_id from meal_plan_entries where id = $1`,
        [entry.id]
      )
    )
    expect(row.rows[0].recipe_id).toBe(null)
    expect(row.rows[0].meal_id).toBe(entry.mealId)
  })

  it('rejects a bad date/mealType and another household’s plate', async () => {
    const plate = json(await call('POST', '/api/meals', kevin, { name: 'Bad schedule' })).meal
    expect((await call('POST', `/api/meals/${plate.id}/schedule`, kevin, { date: 'nope', mealType: 'dinner' })).statusCode).toBe(400)
    expect((await call('POST', `/api/meals/${plate.id}/schedule`, kevin, { date: '2026-06-07', mealType: 'brunch' })).statusCode).toBe(400)
    expect((await call('POST', `/api/meals/${foreignMealId}/schedule`, kevin, { date: '2026-06-07', mealType: 'dinner' })).statusCode).toBe(404)
  })

  it('respects the one-entry-per-slot index: a plate replaces a recipe and vice versa', async () => {
    // recipe first…
    const first = await call('POST', '/api/meals/plan', kevin, { date: '2026-06-08', mealType: 'dinner', recipeId: bbqChicken })
    expect(first.statusCode).toBe(200)
    const plate = json(await call('POST', '/api/meals', kevin, { name: 'Slot taker', recipes: [{ recipeId: coleslaw }] })).meal
    const second = await call('POST', `/api/meals/${plate.id}/schedule`, kevin, { date: '2026-06-08', mealType: 'dinner' })
    expect(second.statusCode).toBe(200)
    expect(json(second).entry.id).toBe(json(first).entry.id) // upserted, not duplicated
    expect(json(second).entry.recipeId).toBe(null)

    // …and back to a plain recipe: the stale meal_id must be cleared
    const third = await call('POST', '/api/meals/plan', kevin, { date: '2026-06-08', mealType: 'dinner', recipeId: potatoSalad })
    expect(third.statusCode).toBe(200)
    expect(json(third).entry.mealId).toBe(null)
    expect(json(third).entry.recipeId).toBe(potatoSalad)
    const rows = await withClient((c) =>
      c.query(`select 1 from meal_plan_entries where household_id=$1 and date='2026-06-08' and meal_type='dinner' and deleted_at is null`, [householdId])
    )
    expect(rows.rowCount).toBe(1)
  })

  it('copies a SAVED plate on schedule, so editing the library plate never rewrites a past meal', async () => {
    const saved = json(await call('POST', '/api/meals', kevin, {
      name: 'Library BBQ',
      isSaved: true,
      recipes: [{ recipeId: bbqChicken, role: 'main' }],
    })).meal
    const entry = json(await call('POST', `/api/meals/${saved.id}/schedule`, kevin, { date: '2026-06-09', mealType: 'dinner' })).entry
    expect(entry.mealId).not.toBe(saved.id) // a copy, not the library plate itself

    // rewrite the library plate…
    await call('PATCH', `/api/meals/${saved.id}`, kevin, { name: 'Library BBQ v2' })
    await call('POST', `/api/meals/${saved.id}/recipes`, kevin, { recipeId: peachCobbler, role: 'dessert' })

    // …the scheduled plate is untouched
    const scheduled = json(await call('GET', `/api/meals/${entry.mealId}`, kevin)).meal
    expect(scheduled.name).toBe('Library BBQ')
    expect(scheduled.recipes.map((r: { recipeId: string }) => r.recipeId)).toEqual([bbqChicken])
    expect(scheduled.isSaved).toBe(false)
  })

  it('an UNSAVED one-off plate is scheduled as itself (no copy)', async () => {
    const plate = json(await call('POST', '/api/meals', kevin, { name: 'One-off', recipes: [{ recipeId: coleslaw }] })).meal
    const entry = json(await call('POST', `/api/meals/${plate.id}/schedule`, kevin, { date: '2026-06-10', mealType: 'lunch' })).entry
    expect(entry.mealId).toBe(plate.id)
  })

  it('the planned week renders a meal-backed slot with all its dishes', async () => {
    const week = await call('GET', '/api/meals/week?start=2026-06-07&days=7', kevin)
    expect(week.statusCode).toBe(200)
    const entry = json(week).entries.find((e: { date: string; mealType: string }) => e.date === '2026-06-07' && e.mealType === 'dinner')
    expect(entry.recipe).toBe(null)
    expect(entry.meal).toMatchObject({ name: 'Schedule me', servings: 4 })
    expect(entry.meal.recipes.map((r: { title: string }) => r.title)).toEqual(['BBQ Chicken', 'Coleslaw'])
  })

  it('GET /api/meals/entry/:id resolves a meal-backed entry to its plate', async () => {
    const entryRow = await withClient((c) =>
      c.query<{ id: string }>(
        `select id from meal_plan_entries where household_id=$1 and date='2026-06-07' and meal_type='dinner' and deleted_at is null`,
        [householdId]
      )
    )
    const res = await call('GET', `/api/meals/entry/${entryRow.rows[0].id}`, kevin)
    expect(res.statusCode).toBe(200)
    expect(json(res).recipeId).toBe(null)
    expect(json(res).mealId).toBeTruthy()
    expect(json(res).recipeIds).toEqual([bbqChicken, coleslaw])
  })
})

describe('calendar: a meal event shows the whole plate', () => {
  it('titles the event with the plate and lists every dish', async () => {
    const entryRow = await withClient((c) =>
      c.query<{ id: string; event_id: string | null }>(
        `select id, event_id from meal_plan_entries where household_id=$1 and date='2026-06-07' and meal_type='dinner' and deleted_at is null`,
        [householdId]
      )
    )
    const eventId = entryRow.rows[0].event_id
    expect(eventId).toBeTruthy()
    const ev = await withClient((c) =>
      c.query<{ title: string; description: string | null }>(`select title, description from events where id = $1`, [eventId])
    )
    expect(ev.rows[0].title).toContain('Dinner · Schedule me')
    expect(ev.rows[0].title).toContain('🍗') // the plate's first dish emoji
    expect(ev.rows[0].description).toContain('BBQ Chicken')
    expect(ev.rows[0].description).toContain('Coleslaw')
  })

  it('a single-recipe entry keeps its old event title (no regression)', async () => {
    await call('POST', '/api/meals/plan', kevin, { date: '2026-06-11', mealType: 'dinner', recipeId: peachCobbler })
    const ev = await withClient((c) =>
      c.query<{ title: string }>(
        `select e.title from events e join meal_plan_entries m on m.event_id = e.id
          where m.household_id=$1 and m.date='2026-06-11' and m.meal_type='dinner'`,
        [householdId]
      )
    )
    expect(ev.rows[0].title).toBe('🍑 Dinner · Peach Cobbler')
  })
})

// "Add plate to list" and the grocery board's meal rows. Source semantics matter:
// 'auto' rows are derived from the week's plan and WIPED by every rebuild; 'recipe'
// rows are explicit off-plan adds and must survive one.
describe('grocery: a plate on the list', () => {
  const WEEK = '2026-07-05' // a quiet Sunday, away from the scheduling tests above
  let sidesPlate = ''
  let scheduledPlate = ''

  it('adds every dish to the list without scheduling anything', async () => {
    sidesPlate = json(await call('POST', '/api/meals', kevin, {
      name: 'Sides to buy',
      recipes: [{ recipeId: potatoSalad, role: 'side' }, { recipeId: coleslaw, role: 'side' }],
    })).meal.id
    const res = await call('POST', `/api/meals/${sidesPlate}/add-to-list?weekStart=${WEEK}`, kevin)
    expect(res.statusCode).toBe(201)
    // Potatoes + Mayonnaise + Cabbage — mayonnaise is shared by both dishes, so ONE row
    expect(json(res).added).toBe(3)

    // nothing was scheduled
    const entries = await withClient((c) =>
      c.query(`select 1 from meal_plan_entries where household_id=$1 and meal_id=$2 and deleted_at is null`, [householdId, sidesPlate])
    )
    expect(entries.rowCount).toBe(0)

    const board = json(await call('GET', `/api/lists/grocery/board?weekStart=${WEEK}`, kevin))
    const names = board.items.map((i: { name: string }) => i.name)
    expect(names).toContain('Potatoes')
    expect(names).toContain('Cabbage')
    const mayo = board.items.find((i: { name: string }) => i.name === 'Mayonnaise')
    // an explicit off-plan add → 'recipe', which the weekly rebuild must not wipe
    expect(mayo.source).toBe('recipe')
    expect(mayo.sourceRecipeIds.sort()).toEqual([potatoSalad, coleslaw].sort())
  })

  it('renders the plate as one parent row with child recipe rows under Unscheduled', async () => {
    const board = json(await call('GET', `/api/lists/grocery/board?weekStart=${WEEK}`, kevin))
    const meal = board.unscheduledMeals.find((m: { mealId: string }) => m.mealId === sidesPlate)
    expect(meal).toBeTruthy()
    expect(meal.name).toBe('Sides to buy')
    expect(meal.recipes.map((r: { recipeId: string }) => r.recipeId)).toEqual([potatoSalad, coleslaw])
    expect(meal.recipes[0]).toMatchObject({ title: 'Potato Salad', emoji: '🥔' })
    expect(typeof meal.color).toBe('string')
    // its dishes belong to the plate now — they must not ALSO show as loose recipes
    const loose = board.unscheduled.map((r: { recipeId: string }) => r.recipeId)
    expect(loose).not.toContain(potatoSalad)
    expect(loose).not.toContain(coleslaw)
  })

  it('the weekly rebuild expands a SCHEDULED plate into its dishes’ ingredients', async () => {
    scheduledPlate = json(await call('POST', '/api/meals', kevin, {
      name: 'Scheduled plate',
      recipes: [{ recipeId: bbqChicken, role: 'main' }, { recipeId: peachCobbler, role: 'dessert' }],
    })).meal.id
    expect((await call('POST', `/api/meals/${scheduledPlate}/schedule`, kevin, { date: '2026-07-06', mealType: 'dinner' })).statusCode).toBe(200)

    const res = await call('POST', `/api/lists/grocery/rebuild?weekStart=${WEEK}`, kevin)
    expect(res.statusCode).toBe(200)
    const board = json(res).board
    const auto = board.items.filter((i: { source: string }) => i.source === 'auto')
    const autoNames = auto.map((i: { name: string }) => i.name)
    expect(autoNames).toContain('Chicken thighs')
    expect(autoNames).toContain('Barbecue sauce')
    expect(autoNames).toContain('Peaches')
    expect(autoNames).toContain('Cinnamon')
    // the off-plan 'recipe' rows survived the rebuild
    expect(board.items.some((i: { name: string; source: string }) => i.name === 'Mayonnaise' && i.source === 'recipe')).toBe(true)
    // and each auto row is credited to the dish it came from
    const chicken = auto.find((i: { name: string }) => i.name === 'Chicken thighs')
    expect(chicken.sourceRecipeIds).toContain(bbqChicken)
  })

  it('the board’s planned meals carry the plate and its dishes', async () => {
    const board = json(await call('GET', `/api/lists/grocery/board?weekStart=${WEEK}`, kevin))
    const meal = board.meals.find((m: { date: string }) => String(m.date).startsWith('2026-07-06'))
    expect(meal).toMatchObject({ mealType: 'dinner', title: 'Scheduled plate', recipeId: null })
    expect(meal.mealId).toBe(scheduledPlate)
    expect(meal.recipes.map((r: { recipeId: string }) => r.recipeId)).toEqual([bbqChicken, peachCobbler])
    expect(meal.recipes[0]).toMatchObject({ title: 'BBQ Chicken', emoji: '🍗' })
    // a plain single-recipe slot still reports no child rows
    const single = json(await call('GET', '/api/lists/grocery/board?weekStart=2026-06-07', kevin)).meals.find(
      (m: { date: string }) => String(m.date).startsWith('2026-06-11')
    )
    expect(single.mealId).toBe(null)
    expect(single.recipes).toEqual([])
  })

  it('404s add-to-list for another household’s plate', async () => {
    expect((await call('POST', `/api/meals/${foreignMealId}/add-to-list`, kevin)).statusCode).toBe(404)
  })

  // add-to-list writes grocery rows, which belong to the lists module — so it has to
  // be gated on BOTH meals and lists, the same way /api/lists/grocery/from-recipe is.
  // Otherwise a household that has deliberately turned lists off can still be made to
  // grow a grocery list by adding a plate from the meals side.
  it('403s add-to-list when the lists module is off, even with meals on', async () => {
    await setModule('lists', false)
    try {
      const res = await call('POST', `/api/meals/${sidesPlate}/add-to-list?weekStart=${WEEK}`, kevin)
      expect(res.statusCode).toBe(403)
    } finally {
      await setModule('lists', true)
    }
    // and it works again once lists is back on
    expect((await call('POST', `/api/meals/${sidesPlate}/add-to-list?weekStart=${WEEK}`, kevin)).statusCode).toBe(201)
  })
})

// Regression guard (characterisation, not TDD — the behaviour already held): the
// week/month planners find empty slots via weekEntries. A meal-backed entry has
// recipe_id NULL, so if "empty" were keyed off the recipe rather than the entry the
// planner would happily overwrite a scheduled plate.
describe('the planner treats a meal-backed slot as filled', () => {
  it('does not offer to fill a night that already has a plate on it', async () => {
    const res = await call('POST', '/api/meals/plan-week', kevin, { start: '2026-07-05' })
    expect(res.statusCode).toBe(200)
    const dates = json(res).suggestions.map((s: { date: string }) => s.date)
    expect(dates).not.toContain('2026-07-06') // "Scheduled plate" lives here
  })
})

// A count alone is not actionable: "7 to buy" tells you the size of the problem
// and nothing about its content. The names ride along on the same payload so the
// builder can expand a dish's count into the actual shopping.
describe('what exactly is left to buy', () => {
  let plate = ''

  beforeAll(async () => {
    plate = json(await call('POST', '/api/meals', kevin, {
      name: 'Name-the-gap plate',
      recipes: [
        { recipeId: bbqChicken, role: 'main' },
        { recipeId: peachCobbler, role: 'dessert' },
      ],
    })).meal.id
  })

  it('names the ingredients still to buy, per dish and for the plate', async () => {
    await setModule('pantry', true)
    const meal = json(await call('GET', `/api/meals/${plate}`, kevin)).meal
    const chicken = meal.recipes.find((r: { recipeId: string }) => r.recipeId === bbqChicken)

    // Chicken is in the pantry from the block above, so it is NOT still to buy —
    // the names must agree with the count rather than listing every ingredient.
    expect(chicken.toBuyNames).toHaveLength(chicken.toBuy)
    expect(chicken.toBuyNames.join(' ').toLowerCase()).not.toContain('chicken')
    expect(meal.toBuyNames).toHaveLength(meal.toBuy)
  })

  it('still names them with the pantry off, where everything non-staple is to buy', async () => {
    await setModule('pantry', false)
    const meal = json(await call('GET', `/api/meals/${plate}`, kevin)).meal
    const chicken = meal.recipes.find((r: { recipeId: string }) => r.recipeId === bbqChicken)
    expect(chicken.onHand).toBe(null)
    expect(chicken.toBuyNames).toHaveLength(chicken.toBuy)
    // With no pantry to match against, the chicken IS still to buy.
    expect(chicken.toBuyNames.join(' ').toLowerCase()).toContain('chicken')
  })

  // The recipe screen's banner had the same gap the plate did: it said "7 to buy"
  // and could not say which 7. With the pantry ON it showed no names at all —
  // the count is the *unmatched* subset, and the client cannot work out which
  // ingredients those are from the ingredient list alone. The server can.
  it('names them on the recipe detail too, in both pantry states', async () => {
    await setModule('pantry', true)
    const on = json(await call('GET', `/api/recipes/${bbqChicken}`, kevin))
    expect(on.toBuyNames).toHaveLength(on.toBuy)
    expect(on.toBuyNames.join(' ').toLowerCase()).not.toContain('chicken')

    await setModule('pantry', false)
    const off = json(await call('GET', `/api/recipes/${bbqChicken}`, kevin))
    expect(off.onHand).toBe(null)
    expect(off.toBuyNames).toHaveLength(off.toBuy)
    expect(off.toBuyNames.join(' ').toLowerCase()).toContain('chicken')
  })

  it('dedupes a shared ingredient across the plate, matching the count', async () => {
    await setModule('pantry', false)
    const shared = json(await call('POST', '/api/meals', kevin, {
      name: 'Shared mayo',
      recipes: [{ recipeId: potatoSalad }, { recipeId: coleslaw }],
    })).meal
    const names = shared.toBuyNames.map((n: string) => n.toLowerCase())
    expect(new Set(names).size).toBe(names.length)
    expect(names).toHaveLength(shared.toBuy)
  })
})
