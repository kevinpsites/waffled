// Weekly Planning · step 7 (Meals) — the seven-column read, the fill and its undo, against a real
// Postgres. The step stores nothing of its own, so most of this is about NOT touching things.
//
// EVERY date derives from the week the SERVER named: which week a session plans depends on today,
// the household's `week_start` and its timezone.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let householdId: string
let weekStart: string
let days: string[]
let ownerId: string

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}

// lambda-api reads the query off `queryStringParameters`, not off the path.
function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const [rawPath, qs] = path.split('?')
  const queryStringParameters: Record<string, string> = {}
  if (qs) for (const pair of qs.split('&')) { const [k, v] = pair.split('='); queryStringParameters[k] = decodeURIComponent(v ?? '') }
  return app.run(
    { httpMethod: method, path: rawPath, headers, queryStringParameters, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<{ statusCode: number; body: string }>
}

const kevin = mint('dev|kevin')
const json = (r: { body: string }) => JSON.parse(r.body)

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

interface Night {
  date: string
  events: { id: string; title: string }[]
  dinner: {
    entryId: string
    title: string | null
    recipeId: string | null
    // A plate night is `recipe_id NULL` carrying a meal_id — what tells it apart from a title.
    mealId: string | null
    cookName: string | null
    cookAvatar: string | null
    minutes: number | null
  } | null
}
interface Trip {
  choreId: string
  personId: string | null
  personName: string | null
  dueOn: string
  dueTime: string | null
  status: string
}
interface StepView {
  weekStart: string
  nights: Night[]
  emptyDates: string[]
  groceries: { items: number; checked: number }
  choresOn: boolean
  shopping: Trip | null
}
interface Filled { date: string; entryId: string; recipeId: string | null; mealId: string | null; title: string | null }

const stepView = async (week = weekStart): Promise<StepView> =>
  json(await call('GET', `/api/weekly-planning/meals?weekStart=${week}`, kevin))

const planDinner = (date: string, body: Record<string, unknown>) =>
  call('POST', '/api/meals/plan', kevin, { date, mealType: 'dinner', ...body })

async function seedRecipe(title: string, ingredient: string): Promise<string> {
  const r = await call('POST', '/api/recipes', kevin, {
    title,
    servings: 4,
    ingredients: [{ name: ingredient, amount: 1, unit: 'lb' }],
  })
  expect(r.statusCode).toBe(201)
  return json(r).recipe.id
}

// A SAVED plate of two dishes. Saved matters: scheduling one COPIES it, so the meal_id on the
// night is a fresh id and never the library plate's — which is what makes the undo check strong.
async function seedPlate(name: string, recipeIds: string[]): Promise<string> {
  const r = await call('POST', '/api/meals', kevin, {
    name,
    servings: 4,
    isSaved: true,
    recipes: recipeIds.map((recipeId, i) => ({ recipeId, sortOrder: i })),
  })
  expect(r.statusCode).toBe(201)
  return json(r).meal.id
}

const schedulePlate = (mealId: string, date: string) =>
  call('POST', `/api/meals/${mealId}/schedule`, kevin, { date, mealType: 'dinner' })

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
  householdId = json(setup).household.id
  ownerId = json(setup).person.id
  const { query } = await import('../src/platform/db')
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [householdId, ownerId]
  )
}, 180_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('weekly planning · meals · the gate', () => {
  it('403s while the weeklyPlanning module is off', async () => {
    expect((await call('GET', '/api/weekly-planning/meals', kevin)).statusCode).toBe(403)
  })

  it('opens once the module is on, and the SERVER names the week', async () => {
    expect((await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: true })).statusCode).toBe(200)
    const planning = json(await call('GET', '/api/weekly-planning', kevin))
    weekStart = planning.weekStart
    days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

    const res = await call('GET', '/api/weekly-planning/meals', kevin)
    expect(res.statusCode).toBe(200)
    // No `weekStart` asked for ⇒ the same week the session view named.
    expect(json(res).weekStart).toBe(weekStart)
    expect(json(res).nights.map((n: Night) => n.date)).toEqual(days)
  })

  it('snaps a mid-week date back to its week start rather than keying a day', async () => {
    const view = await stepView(addDays(weekStart, 3))
    expect(view.weekStart).toBe(weekStart)
    expect(view.nights.map((n) => n.date)).toEqual(days)
  })
})

describe('weekly planning · meals · the week as it stands', () => {
  let pasta: string
  let tacos: string

  it('shows the plan as-is: four nights set, three empty', async () => {
    pasta = await seedRecipe('Pasta bake', 'rigatoni')
    tacos = await seedRecipe('Fish tacos', 'tilapia')
    // Enough of a library that the shuffle has a dish for every empty night, twice over.
    for (const [title, ingredient] of [
      ['Chili', 'kidney beans'],
      ['Sheet-pan chicken', 'chicken thighs'],
      ['Stir fry', 'broccoli'],
      ['Soup', 'carrots'],
      ['Curry', 'coconut milk'],
      ['Burgers', 'ground beef'],
      ['Salmon', 'salmon fillet'],
      ['Risotto', 'arborio rice'],
      ['Enchiladas', 'tortillas'],
      ['Meatballs', 'ground pork'],
    ]) await seedRecipe(title, ingredient)

    expect((await planDinner(days[0], { recipeId: pasta })).statusCode).toBe(200)
    expect((await planDinner(days[1], { recipeId: tacos })).statusCode).toBe(200)
    expect((await planDinner(days[2], { title: 'Leftovers' })).statusCode).toBe(200)
    expect((await planDinner(days[4], { title: 'Eating out' })).statusCode).toBe(200)

    const view = await stepView()
    expect(view.nights.filter((n) => n.dinner).map((n) => n.date)).toEqual([days[0], days[1], days[2], days[4]])
    expect(view.emptyDates).toEqual([days[3], days[5], days[6]])
    expect(view.nights[0].dinner?.title).toBe('Pasta bake')
    expect(view.nights[2].dinner?.title).toBe('Leftovers')
  })

  it("puts that night's events above the dish — but never the meal's own mirror event", async () => {
    const ev = await call('POST', '/api/events', kevin, {
      title: 'Soccer practice',
      startsAt: `${days[3]}T22:30:00.000Z`,
      endsAt: `${days[3]}T23:30:00.000Z`,
    })
    expect(ev.statusCode).toBe(201)

    const view = await stepView()
    const thu = view.nights.find((n) => n.date === days[3])!
    expect(thu.events.map((e) => e.title)).toContain('Soccer practice')

    // Planning a dinner mirrors it onto the calendar, so origin='meal_plan'/'meal_prep' rows are
    // filtered out of the context.
    const monday = view.nights.find((n) => n.date === days[0])!
    expect(monday.dinner?.title).toBe('Pasta bake')
    expect(monday.events.some((e) => /pasta bake|dinner/i.test(e.title))).toBe(false)
  })

  it("names the cook when the plan has one, and the recipe's time when it doesn't", async () => {
    // A cook is real data — meal_plan_entries.cook_person_id — so the attribution line is sourced.
    expect((await planDinner(days[0], { recipeId: pasta, cookPersonId: ownerId })).statusCode).toBe(200)
    const view = await stepView()
    expect(view.nights[0].dinner?.cookName).toBe('Kevin')
    expect(view.nights[1].dinner?.cookName).toBeNull()
    expect(view.nights[1].dinner?.minutes).toBeNull()
  })

  it('reports the grocery list as one number, not a panel', async () => {
    const view = await stepView()
    expect(typeof view.groceries.items).toBe('number')
    expect(typeof view.groceries.checked).toBe('number')
  })
})

describe('weekly planning · meals · plan the rest for me', () => {
  let filled: Filled[]
  let before: Night[]

  it('fills ONLY the empty nights and leaves the set ones exactly as they were', async () => {
    before = (await stepView()).nights.filter((n) => n.dinner)
    const groceriesBefore = (await stepView()).groceries.items

    const res = await call('POST', '/api/weekly-planning/meals/fill', kevin, { weekStart })
    expect(res.statusCode).toBe(200)
    filled = json(res).filled
    expect(filled.map((f) => f.date)).toEqual([days[3], days[5], days[6]])

    const view: StepView = json(res).view
    expect(view.emptyDates).toEqual([])
    // The four nights somebody already decided are byte-for-byte what they were.
    const after = view.nights.filter((n) => n.dinner)
    for (const b of before) {
      const a = after.find((n) => n.date === b.date)!
      expect(a.dinner!.entryId).toBe(b.dinner!.entryId)
      expect(a.dinner!.title).toBe(b.dinner!.title)
      expect(a.dinner!.recipeId).toBe(b.dinner!.recipeId)
    }
    expect(view.groceries.items).toBeGreaterThan(groceriesBefore)
  })

  it('has nothing left to fill once the week is full', async () => {
    const res = await call('POST', '/api/weekly-planning/meals/fill', kevin, { weekStart })
    expect(res.statusCode).toBe(200)
    expect(json(res).filled).toEqual([])
  })

  it('undoes exactly the nights it filled', async () => {
    const res = await call('POST', '/api/weekly-planning/meals/undo', kevin, { weekStart, filled })
    expect(res.statusCode).toBe(200)
    expect(json(res).cleared.sort()).toEqual([days[3], days[5], days[6]])

    const view: StepView = json(res).view
    expect(view.emptyDates).toEqual([days[3], days[5], days[6]])
    expect(view.nights.filter((n) => n.dinner).map((n) => n.date)).toEqual([days[0], days[1], days[2], days[4]])
  })

  it('refuses to undo a night somebody has since changed by hand', async () => {
    const fill = await call('POST', '/api/weekly-planning/meals/fill', kevin, { weekStart })
    const wrote: Filled[] = json(fill).filled
    expect(wrote).toHaveLength(3)

    // Overwriting a set night is a tap on that night, which makes it a decision, not an auto-fill.
    expect((await planDinner(days[5], { title: 'Grandma’s' })).statusCode).toBe(200)

    const undo = await call('POST', '/api/weekly-planning/meals/undo', kevin, { weekStart, filled: wrote })
    expect(undo.statusCode).toBe(200)
    expect(json(undo).cleared.sort()).toEqual([days[3], days[6]])
    expect(json(undo).kept).toEqual([days[5]])

    const view: StepView = json(undo).view
    expect(view.nights.find((n) => n.date === days[5])!.dinner!.title).toBe('Grandma’s')
    expect(view.emptyDates).toEqual([days[3], days[6]])

    await call('DELETE', `/api/meals/plan?date=${days[5]}&mealType=dinner`, kevin)
  })

  it('never fills outside the week the server named', async () => {
    const other = addDays(weekStart, 7)
    const res = await call('POST', '/api/weekly-planning/meals/fill', kevin, { weekStart: other })
    expect(res.statusCode).toBe(200)
    for (const f of json(res).filled as Filled[]) {
      expect(f.date >= other).toBe(true)
      expect(f.date <= addDays(other, 6)).toBe(true)
    }
    expect((await stepView()).emptyDates).toEqual([days[3], days[5], days[6]])
  })

  it('ignores an undo claim for a date outside the week', async () => {
    const res = await call('POST', '/api/weekly-planning/meals/undo', kevin, {
      weekStart,
      filled: [{ date: addDays(weekStart, 30), entryId: '00000000-0000-4000-8000-000000000000', recipeId: null, title: 'nope' }],
    })
    expect(res.statusCode).toBe(200)
    expect(json(res).cleared).toEqual([])
  })

  // POST /api/meals/plan could apply the approved cards, but it can neither refuse a night
  // somebody already decided nor hand back the receipt the undo checks.
  it('applies a week the family approved — and STILL only the empty nights', async () => {
    const before = (await stepView()).nights.filter((n) => n.dinner)
    const cards = days.map((d, i) => ({ date: d, mealType: 'dinner', title: `Approved ${i}`, recipeId: null }))

    const res = await call('POST', '/api/weekly-planning/meals/fill', kevin, { weekStart, cards })
    expect(res.statusCode).toBe(200)
    const wrote: Filled[] = json(res).filled
    expect(wrote.map((f) => f.date)).toEqual([days[3], days[5], days[6]])
    expect(wrote.map((f) => f.title)).toEqual(['Approved 3', 'Approved 5', 'Approved 6'])

    const view: StepView = json(res).view
    for (const b of before) {
      const a = view.nights.find((n) => n.date === b.date)!
      expect(a.dinner!.entryId).toBe(b.dinner!.entryId)
      expect(a.dinner!.title).toBe(b.dinner!.title)
    }

    // …and the receipt is real: the undo it hands back clears exactly those three.
    const undo = await call('POST', '/api/weekly-planning/meals/undo', kevin, { weekStart, filled: wrote })
    expect(json(undo).cleared.sort()).toEqual([days[3], days[5], days[6]])
    expect((await stepView()).emptyDates).toEqual([days[3], days[5], days[6]])
  })

  it('writes nothing when the approved week arrives malformed', async () => {
    // Absent `cards` means "draft it for me". Anything else that isn't a usable list must NOT fall
    // through to that — the family would get a week they never saw.
    const res = await call('POST', '/api/weekly-planning/meals/fill', kevin, { weekStart, cards: 'nope' })
    expect(res.statusCode).toBe(200)
    expect(json(res).filled).toEqual([])
    expect((json(res).view as StepView).emptyDates).toEqual([days[3], days[5], days[6]])
  })

  it('drops an approved card that names a meal this step does not plan', async () => {
    // The picker is narrowed to dinner, so writing a lunch card as a dinner would move it to 6pm.
    const res = await call('POST', '/api/weekly-planning/meals/fill', kevin, {
      weekStart,
      cards: [
        { date: days[3], mealType: 'lunch', title: 'Sandwiches', recipeId: null },
        { date: days[5], mealType: 'dinner', title: 'Chili night', recipeId: null },
      ],
    })
    expect(res.statusCode).toBe(200)
    expect((json(res).filled as Filled[]).map((f) => f.date)).toEqual([days[5]])
    expect((json(res).view as StepView).emptyDates).toEqual([days[3], days[6]])

    await call('DELETE', `/api/meals/plan?date=${days[5]}&mealType=dinner`, kevin)
    expect((await stepView()).emptyDates).toEqual([days[3], days[5], days[6]])
  })
})

// The night picker's library comes straight off GET /api/recipes.
describe('weekly planning · meals · the picker\'s library', () => {
  it('lists a recipe that has nothing but a title', async () => {
    const res = await call('POST', '/api/recipes', kevin, { title: 'Dummy recipe' })
    expect(res.statusCode).toBe(201)
    const id = json(res).recipe.id

    const list = await call('GET', '/api/recipes', kevin)
    expect(list.statusCode).toBe(200)
    const found = (json(list).recipes as { id: string; title: string }[]).find((r) => r.id === id)
    expect(found?.title).toBe('Dummy recipe')

    expect((await planDinner(days[3], { recipeId: id })).statusCode).toBe(200)
    expect((await stepView()).nights[3].dinner!.title).toBe('Dummy recipe')
    await call('DELETE', `/api/meals/plan?date=${days[3]}&mealType=dinner`, kevin)
  })
})

// PLATE PARITY, and the whole risk of it is the undo receipt. A plate is `recipe_id NULL` +
// `meal_id` + the plate's NAME as the title, and `upsertEntry` keeps the row id across an
// overwrite, so `meal_id` is the only dimension telling a filled title from a plate of that name.
describe('weekly planning · meals · a night can be a plate', () => {
  let plate: string

  it('plans a night as a plate, and the step reads it back as one', async () => {
    const chicken = await seedRecipe('BBQ Chicken', 'chicken thighs')
    const salad = await seedRecipe('Potato Salad', 'potatoes')
    plate = await seedPlate('BBQ Sunday', [chicken, salad])

    expect((await schedulePlate(plate, days[3])).statusCode).toBe(200)

    const view = await stepView()
    const night = view.nights.find((n) => n.date === days[3])!
    // The dish reads as the PLATE — which is also what stops the takeout classifier firing on it.
    expect(night.dinner!.title).toBe('BBQ Sunday')
    expect(night.dinner!.recipeId).toBeNull()
    expect(night.dinner!.mealId).toBeTruthy()
    expect(night.dinner!.mealId).not.toBe(plate)
    expect(view.emptyDates).toEqual([days[5], days[6]])

    await call('DELETE', `/api/meals/plan?date=${days[3]}&mealType=dinner`, kevin)
    expect((await stepView()).emptyDates).toEqual([days[3], days[5], days[6]])
  })

  it('KEEPS a filled night that was hand-changed to a plate of the same name', async () => {
    // The adversarial case, built to fail on (entryId, recipeId, title) alone.
    const cards = [{ date: days[3], mealType: 'dinner', title: 'BBQ Sunday', recipeId: null }]
    const fill = await call('POST', '/api/weekly-planning/meals/fill', kevin, { weekStart, cards })
    expect(fill.statusCode).toBe(200)
    const wrote: Filled[] = json(fill).filled
    expect(wrote.map((f) => f.date)).toEqual([days[3]])
    expect(wrote[0].title).toBe('BBQ Sunday')
    expect(wrote[0].mealId).toBeNull()

    expect((await schedulePlate(plate, days[3])).statusCode).toBe(200)
    const after = (await stepView()).nights.find((n) => n.date === days[3])!.dinner!
    expect(after.entryId).toBe(wrote[0].entryId) // upsert kept the row id
    expect(after.title).toBe('BBQ Sunday') // …and the title
    expect(after.mealId).toBeTruthy() // only meal_id tells them apart

    const undo = await call('POST', '/api/weekly-planning/meals/undo', kevin, { weekStart, filled: wrote })
    expect(undo.statusCode).toBe(200)
    expect(json(undo).cleared).toEqual([])
    expect(json(undo).kept).toEqual([days[3]])
    // The plate somebody chose is still there — an undo has no business taking it.
    const view: StepView = json(undo).view
    expect(view.nights.find((n) => n.date === days[3])!.dinner!.mealId).toBeTruthy()

    await call('DELETE', `/api/meals/plan?date=${days[3]}&mealType=dinner`, kevin)
    expect((await stepView()).emptyDates).toEqual([days[3], days[5], days[6]])
  })

  it('still undoes a plain recipe fill — the plate check must not break what worked', async () => {
    const fill = await call('POST', '/api/weekly-planning/meals/fill', kevin, { weekStart })
    const wrote: Filled[] = json(fill).filled
    expect(wrote).toHaveLength(3)
    for (const f of wrote) expect(f.mealId).toBeNull()

    const undo = await call('POST', '/api/weekly-planning/meals/undo', kevin, { weekStart, filled: wrote })
    expect(json(undo).cleared.sort()).toEqual([days[3], days[5], days[6]])
    expect(json(undo).kept).toEqual([])
    expect((await stepView()).emptyDates).toEqual([days[3], days[5], days[6]])
  })

  it('undoes a night that really is the plate the receipt names', async () => {
    // The mirror image of `kept`: when the receipt's meal_id IS the row's, clearing it is right.
    const sched = await schedulePlate(plate, days[5])
    expect(sched.statusCode).toBe(200)
    const entry = json(sched).entry as { id: string; mealId: string | null }
    const claim = [{ date: days[5], entryId: entry.id, recipeId: null, mealId: entry.mealId, title: 'BBQ Sunday' }]

    const undo = await call('POST', '/api/weekly-planning/meals/undo', kevin, { weekStart, filled: claim })
    expect(json(undo).cleared).toEqual([days[5]])
    expect(json(undo).kept).toEqual([])
    expect((await stepView()).emptyDates).toEqual([days[3], days[5], days[6]])
  })
})

describe('weekly planning · meals · who is shopping', () => {
  // The trip is a REAL chore, and there must be exactly ONE per week however often minds change.
  const shopperChores = async () => {
    const { query } = await import('../src/platform/db')
    const { rows } = await query<{ id: string; person_id: string | null; due_on: string; due_time: string | null }>(
      `select c.id, ci.person_id, to_char(ci.due_on,'YYYY-MM-DD') as due_on, to_char(c.due_time,'HH24:MI') as due_time
         from chores c join chore_instances ci on ci.chore_id = c.id and ci.deleted_at is null
        where c.household_id = $1 and c.deleted_at is null and lower(c.title) = 'groceries'
        order by ci.due_on`,
      [householdId]
    )
    return rows
  }
  const setShopper = (body: Record<string, unknown>) =>
    call('PUT', '/api/weekly-planning/meals/shopper', kevin, { weekStart, ...body })

  it('starts with no trip and no invented shopper', async () => {
    const view = await stepView()
    expect(view.choresOn).toBe(true)
    expect(view.shopping).toBeNull()
    expect(await shopperChores()).toHaveLength(0)
  })

  it('assigning creates exactly one chore for the week', async () => {
    const res = await setShopper({ personId: ownerId, dueOn: days[6], dueTime: '09:00' })
    expect(res.statusCode).toBe(200)
    expect(json(res).shopping).toMatchObject({ personId: ownerId, personName: 'Kevin', dueOn: days[6], dueTime: '09:00' })

    const chores = await shopperChores()
    expect(chores).toHaveLength(1)
    expect(chores[0]).toMatchObject({ person_id: ownerId, due_on: days[6], due_time: '09:00' })
    expect((await stepView()).shopping?.choreId).toBe(chores[0].id)
  })

  it('changing the shopper or the day updates the one chore, never duplicates it', async () => {
    const first = (await shopperChores())[0].id

    expect((await setShopper({ personId: ownerId, dueOn: days[5], dueTime: '09:00' })).statusCode).toBe(200)
    expect(await shopperChores()).toHaveLength(1)
    expect((await shopperChores())[0]).toMatchObject({ id: first, due_on: days[5] })

    // Up for grabs — a real answer, not a cleared trip: the chore stays, unassigned.
    const res = await setShopper({ personId: null, dueOn: days[5], dueTime: '09:00' })
    expect(json(res).shopping).toMatchObject({ choreId: first, personId: null, dueOn: days[5] })
    expect(await shopperChores()).toHaveLength(1)
    expect((await shopperChores())[0].person_id).toBeNull()

    expect((await setShopper({ personId: ownerId, dueOn: days[3], dueTime: '17:30' })).statusCode).toBe(200)
    const chores = await shopperChores()
    expect(chores).toHaveLength(1)
    expect(chores[0]).toMatchObject({ id: first, person_id: ownerId, due_on: days[3], due_time: '17:30' })
  })

  it('finds the same trip again after the chore is renamed on the Tasks board', async () => {
    const before = (await shopperChores())[0].id
    expect((await call('PATCH', `/api/chores/${before}`, kevin, { title: 'Costco run' })).statusCode).toBe(200)

    // The title key can't see it, so the `choreId` hint is what stops a second trip appearing.
    expect(json(await call('GET', `/api/weekly-planning/meals?weekStart=${weekStart}&choreId=${before}`, kevin)).shopping?.choreId).toBe(before)
    expect((await setShopper({ personId: ownerId, dueOn: days[2], choreId: before })).statusCode).toBe(200)
    const rows = await shopperChores()
    expect(rows.filter((r) => r.id === before)).toHaveLength(0) // renamed out of the title key
    expect(rows).toHaveLength(0) // …and no second "Groceries" was created

    await call('PATCH', `/api/chores/${before}`, kevin, { title: 'Groceries' })
    expect(await shopperChores()).toHaveLength(1)
  })

  it('refuses a shopping day outside the week rather than silently moving it', async () => {
    const res = await setShopper({ personId: ownerId, dueOn: addDays(weekStart, 20) })
    expect(res.statusCode).toBe(400)
    expect(await shopperChores()).toHaveLength(1)
  })

  it('clearing the trip removes the chore rather than orphaning it', async () => {
    const res = await setShopper({ personId: null, dueOn: null })
    expect(res.statusCode).toBe(200)
    expect(json(res).shopping).toBeNull()
    expect(await shopperChores()).toHaveLength(0)
    expect((await stepView()).shopping).toBeNull()
  })

  it('drops the whole thing when the chores module is off — read still works', async () => {
    expect((await setShopper({ personId: ownerId, dueOn: days[6] })).statusCode).toBe(200)
    expect((await call('PATCH', '/api/household/modules', kevin, { chores: false })).statusCode).toBe(200)

    // Meals is gated on `meals`, not `chores`, so the week still reads with no control and no trip.
    const view = await stepView()
    expect(view.choresOn).toBe(false)
    expect(view.shopping).toBeNull()
    expect(view.nights).toHaveLength(7)
    expect((await setShopper({ personId: ownerId, dueOn: days[6] })).statusCode).toBe(403)

    await call('PATCH', '/api/household/modules', kevin, { chores: true })
    expect((await stepView()).choresOn).toBe(true)
  })

    // A STALE HINT MUST NOT REACH INTO ANOTHER WEEK: `?choreId=` is a hint, never a fact, and
    // OR'ing it in OUTSIDE the week bound let it resolve — and rewrite — LAST week's trip.
  it('ignores a hint whose chore belongs to another week', async () => {
    await setShopper({ personId: ownerId, dueOn: days[6], dueTime: '09:00' })
    const thisWeeksTrip = (await stepView()).shopping?.choreId as string
    expect(thisWeeksTrip).toBeTruthy()

    const nextWeek = addDays(weekStart, 7)
    const next = json(await call(
      'GET', `/api/weekly-planning/meals?weekStart=${nextWeek}&choreId=${thisWeeksTrip}`, kevin))
    expect(next.weekStart).toBe(nextWeek)
    // Next week has no trip of its own, and must not borrow this week's.
    expect(next.shopping).toBeNull()

    const same = json(await call(
      'GET', `/api/weekly-planning/meals?weekStart=${weekStart}&choreId=${thisWeeksTrip}`, kevin))
    expect(same.shopping?.choreId).toBe(thisWeeksTrip)
  })
})

describe('weekly planning · meals · the meals module', () => {
  it('403s when the module this step reads is turned off', async () => {
    expect((await call('PATCH', '/api/household/modules', kevin, { meals: false })).statusCode).toBe(200)
    expect((await call('GET', '/api/weekly-planning/meals', kevin)).statusCode).toBe(403)
    expect((await call('POST', '/api/weekly-planning/meals/fill', kevin, { weekStart })).statusCode).toBe(403)
    expect((await call('POST', '/api/weekly-planning/meals/undo', kevin, { weekStart, filled: [] })).statusCode).toBe(403)
    await call('PATCH', '/api/household/modules', kevin, { meals: true })
  })
})
