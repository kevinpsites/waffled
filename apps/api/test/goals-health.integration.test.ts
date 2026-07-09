// Goals — Apple Health sync: health_metric/health_daily_target persistence and the
// /health-sync counting (cumulative for total/count, daily-threshold completions for
// habits, idempotent per person/metric/day). Own Postgres testcontainer + app, mirroring
// goals.integration.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client } from 'pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let kevinId = ''

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
  if (qs) for (const pair of qs.split('&')) {
    const [k, v] = pair.split('=')
    queryStringParameters[k] = decodeURIComponent(v ?? '')
  }
  return app.run(
    { httpMethod: method, path: rawPath, headers, queryStringParameters, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try { return await fn(client) } finally { await client.end() }
}

const kevin = mint('dev|kevin')

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
  const householdId = JSON.parse(setup.body).household.id
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
})

// --- helpers ---------------------------------------------------------------

async function createGoal(extra: Record<string, unknown>): Promise<string> {
  const r = await call('POST', '/api/goals', kevin, { trackingMode: 'shared_total', participantIds: [kevinId], ...extra })
  expect(r.statusCode).toBe(201)
  return JSON.parse(r.body).goal.id
}

async function getGoal(id: string) {
  const r = await call('GET', `/api/goals/${id}`, kevin)
  expect(r.statusCode).toBe(200)
  return JSON.parse(r.body).goal
}

function sync(id: string, day: string, value: number, metric = 'steps') {
  return call('POST', `/api/goals/${id}/health-sync`, kevin, { metric, day, value })
}

// --- tests -----------------------------------------------------------------

describe('goals — Apple Health link persistence', () => {
  it('round-trips health_metric + health_daily_target through create + read', async () => {
    const id = await createGoal({
      title: 'Daily steps', goalType: 'habit', habitPeriod: 'week', habitTargetPerPeriod: 5,
      healthMetric: 'steps', healthDailyTarget: 2000,
    })
    const g = await getGoal(id)
    expect(g.healthMetric).toBe('steps')
    expect(g.healthDailyTarget).toBe(2000)
  })

  it('rejects an unknown metric or a negative daily target on create', async () => {
    expect((await call('POST', '/api/goals', kevin, {
      title: 'X', goalType: 'total', trackingMode: 'shared_total', healthMetric: 'heartbeats',
    })).statusCode).toBe(400)
    expect((await call('POST', '/api/goals', kevin, {
      title: 'X', goalType: 'habit', trackingMode: 'shared_total', healthDailyTarget: -5,
    })).statusCode).toBe(400)
  })

  it('clears the link when healthMetric is patched to null', async () => {
    const id = await createGoal({ title: 'Steps', goalType: 'total', unit: 'steps', targetValue: 100000, healthMetric: 'steps' })
    expect((await call('PATCH', `/api/goals/${id}`, kevin, { healthMetric: null })).statusCode).toBe(200)
    expect((await getGoal(id)).healthMetric).toBeNull()
  })
})

describe('goals — /health-sync counting (total/count)', () => {
  it('accumulates across days and replaces the same day in place (idempotent)', async () => {
    const id = await createGoal({ title: 'Steps this year', goalType: 'total', unit: 'steps', targetValue: 1000000, healthMetric: 'steps' })

    expect((await sync(id, '2026-07-08', 7000)).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(7000)

    // Re-sync the SAME day with a higher total → replaced, not added.
    expect((await sync(id, '2026-07-08', 9000)).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(9000)

    // A different day accumulates.
    expect((await sync(id, '2026-07-09', 5000)).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(14000)
  })

  it('fills two goals linked to the same metric independently', async () => {
    // Guards the contract the iOS client relies on: the day's total must be synced to
    // EACH linked goal separately (a goal in another list still fills), with no
    // cross-contamination between goals.
    const a = await createGoal({ title: 'Steps A', goalType: 'total', unit: 'steps', targetValue: 100000, healthMetric: 'steps' })
    const b = await createGoal({ title: 'Steps B', goalType: 'total', unit: 'steps', targetValue: 100000, healthMetric: 'steps' })

    expect((await sync(a, '2026-07-08', 9000)).statusCode).toBe(200)
    expect((await sync(b, '2026-07-08', 9000)).statusCode).toBe(200)
    expect((await getGoal(a)).totalProgress).toBe(9000)
    expect((await getGoal(b)).totalProgress).toBe(9000)

    // Re-syncing only A leaves B untouched.
    expect((await sync(a, '2026-07-08', 12000)).statusCode).toBe(200)
    expect((await getGoal(a)).totalProgress).toBe(12000)
    expect((await getGoal(b)).totalProgress).toBe(9000)
  })
})

describe('goals — /health-sync counting (habit daily threshold)', () => {
  it('counts one completion only when the day clears the threshold, and undoes a day that later falls short', async () => {
    const id = await createGoal({
      title: '2,000 steps a day', goalType: 'habit', habitPeriod: 'week', habitTargetPerPeriod: 5,
      healthMetric: 'steps', healthDailyTarget: 2000,
    })

    // Below the threshold → recorded (200) but no completion.
    expect((await sync(id, '2026-07-08', 1500)).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(0)

    // Clears the threshold → exactly one completion (amount 1, not the raw 2500).
    expect((await sync(id, '2026-07-08', 2500)).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(1)

    // Re-sync the same day higher → still one completion (idempotent).
    expect((await sync(id, '2026-07-08', 9000)).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(1)

    // Same day drops below the threshold (e.g. a correction) → completion undone.
    expect((await sync(id, '2026-07-08', 500)).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(0)

    // A second qualifying day is its own completion.
    expect((await sync(id, '2026-07-08', 3000)).statusCode).toBe(200)
    expect((await sync(id, '2026-07-09', 3000)).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(2)
  })
})

describe('goals — Apple Health Tier 2 metrics', () => {
  // Rings / mindful / mood join the linkable set. The server stays metric-agnostic —
  // counting is still driven by goal_type — so these prove the new keys are accepted and
  // that the boolean "ring closed / mood logged" case rides the existing habit-threshold
  // path (iOS sends value 1 when met, 0 when not; the daily target is 1).
  it('accepts the new Tier 2 metrics on create and round-trips them', async () => {
    for (const metric of ['move_ring', 'exercise_ring', 'stand_ring', 'rings_all', 'mindful_minutes', 'mood']) {
      const id = await createGoal({
        title: `link ${metric}`, goalType: 'habit', habitPeriod: 'week', habitTargetPerPeriod: 5,
        healthMetric: metric, healthDailyTarget: 1,
      })
      expect((await getGoal(id)).healthMetric).toBe(metric)
    }
  })

  it('counts a ring habit as daily met/not-met — value 1 completes the day, 0 undoes it', async () => {
    const id = await createGoal({
      title: 'Close my Exercise ring', goalType: 'habit', habitPeriod: 'week', habitTargetPerPeriod: 5,
      healthMetric: 'exercise_ring', healthDailyTarget: 1,
    })
    // Ring open → recorded, no completion.
    expect((await sync(id, '2026-07-08', 0, 'exercise_ring')).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(0)
    // Ring closed → exactly one completion.
    expect((await sync(id, '2026-07-08', 1, 'exercise_ring')).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(1)
    // A later correction re-opens the ring → completion undone.
    expect((await sync(id, '2026-07-08', 0, 'exercise_ring')).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(0)
  })

  it('counts mindful minutes as an accumulating total', async () => {
    const id = await createGoal({
      title: 'Mindful minutes', goalType: 'total', unit: 'min', targetValue: 600, healthMetric: 'mindful_minutes',
    })
    expect((await sync(id, '2026-07-08', 10, 'mindful_minutes')).statusCode).toBe(200)
    expect((await sync(id, '2026-07-09', 15, 'mindful_minutes')).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(25)
  })

  it('counts a mood habit — a day with a mood entry (value 1) completes', async () => {
    const id = await createGoal({
      title: 'Log my mood', goalType: 'habit', habitPeriod: 'week', habitTargetPerPeriod: 7,
      healthMetric: 'mood', healthDailyTarget: 1,
    })
    expect((await sync(id, '2026-07-08', 1, 'mood')).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(1)
  })

  // A boolean metric on a COUNT goal ("close my Exercise ring 15× this month") — each met
  // day contributes its raw value of 1, so the count accumulates one per closed day, an open
  // day adds nothing, and a day later corrected to open is replaced in place (drops back out).
  // No habit threshold is involved; this rides the plain total/count accumulation path.
  it('counts ring closures on a count goal — one per closed day, self-correcting', async () => {
    const id = await createGoal({
      title: 'Close my Exercise ring 15×', goalType: 'count', unit: 'days', targetValue: 15,
      healthMetric: 'exercise_ring',
    })
    // Two separate closed days → count 2.
    expect((await sync(id, '2026-07-08', 1, 'exercise_ring')).statusCode).toBe(200)
    expect((await sync(id, '2026-07-09', 1, 'exercise_ring')).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(2)
    // An open day adds nothing.
    expect((await sync(id, '2026-07-10', 0, 'exercise_ring')).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(2)
    // A previously-counted day corrected to open drops back out (replace-in-place).
    expect((await sync(id, '2026-07-08', 0, 'exercise_ring')).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(1)
  })

  it('counts mood entries on a count goal — "log my mood 20 days"', async () => {
    const id = await createGoal({
      title: 'Log my mood 20 days', goalType: 'count', unit: 'days', targetValue: 20, healthMetric: 'mood',
    })
    expect((await sync(id, '2026-07-08', 1, 'mood')).statusCode).toBe(200)
    expect((await sync(id, '2026-07-09', 1, 'mood')).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(2)
  })
})

describe('goals — /health-sync validation', () => {
  let id = ''
  beforeAll(async () => {
    id = await createGoal({ title: 'V', goalType: 'total', unit: 'steps', targetValue: 100, healthMetric: 'steps' })
  })
  it('rejects a bad metric, a malformed day, or a negative value', async () => {
    expect((await call('POST', `/api/goals/${id}/health-sync`, kevin, { metric: 'nope', day: '2026-07-08', value: 1 })).statusCode).toBe(400)
    expect((await call('POST', `/api/goals/${id}/health-sync`, kevin, { metric: 'steps', day: '07/08/2026', value: 1 })).statusCode).toBe(400)
    expect((await call('POST', `/api/goals/${id}/health-sync`, kevin, { metric: 'steps', day: '2026-07-08', value: -1 })).statusCode).toBe(400)
  })
  it('404s an unknown goal', async () => {
    expect((await call('POST', '/api/goals/00000000-0000-0000-0000-000000000000/health-sync', kevin, { metric: 'steps', day: '2026-07-08', value: 1 })).statusCode).toBe(404)
  })
})
