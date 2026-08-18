// The grocery week key is a WEEK BOUNDARY, not "whatever date the caller happened to
// name". Every grocery row carries `week_start`, and the board only ever asks for the
// household's week starts — so a rebuild stamped with a mid-week date writes rows onto a
// key nothing will ever look at again. "Plan the month" hit exactly that: it rebuilt with
// `monthStart` (Sep 1 2026 is a Tuesday), the rows landed on `2026-09-01`, and every real
// household week came back empty.
//
// Two rules pinned here:
//
//   1. ANY DATE IN A WEEK MEANS THAT WEEK. `?weekStart=` is snapped to the household's
//      first-day-of-week before it touches the database, honoring the sunday|monday
//      preference. Naming Wednesday and naming that Sunday must be the same request.
//   2. A MONTH IS 4–6 WEEKS. Rebuilding once cannot cover a month; the caller has to
//      rebuild each week it touched. Driven here with the raw planned dates, which is
//      what a client naturally has on hand.
//
// HARNESS NOTE: lambda-api does NOT parse a query string out of `path` — it reads
// `queryStringParameters`. Tests that pass `{}` make every `?weekStart=` vanish and the
// route silently falls back to the household's CURRENT week, which is how this bug went
// unnoticed. `call()` below splits and hands it over properly.
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

type Board = { weekStart: string; items: Array<{ name: string }> }
const board = async (weekStart: string): Promise<Board> =>
  JSON.parse((await call('GET', `/api/lists/grocery/board?weekStart=${weekStart}`, kevin)).body)
const names = async (weekStart: string): Promise<string[]> => (await board(weekStart)).items.map((i) => i.name)
const rebuild = (weekStart: string) => call('POST', `/api/lists/grocery/rebuild?weekStart=${weekStart}`, kevin)

// Every week key that actually exists in the table. Once the routes snap, an orphan key
// is unreachable through the API (the board snaps too) — so the "no key the board never
// asks for" half of the rule can only be checked against the rows themselves.
const weekKeys = async (): Promise<string[]> =>
  (
    await withClient((c) =>
      c.query<{ wk: string }>(
        `select distinct to_char(week_start,'YYYY-MM-DD') as wk from list_items
          where household_id=$1 and week_start is not null and deleted_at is null order by 1`,
        [householdId]
      )
    )
  ).rows.map((r) => r.wk)

// One recipe per planned night, each with a unique ingredient, so a board row names
// exactly which night's shopping landed on that week.
async function plan(date: string, ingredient: string): Promise<void> {
  const recipeId = (
    await withClient((c) =>
      c.query<{ id: string }>(
        `insert into recipes (household_id, title, category, servings) values ($1,$2,'dinner',4) returning id`,
        [householdId, `Dish for ${date}`]
      )
    )
  ).rows[0].id
  await withClient((c) =>
    c.query(
      `insert into recipe_ingredients (household_id, recipe_id, name, amount, unit, aisle, is_staple)
         values ($1,$2,$3,1,null,'Produce',false)`,
      [householdId, recipeId, ingredient]
    )
  )
  expect((await call('POST', '/api/meals/plan', kevin, { date, mealType: 'dinner', recipeId })).statusCode).toBeLessThan(300)
}

const setWeekPref = (pref: 'sunday' | 'monday') =>
  withClient((c) => c.query(`update households set week_start=$2 where id=$1`, [householdId, pref]))

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
  await call('PATCH', '/api/household/modules', kevin, { meals: true })
}, 180_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

// September 2026 is the month the bug was reported on: the 1st is a TUESDAY, so
// `monthStart` is not a week start under either preference.
describe('grocery rebuild — a mid-week date means its week (sunday household)', () => {
  beforeAll(async () => {
    await setWeekPref('sunday')
    await plan('2026-09-01', 'Week1 Ingredient') // Tue → week of Sun Aug 30
  })

  it('stamps rows on the household week start, not the date the caller named', async () => {
    expect((await rebuild('2026-09-01')).statusCode).toBe(200)
    // The week the board actually asks for.
    expect(await names('2026-08-30')).toContain('Week1 Ingredient')
    // ...and nothing orphaned on the mid-week key the caller passed.
    expect(await weekKeys()).not.toContain('2026-09-01')
  })

  it('echoes the snapped week back, so a client can adopt it', async () => {
    expect(JSON.parse((await rebuild('2026-09-01')).body).board.weekStart).toBe('2026-08-30')
    expect((await board('2026-09-01')).weekStart).toBe('2026-08-30')
  })

  it('covers a month only when every week it touches is rebuilt', async () => {
    // A month of Wednesdays, spanning four distinct household weeks.
    await plan('2026-09-09', 'Week2 Ingredient')
    await plan('2026-09-16', 'Week3 Ingredient')
    await plan('2026-09-23', 'Week4 Ingredient')
    // Driven the way a client will: one rebuild per distinct week, named by a date
    // inside it (the server does the snapping).
    for (const d of ['2026-09-01', '2026-09-09', '2026-09-16', '2026-09-23']) {
      expect((await rebuild(d)).statusCode).toBe(200)
    }
    expect(await names('2026-08-30')).toContain('Week1 Ingredient')
    expect(await names('2026-09-06')).toContain('Week2 Ingredient')
    expect(await names('2026-09-13')).toContain('Week3 Ingredient')
    expect(await names('2026-09-20')).toContain('Week4 Ingredient')
    // No week the board never asks for.
    expect(await weekKeys()).toEqual(expect.arrayContaining(['2026-08-30', '2026-09-06', '2026-09-13', '2026-09-20']))
    expect((await weekKeys()).filter((k) => new Date(k + 'T00:00:00Z').getUTCDay() !== 0)).toEqual([])
  })
})

// The snap has to honor the household's first-day-of-week — a monday household's
// Sunday belongs to the PREVIOUS week, and getting that backwards puts the row one
// week away from the board.
describe('grocery rebuild — the snap honors a monday household', () => {
  beforeAll(async () => {
    await setWeekPref('monday')
    await plan('2026-10-14', 'October Ingredient') // Wed → week of Mon Oct 12
  })
  afterAll(() => setWeekPref('sunday'))

  it('snaps back to Monday, not Sunday', async () => {
    expect((await rebuild('2026-10-14')).statusCode).toBe(200)
    expect(await names('2026-10-12')).toContain('October Ingredient')
    // Sunday Oct 11 would be the key for a SUNDAY household — nothing may land there.
    expect(await weekKeys()).not.toContain('2026-10-11')
  })

  it('puts a monday household’s Sunday on the week that is ending', async () => {
    await plan('2026-10-18', 'Sunday Ingredient') // Sun → still the week of Mon Oct 12
    expect((await rebuild('2026-10-18')).statusCode).toBe(200)
    expect(await names('2026-10-12')).toContain('Sunday Ingredient')
    expect(await weekKeys()).not.toContain('2026-10-18')
  })
})
