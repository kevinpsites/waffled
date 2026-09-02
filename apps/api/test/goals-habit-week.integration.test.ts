// A habit's period follows the HOUSEHOLD's week — `households.week_start` (sunday |
// monday), the same rule the grocery board and the meal planner use — not Postgres's
// `date_trunc('week')`, which is always Monday. The default household is a *sunday* one,
// so the old behavior misaligned the habit week for almost everyone: Sunday's completion
// counted toward the week that was ending rather than the one just beginning.
//
// The dates here are computed from today, not hardcoded, so the assertions hold whichever
// day the suite runs on.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { Client } from 'pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'
const TZ = 'America/Chicago'

let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let householdId = ''

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}

interface RunResult {
  statusCode: number
  body: string
}

function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}

const kevin = mint('dev|kevin')

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

// ── date helpers: the household's "today", and the week it belongs to ──────────────
const todayLocal = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// Mirrors snapToWeekStart in lists.service.ts — the one week rule.
function snap(iso: string, firstDay: 'sunday' | 'monday'): string {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay() // 0=Sun..6=Sat
  return addDays(iso, -(firstDay === 'monday' ? (dow === 0 ? 6 : dow - 1) : dow))
}

async function setWeekStart(firstDay: 'sunday' | 'monday') {
  await withClient((c) => c.query(`update households set week_start=$1 where id=$2`, [firstDay, householdId]))
}

async function newHabit(title: string, period = 'week'): Promise<string> {
  const add = await call('POST', '/api/goals', kevin, {
    title,
    goalType: 'habit',
    trackingMode: 'shared_total',
    participantMode: 'count_once',
    habitPeriod: period,
    habitTargetPerPeriod: 5,
    targetValue: 5,
  })
  expect(add.statusCode).toBe(201)
  return JSON.parse(add.body).goal.id
}

async function markDone(goalId: string, loggedOn: string) {
  const res = await call('POST', `/api/goals/${goalId}/log`, kevin, { amount: 1, loggedOn })
  expect(res.statusCode).toBe(201)
}

async function readGoal(goalId: string) {
  const res = await call('GET', '/api/goals', kevin)
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.body).goals.find((g: { id: string }) => g.id === goalId)
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
    household: { name: 'Sites', timezone: TZ },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  const body = JSON.parse(setup.body)
  householdId = body.household.id
  await withClient((c) =>
    c.query(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
      [householdId, body.person.id]
    )
  )
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe("a habit's week follows the household's week_start", () => {
  it('a sunday household counts from Sunday, not from Monday', async () => {
    await setWeekStart('sunday')
    const weekStart = snap(todayLocal(), 'sunday') // the Sunday this week began on
    const goalId = await newHabit('Move every day')

    await markDone(goalId, weekStart) // first day of THIS week — counts
    await markDone(goalId, addDays(weekStart, -1)) // the Saturday before — last week

    // Only the Sunday counts. Postgres's Monday-based week would either drop both
    // (mid-week) or count both (on a Sunday) — never exactly this.
    expect((await readGoal(goalId)).periodDone).toBe(1)
  })

  it("the goal detail's this-week total uses the same boundary", async () => {
    await setWeekStart('sunday')
    const weekStart = snap(todayLocal(), 'sunday')
    const goalId = await newHabit('Stretch')

    await markDone(goalId, weekStart)
    await markDone(goalId, addDays(weekStart, -1))

    const detail = JSON.parse((await call('GET', `/api/goals/${goalId}`, kevin)).body).goal
    expect(detail.periodDone).toBe(1)
    expect(detail.thisWeek).toBe(1) // one completion since Sunday, not two
  })

  it('a monday household counts from Monday', async () => {
    await setWeekStart('monday')
    const weekStart = snap(todayLocal(), 'monday')
    const goalId = await newHabit('Read a chapter')

    await markDone(goalId, weekStart) // Monday — counts
    await markDone(goalId, addDays(weekStart, -1)) // the Sunday that closed last week

    expect((await readGoal(goalId)).periodDone).toBe(1)
  })

  it('switching the household week re-reads the same logs', async () => {
    // One goal, one pair of logs, two answers — the boundary is read live, never
    // stamped onto the rows, so changing the setting fixes history too.
    await setWeekStart('monday')
    const mondayStart = snap(todayLocal(), 'monday')
    const goalId = await newHabit('Walk the dog')

    // Monday plus the Sunday before it: one week under monday, two under sunday
    // (that Sunday is the day the sunday-week began).
    await markDone(goalId, mondayStart)
    await markDone(goalId, addDays(mondayStart, -1))
    expect((await readGoal(goalId)).periodDone).toBe(1)

    await setWeekStart('sunday')
    expect((await readGoal(goalId)).periodDone).toBe(2)
  })

  it('day and month habits are untouched by the week setting', async () => {
    await setWeekStart('monday')
    const today = todayLocal()

    const daily = await newHabit('Vitamins', 'day')
    await markDone(daily, today)
    await markDone(daily, addDays(today, -1)) // yesterday is a different period
    expect((await readGoal(daily)).periodDone).toBe(1)

    const monthly = await newHabit('Deep clean', 'month')
    const firstOfMonth = `${today.slice(0, 7)}-01`
    await markDone(monthly, firstOfMonth)
    await markDone(monthly, addDays(firstOfMonth, -1)) // last month
    expect((await readGoal(monthly)).periodDone).toBe(1)
  })
})
