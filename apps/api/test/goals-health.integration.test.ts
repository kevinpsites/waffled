// Goals — Apple Health sync: health_metric/health_daily_target persistence and the
// /health-sync counting (cumulative for total/count, daily-threshold completions for
// habits, idempotent per person/metric/day). Own Postgres testcontainer + app, mirroring
// goals.integration.test.ts.
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

describe('goals — /health-sync counting (fractional distance, Tier 1)', () => {
  it('accumulates and replaces fractional walk/run distance without truncating', async () => {
    // Distance (miles/km) is the first *fractional* health metric — steps/flights/minutes
    // are all whole numbers. This guards that the numeric columns + sync path keep the
    // decimals (a naive Int cast would collapse 3.2 mi to 3).
    const id = await createGoal({
      title: 'Marathon training miles', goalType: 'total', unit: 'mi', targetValue: 100,
      healthMetric: 'walk_run_distance',
    })

    expect((await sync(id, '2026-07-08', 3.2, 'walk_run_distance')).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBeCloseTo(3.2, 5)

    // Same day re-syncs in place (idempotent), not appended.
    expect((await sync(id, '2026-07-08', 4.6, 'walk_run_distance')).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBeCloseTo(4.6, 5)

    // A new day accumulates the fractional totals.
    expect((await sync(id, '2026-07-09', 5.15, 'walk_run_distance')).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBeCloseTo(9.75, 5)
  })

  it('counts a distance habit day only when it clears a fractional daily target', async () => {
    const id = await createGoal({
      title: '3 miles a day', goalType: 'habit', habitPeriod: 'week', habitTargetPerPeriod: 5,
      healthMetric: 'walk_run_distance', healthDailyTarget: 3,
    })

    // Under 3 mi → recorded, no completion.
    expect((await sync(id, '2026-07-08', 2.5, 'walk_run_distance')).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(0)

    // Clears 3 mi → exactly one completion.
    expect((await sync(id, '2026-07-08', 3.4, 'walk_run_distance')).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(1)
  })
})

describe('goals — activity-specific distance metrics (Tier 2, slice 1)', () => {
  // Cycling / swimming / wheelchair distance ride the exact fractional path walk/run
  // distance proved out — the server only needs to accept the keys.
  it.each(['cycling_distance', 'swimming_distance', 'wheelchair_distance'])(
    'accepts %s on create and syncs fractional totals',
    async (metric) => {
      const id = await createGoal({
        title: `Distance via ${metric}`, goalType: 'total', unit: 'mi', targetValue: 50,
        healthMetric: metric,
      })
      expect((await getGoal(id)).healthMetric).toBe(metric)

      expect((await sync(id, '2026-07-08', 6.3, metric)).statusCode).toBe(200)
      expect((await getGoal(id)).totalProgress).toBeCloseTo(6.3, 5)
      // Same-day re-sync replaces in place; a new day accumulates.
      expect((await sync(id, '2026-07-08', 7.1, metric)).statusCode).toBe(200)
      expect((await sync(id, '2026-07-09', 2.4, metric)).statusCode).toBe(200)
      expect((await getGoal(id)).totalProgress).toBeCloseTo(9.5, 5)
    }
  )
})

describe('goals — workout-type metrics (Tier 2, slice 2)', () => {
  // Per-activity workout metrics: the measure is baked into the key (minutes vs
  // sessions), so the server needs no workout-specific logic — minutes accumulate
  // like exercise minutes, sessions accumulate like a count, habits threshold.
  it('accumulates workout minutes on a total goal', async () => {
    const id = await createGoal({
      title: 'Yoga hours', goalType: 'total', unit: 'min', targetValue: 1000,
      healthMetric: 'workout_yoga_minutes',
    })
    expect((await sync(id, '2026-07-08', 35, 'workout_yoga_minutes')).statusCode).toBe(200)
    expect((await sync(id, '2026-07-09', 20, 'workout_yoga_minutes')).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(55)
  })

  it('accumulates workout sessions on a count goal', async () => {
    const id = await createGoal({
      title: 'Swim 12 times', goalType: 'count', unit: 'swims', targetValue: 12,
      healthMetric: 'workout_swimming_sessions',
    })
    expect((await sync(id, '2026-07-08', 2, 'workout_swimming_sessions')).statusCode).toBe(200)
    expect((await sync(id, '2026-07-09', 1, 'workout_swimming_sessions')).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(3)
  })

  it('counts an any-workout habit day only when a session exists', async () => {
    const id = await createGoal({
      title: 'Move every day', goalType: 'habit', habitPeriod: 'week', habitTargetPerPeriod: 5,
      healthMetric: 'workout_any_sessions', healthDailyTarget: 1,
    })
    expect((await sync(id, '2026-07-08', 0, 'workout_any_sessions')).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(0)
    expect((await sync(id, '2026-07-08', 1, 'workout_any_sessions')).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(1)
  })

  it('accepts every workout activity × measure key on create', async () => {
    for (const activity of ['running', 'cycling', 'swimming', 'yoga', 'strength', 'any']) {
      for (const [measure, goalType, extra] of [
        ['minutes', 'total', { unit: 'min', targetValue: 100 }],
        ['sessions', 'count', { unit: 'times', targetValue: 10 }],
      ] as const) {
        const metric = `workout_${activity}_${measure}`
        const id = await createGoal({ title: metric, goalType, healthMetric: metric, ...extra })
        expect((await getGoal(id)).healthMetric).toBe(metric)
      }
    }
  })
})

describe('goals — health metric ↔ goal-type pairing (review hardening)', () => {
  // The clients only offer fitting pairs; the server must reject the rest, or an
  // unfitting link round-trips into iOS as activeHealthMetric == nil and a later
  // unrelated edit silently null-patches the link away.
  it('rejects a measure that does not fit the goal type, on create and patch', async () => {
    // A total sums — session counts don't fit it.
    expect((await call('POST', '/api/goals', kevin, {
      title: 'X', goalType: 'total', trackingMode: 'shared_total', unit: 'times', targetValue: 10,
      healthMetric: 'workout_running_sessions',
    })).statusCode).toBe(400)
    // A count counts — minute sums don't fit it.
    expect((await call('POST', '/api/goals', kevin, {
      title: 'X', goalType: 'count', trackingMode: 'shared_total', unit: 'min', targetValue: 100,
      healthMetric: 'workout_yoga_minutes',
    })).statusCode).toBe(400)
    // Booleans (rings/mood) have nothing to sum — never a total (pre-existing gap, now closed).
    expect((await call('POST', '/api/goals', kevin, {
      title: 'X', goalType: 'total', trackingMode: 'shared_total', unit: 'days', targetValue: 20,
      healthMetric: 'rings_all',
    })).statusCode).toBe(400)

    const id = await createGoal({ title: 'Minutes', goalType: 'total', unit: 'min', targetValue: 100 })
    expect((await call('PATCH', `/api/goals/${id}`, kevin, { healthMetric: 'workout_running_sessions' })).statusCode).toBe(400)
    expect((await call('PATCH', `/api/goals/${id}`, kevin, { healthMetric: 'workout_running_minutes' })).statusCode).toBe(200)
  })
})

describe('goals — re-linking clears the old metric’s auto progress (review fix)', () => {
  it('does not double-count a day when a habit flips to its sibling measure', async () => {
    // Same yoga workout feeds both sibling keys, so the flip would double-count
    // every qualified day if the old key’s logs survived.
    const id = await createGoal({
      title: 'Yoga habit', goalType: 'habit', habitPeriod: 'week', habitTargetPerPeriod: 5,
      healthMetric: 'workout_yoga_minutes', healthDailyTarget: 30,
    })
    expect((await sync(id, '2026-07-08', 45, 'workout_yoga_minutes')).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(1)

    // One-tap qualification flip: "at least 30 min" → "any workout counts".
    expect((await call('PATCH', `/api/goals/${id}`, kevin, {
      healthMetric: 'workout_yoga_sessions', healthDailyTarget: 1,
    })).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(0)   // old-key day cleared

    expect((await sync(id, '2026-07-08', 1, 'workout_yoga_sessions')).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(1)   // same real day counts once
  })

  it('keeps auto progress on unlink, and re-linking the same metric stays idempotent', async () => {
    const id = await createGoal({ title: 'Steps', goalType: 'total', unit: 'steps', targetValue: 100000, healthMetric: 'steps' })
    expect((await sync(id, '2026-07-08', 7000, 'steps')).statusCode).toBe(200)

    // Unlink: the steps already walked stay on the goal.
    expect((await call('PATCH', `/api/goals/${id}`, kevin, { healthMetric: null })).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(7000)

    // Re-link the SAME metric: the old day replaces in place, never doubles.
    expect((await call('PATCH', `/api/goals/${id}`, kevin, { healthMetric: 'steps' })).statusCode).toBe(200)
    expect((await sync(id, '2026-07-08', 7500, 'steps')).statusCode).toBe(200)
    expect((await getGoal(id)).totalProgress).toBe(7500)
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
