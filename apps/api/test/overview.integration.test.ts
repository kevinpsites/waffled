// Person + family overview — goal/category/stars rollups against a real PG.
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
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}
interface RunResult { statusCode: number; body: string }
function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const [rawPath, qs] = path.split('?')
  const queryStringParameters: Record<string, string> = {}
  if (qs) for (const pair of qs.split('&')) { const [k, v] = pair.split('='); queryStringParameters[k] = decodeURIComponent(v ?? '') }
  return app.run({ httpMethod: method, path: rawPath, headers, queryStringParameters, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false }, {}) as Promise<RunResult>
}

const kevin = mint('dev|kevin')
let householdId = ''
let kevinId = ''

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try { return await fn(client) } finally { await client.end() }
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
  const body = JSON.parse(setup.body)
  kevinId = body.person.id
  householdId = body.household.id
  // Seed an identity so the legacy mint('dev|kevin') token resolves to the owner.
  await withClient((c) =>
    c.query(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
      [householdId, kevinId]
    )
  )
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('person + family overview', () => {
  beforeAll(async () => {
    const list = await call('POST', '/api/goal-lists', kevin, { name: 'Kevin', emoji: '🐻', memberIds: [kevinId] })
    const listId = JSON.parse(list.body).list.id
    const g = await call('POST', '/api/goals', kevin, {
      goalListId: listId, title: 'Read 20 books', category: 'intellectual',
      goalType: 'count', trackingMode: 'shared_total', targetValue: 20, participantIds: [kevinId],
    })
    const goalId = JSON.parse(g.body).goal.id
    await call('POST', `/api/goals/${goalId}/log`, kevin, { amount: 12, personId: kevinId })
    await withClient((c) =>
      c.query(`insert into ledger_entries (household_id, person_id, currency, amount, reason, created_by) values ($1,$2,'stars',7,'chore_completed',$2)`, [householdId, kevinId])
    )
  })

  it('rolls up a person: goals, category balance, stars, and a local insight', async () => {
    const res = await call('GET', `/api/persons/${kevinId}/overview`, kevin)
    expect(res.statusCode).toBe(200)
    const d = JSON.parse(res.body)
    expect(d.person.name).toBe('Kevin')
    expect(d.activeGoals).toBe(1)
    expect(d.stars).toBe(7)
    const intellectual = d.categoryBalance.find((c: { category: string }) => c.category === 'intellectual')
    expect(intellectual.goalCount).toBe(1)
    expect(intellectual.avgPct).toBe(60) // 12 / 20
    expect(d.insight.lean).toContain('Intellectual')
    expect(d.insight.light.length).toBeGreaterThan(0) // categories with no goals
    expect(d.goals[0].title).toBe('Read 20 books')
    expect(d.recentLedger.length).toBeGreaterThan(0)
  })

  it('404s for an unknown person', async () => {
    expect((await call('GET', '/api/persons/00000000-0000-0000-0000-000000000000/overview', kevin)).statusCode).toBe(404)
  })

  it('rolls up the family: each member with goals + stars', async () => {
    const res = await call('GET', '/api/family/overview', kevin)
    expect(res.statusCode).toBe(200)
    const me = JSON.parse(res.body).people.find((p: { personId: string }) => p.personId === kevinId)
    expect(me).toMatchObject({ activeGoals: 1, stars: 7, avgProgressPct: 60 })
  })
})

describe('person overview · the planning focus is gated on the module', () => {
  it('says nothing while weeklyPlanning is off — which is the default', async () => {
    const d = JSON.parse((await call('GET', `/api/persons/${kevinId}/overview`, kevin)).body)
    expect(d.planningFocus).toBeNull()
  })
})

describe('person overview · this week\'s planning focus', () => {
  // A kid's "one thing this week" is stored only in `planning_session_steps.data.kids`,
  // and it surfaces on their profile — where "what they're working on" already lives.
  // READ here, not copied: the session record stays the one place it is stored.
  const iso = (d: Date) => d.toISOString().slice(0, 10)

  // The whole feature is opt-in, so the profile shows nothing until the module is on.
  beforeAll(async () => {
    await withClient((c) =>
      c.query(
        // NOT jsonb_set with a two-level path: it can only create the LAST level, so with no
        // `settings.modules` object yet it returns the row UNCHANGED and silently.
        `update households
            set settings = coalesce(settings, '{}'::jsonb)
                           || jsonb_build_object('modules',
                                coalesce(settings -> 'modules', '{}'::jsonb)
                                || jsonb_build_object('weeklyPlanning', true))
          where id = $1`,
        [householdId]
      )
    )
  })

  async function sessionFor(weekStart: string, answers: unknown) {
    return withClient(async (c) => {
      const s = await c.query<{ id: string }>(
        `insert into planning_sessions (household_id, week_start, status, driver_person_id)
           values ($1, $2::date, 'active', $3) returning id`,
        [householdId, weekStart, kevinId]
      )
      await c.query(
        `insert into planning_session_steps (session_id, step_key, status, data)
           values ($1, 'kids', 'done', jsonb_build_object('kids', $2::jsonb))`,
        [s.rows[0].id, JSON.stringify(answers)]
      )
      return s.rows[0].id
    })
  }

  const focus = (label: string) => ({
    [kevinId]: { focus: { source: 'goal', id: null, emoji: '📚', label, detail: '3 of 20 books' }, forward: null },
  })

  it('reports nothing when no session has asked', async () => {
    const d = JSON.parse((await call('GET', `/api/persons/${kevinId}/overview`, kevin)).body)
    expect(d.planningFocus).toBeNull()
  })

  it('surfaces the focus from the session covering TODAY', async () => {
    // The week we are actually in — not the week a session was planning. A session run on
    // Sunday plans the week ahead, so by Wednesday the focus is the session whose week
    // contains today.
    const today = new Date()
    const start = new Date(today)
    start.setDate(start.getDate() - start.getDay()) // this household starts weeks on Sunday
    await sessionFor(iso(start), focus('Read 20 minutes a day'))

    const d = JSON.parse((await call('GET', `/api/persons/${kevinId}/overview`, kevin)).body)
    expect(d.planningFocus).toMatchObject({ label: 'Read 20 minutes a day', emoji: '📚', detail: '3 of 20 books' })
  })

  it('ignores a focus from a week that has already passed', async () => {
    // Showing last week's one thing would have the profile disagreeing with the Kids step.
    const old = new Date()
    old.setDate(old.getDate() - 28)
    old.setDate(old.getDate() - old.getDay())
    await sessionFor(iso(old), focus('Something from a month ago'))

    const d = JSON.parse((await call('GET', `/api/persons/${kevinId}/overview`, kevin)).body)
    expect(d.planningFocus?.label).not.toBe('Something from a month ago')
  })

  it('reports nothing for a person nobody answered for', async () => {
    const other = await withClient((c) =>
      c.query<{ id: string }>(
        `insert into persons (household_id, name, member_type) values ($1, 'Nobody', 'kid') returning id`,
        [householdId]
      ).then((r) => r.rows[0].id)
    )
    const d = JSON.parse((await call('GET', `/api/persons/${other}/overview`, kevin)).body)
    expect(d.planningFocus).toBeNull()
  })
})
