// Recently-viewed recipes — migration + api. A view is recorded per PERSON (two
// people in a household each get their own history), but the household's combined
// history is also readable, because "what were we cooking last week?" is a family
// question. Shares one Postgres testcontainer + app.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { Client } from 'pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

function mint(sub: string): string {
  return jwt.sign({}, SECRET, {
    algorithm: 'HS256',
    subject: sub,
    issuer: 'waffled-local',
    audience: 'waffled-api',
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
const kelly = mint('dev|kelly')
let kevinId = ''
let kellyId = ''
let householdId = ''
let foreignRecipeId = ''
const recipes: Record<string, string> = {}

async function createRecipe(title: string): Promise<string> {
  const res = await call('POST', '/api/recipes', kevin, { title })
  expect(res.statusCode).toBe(201)
  return JSON.parse(res.body).recipe.id
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
  kevinId = JSON.parse(setup.body).person.id
  householdId = JSON.parse(setup.body).household.id

  await withClient(async (c) => {
    await c.query(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified)
       values ($1,$2,'password','dev|kevin',true)`,
      [householdId, kevinId]
    )
    // A second member of the SAME household, to prove per-person separation.
    kellyId = (
      await c.query<{ id: string }>(
        `insert into persons (household_id, name, member_type) values ($1,'Kelly','adult') returning id`,
        [householdId]
      )
    ).rows[0].id
    await c.query(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified)
       values ($1,$2,'password','dev|kelly',true)`,
      [householdId, kellyId]
    )
    const other = await c.query<{ id: string }>(
      `insert into households (name, timezone) values ('Other','UTC') returning id`
    )
    foreignRecipeId = (
      await c.query<{ id: string }>(
        `insert into recipes (household_id, title) values ($1,'Foreign recipe') returning id`,
        [other.rows[0].id]
      )
    ).rows[0].id
  })

  for (const title of ['Chili', 'Tacos', 'Lasagna', 'Pancakes']) {
    recipes[title] = await createRecipe(title)
  }
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

const titlesOf = (body: string): string[] =>
  (JSON.parse(body).recipes as { title: string }[]).map((r) => r.title)

describe('recipe_views schema', () => {
  it('creates the recipe_views table', async () => {
    const res = await withClient((c) =>
      c.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema='public' and table_name = 'recipe_views'`
      )
    )
    expect(res.rows.map((r) => r.table_name)).toEqual(['recipe_views'])
  })

  // One row per (person, recipe) that moves, rather than an append-only log: the
  // feature is "what did I look at last", so a recipe opened fifty times is still
  // one entry. This is what keeps the table from growing without bound.
  it('keeps exactly one row per person+recipe, bumping the timestamp', async () => {
    await call('POST', `/api/recipes/${recipes.Chili}/view`, kevin)
    const first = await withClient((c) =>
      c.query<{ viewed_at: string }>(
        `select viewed_at from recipe_views where person_id=$1 and recipe_id=$2`,
        [kevinId, recipes.Chili]
      )
    )
    expect(first.rows).toHaveLength(1)

    await call('POST', `/api/recipes/${recipes.Chili}/view`, kevin)
    const second = await withClient((c) =>
      c.query<{ viewed_at: string }>(
        `select viewed_at from recipe_views where person_id=$1 and recipe_id=$2`,
        [kevinId, recipes.Chili]
      )
    )
    expect(second.rows).toHaveLength(1)
    expect(new Date(second.rows[0].viewed_at).getTime()).toBeGreaterThanOrEqual(
      new Date(first.rows[0].viewed_at).getTime()
    )
  })
})

describe('POST /api/recipes/:id/view', () => {
  it('records a view and answers 204', async () => {
    const res = await call('POST', `/api/recipes/${recipes.Tacos}/view`, kevin)
    expect(res.statusCode).toBe(204)
  })

  it('404s for a recipe in another household, recording nothing', async () => {
    const res = await call('POST', `/api/recipes/${foreignRecipeId}/view`, kevin)
    expect(res.statusCode).toBe(404)
    const rows = await withClient((c) =>
      c.query(`select 1 from recipe_views where recipe_id=$1`, [foreignRecipeId])
    )
    expect(rows.rowCount).toBe(0)
  })

  it('404s for an id that is not a uuid', async () => {
    expect((await call('POST', '/api/recipes/not-a-uuid/view', kevin)).statusCode).toBe(404)
  })

  it('401s without a token', async () => {
    expect((await call('POST', `/api/recipes/${recipes.Tacos}/view`)).statusCode).toBe(401)
  })

  // person_id is a NOT NULL FK, and the kiosk/device session resolves its tenant
  // through a lazily-created `kiosk:<personId>` identity rather than a normal login.
  // If that path ever yielded something other than a live persons row, opening a
  // recipe on the iPad would be an FK violation (a 500 on a primary surface), and
  // the route's 404 branch would never run. Both resolver paths join persons today;
  // this pins that.
  it('records a view from a kiosk-style device session', async () => {
    const kioskSub = `kiosk:${kevinId}`
    await withClient((c) =>
      c.query(
        `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified)
         values ($1,$2,'password',$3,true)`,
        [householdId, kevinId, kioskSub]
      )
    )
    const res = await call('POST', `/api/recipes/${recipes.Lasagna}/view`, mint(kioskSub))
    expect(res.statusCode).toBe(204)
  })
})

describe('GET /api/recipes/recent', () => {
  it('returns the caller’s own views, most recent first', async () => {
    // Deterministic order: stamp the rows directly rather than racing the clock.
    await call('POST', `/api/recipes/${recipes.Chili}/view`, kevin)
    await call('POST', `/api/recipes/${recipes.Tacos}/view`, kevin)
    await call('POST', `/api/recipes/${recipes.Lasagna}/view`, kevin)
    await withClient(async (c) => {
      await c.query(`update recipe_views set viewed_at = now() - interval '3 hours' where person_id=$1 and recipe_id=$2`, [kevinId, recipes.Chili])
      await c.query(`update recipe_views set viewed_at = now() - interval '2 hours' where person_id=$1 and recipe_id=$2`, [kevinId, recipes.Tacos])
      await c.query(`update recipe_views set viewed_at = now() - interval '1 hour'  where person_id=$1 and recipe_id=$2`, [kevinId, recipes.Lasagna])
    })

    const res = await call('GET', '/api/recipes/recent', kevin)
    expect(res.statusCode).toBe(200)
    expect(titlesOf(res.body)).toEqual(['Lasagna', 'Tacos', 'Chili'])
  })

  // Two people sharing a kitchen should not see each other's browsing as their own.
  it('keeps each person’s history separate', async () => {
    await call('POST', `/api/recipes/${recipes.Pancakes}/view`, kelly)
    expect(titlesOf((await call('GET', '/api/recipes/recent', kelly)).body)).toEqual(['Pancakes'])
    // Kevin's list is untouched by Kelly's view.
    expect(titlesOf((await call('GET', '/api/recipes/recent', kevin)).body)).not.toContain('Pancakes')
  })

  // "What were we cooking last week?" is a household question, so the same history
  // is readable across everyone — collapsed to one row per recipe at its latest view.
  it('merges every member’s history under scope=household, newest view winning', async () => {
    const titles = titlesOf((await call('GET', '/api/recipes/recent?scope=household', kevin)).body)
    expect(titles[0]).toBe('Pancakes') // Kelly's view is the most recent in the house
    expect(titles).toContain('Lasagna')
    expect(new Set(titles).size).toBe(titles.length) // no recipe listed twice
  })

  it('honours a limit, and caps an absurd one', async () => {
    expect(titlesOf((await call('GET', '/api/recipes/recent?limit=2', kevin)).body).length).toBe(2)
    const capped = await call('GET', '/api/recipes/recent?limit=9999', kevin)
    expect(capped.statusCode).toBe(200)
  })

  it('drops a recipe from the history once it is deleted', async () => {
    const doomed = await createRecipe('Doomed casserole')
    await call('POST', `/api/recipes/${doomed}/view`, kevin)
    expect(titlesOf((await call('GET', '/api/recipes/recent', kevin)).body)).toContain('Doomed casserole')

    expect((await call('DELETE', `/api/recipes/${doomed}`, kevin)).statusCode).toBe(204)
    expect(titlesOf((await call('GET', '/api/recipes/recent', kevin)).body)).not.toContain('Doomed casserole')
  })

  it('401s without a token', async () => {
    expect((await call('GET', '/api/recipes/recent')).statusCode).toBe(401)
  })
})
