// Goals domain — migration + api. Shares one Postgres testcontainer + app.
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
  householdId = JSON.parse(setup.body).household.id
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

describe('goals schema', () => {
  it('creates goal_lists, goals, goal_participants, goal_logs', async () => {
    const res = await withClient((c) =>
      c.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema='public' and table_name = any($1)`,
        [['goal_lists', 'goals', 'goal_participants', 'goal_logs']]
      )
    )
    expect(res.rows.map((r) => r.table_name).sort()).toEqual([
      'goal_lists',
      'goal_logs',
      'goal_participants',
      'goals',
    ])
  })

  it('derives progress from summed logs and enforces the goal FK', async () => {
    await withClient(async (c) => {
      const h = await c.query<{ id: string }>(`insert into households (name,timezone) values ('G','UTC') returning id`)
      const hid = h.rows[0].id
      const g = await c.query<{ id: string }>(
        `insert into goals (household_id, title, goal_type, tracking_mode, target_value, unit)
         values ($1,'Read books','count','shared_total',20,'books') returning id`,
        [hid]
      )
      const gid = g.rows[0].id
      await c.query(`insert into goal_logs (household_id, goal_id, amount) values ($1,$2,3),($1,$2,2)`, [hid, gid])
      const sum = await c.query<{ total: string }>(
        `select coalesce(sum(amount),0) total from goal_logs where goal_id=$1 and deleted_at is null`,
        [gid]
      )
      expect(Number(sum.rows[0].total)).toBe(5)

      await expect(
        c.query(`insert into goal_logs (household_id, goal_id, amount) values ($1,$2,1)`, [
          hid,
          '00000000-0000-0000-0000-000000000000',
        ])
      ).rejects.toThrow()
    })
  })
})

describe('goals api', () => {
  it('403s for a caller with no household', async () => {
    expect((await call('GET', '/api/goals', mint('dev|nobody'))).statusCode).toBe(403)
  })

  it('validates create input (400)', async () => {
    expect((await call('POST', '/api/goals', kevin, { goalType: 'count', trackingMode: 'shared_total' })).statusCode).toBe(400)
    expect((await call('POST', '/api/goals', kevin, { title: 'X', trackingMode: 'shared_total' })).statusCode).toBe(400)
    expect((await call('POST', '/api/goals', kevin, { title: 'X', goalType: 'count' })).statusCode).toBe(400)
  })

  it('creates a shared goal, logs progress, and derives totals', async () => {
    const add = await call('POST', '/api/goals', kevin, {
      title: 'Read 20 books',
      emoji: '📚',
      category: 'intellectual',
      goalType: 'count',
      unit: 'books',
      targetValue: 20,
      trackingMode: 'shared_total',
      participantIds: [kevinId],
    })
    expect(add.statusCode).toBe(201)
    const id = JSON.parse(add.body).goal.id

    let goal = JSON.parse((await call('GET', '/api/goals', kevin)).body).goals.find((g: { id: string }) => g.id === id)
    expect(goal).toMatchObject({ title: 'Read 20 books', target: 20, totalProgress: 0 })
    expect(goal.participants[0]).toMatchObject({ name: 'Kevin', target: 20, progress: 0 })

    expect((await call('POST', `/api/goals/${id}/log`, kevin, { amount: 3, personId: kevinId })).statusCode).toBe(201)
    expect((await call('POST', `/api/goals/${id}/log`, kevin, { amount: 2, personId: kevinId })).statusCode).toBe(201)

    goal = JSON.parse((await call('GET', '/api/goals', kevin)).body).goals.find((g: { id: string }) => g.id === id)
    expect(goal.totalProgress).toBe(5)
    expect(goal.participants[0].progress).toBe(5)
  })

  it('backdates a log to a chosen local day and rejects a malformed date', async () => {
    const add = await call('POST', '/api/goals', kevin, {
      title: 'Catch up', goalType: 'count', unit: 'days', targetValue: 30,
      trackingMode: 'shared_total', participantIds: [kevinId],
    })
    const id = JSON.parse(add.body).goal.id
    // A YYYY-MM-DD backdate is accepted...
    expect((await call('POST', `/api/goals/${id}/log`, kevin, { amount: 1, personId: kevinId, loggedOn: '2026-06-15' })).statusCode).toBe(201)
    // ...a non-date is rejected.
    expect((await call('POST', `/api/goals/${id}/log`, kevin, { amount: 1, loggedOn: 'yesterday' })).statusCode).toBe(400)
    // The entry lands on the chosen day in the household timezone (America/Chicago).
    await withClient(async (c) => {
      const r = await c.query<{ d: string }>(
        `select (gl.logged_at at time zone h.timezone)::date::text d
           from goal_logs gl join households h on h.id = gl.household_id
          where gl.goal_id = $1 order by gl.created_at desc limit 1`,
        [id]
      )
      expect(r.rows[0].d).toBe('2026-06-15')
    })
  })

  it('rejects a zero/NaN amount and an unknown goal (400/404)', async () => {
    const add = await call('POST', '/api/goals', kevin, { title: 'G', goalType: 'count', trackingMode: 'shared_total', targetValue: 1 })
    const id = JSON.parse(add.body).goal.id
    expect((await call('POST', `/api/goals/${id}/log`, kevin, { amount: 0 })).statusCode).toBe(400)
    expect((await call('POST', `/api/goals/${id}/log`, kevin, { amount: 'lots' })).statusCode).toBe(400)
    expect((await call('POST', '/api/goals/00000000-0000-0000-0000-000000000000/log', kevin, { amount: 1 })).statusCode).toBe(404)
  })

  it('deletes a goal', async () => {
    const add = await call('POST', '/api/goals', kevin, { title: 'Temp', goalType: 'count', trackingMode: 'shared_total', targetValue: 1 })
    const id = JSON.parse(add.body).goal.id
    expect((await call('DELETE', `/api/goals/${id}`, kevin)).statusCode).toBe(204)
    const goals = JSON.parse((await call('GET', '/api/goals', kevin)).body).goals
    expect(goals.some((g: { id: string }) => g.id === id)).toBe(false)
    expect((await call('DELETE', `/api/goals/${id}`, kevin)).statusCode).toBe(404)
  })
})

describe('goal lists + detail', () => {
  it('creates a goal list with members and scopes goals to it', async () => {
    const list = await call('POST', '/api/goal-lists', kevin, { name: 'Family', emoji: '🏡', memberIds: [kevinId] })
    expect(list.statusCode).toBe(201)
    const listId = JSON.parse(list.body).list.id

    const lists = JSON.parse((await call('GET', '/api/goal-lists', kevin)).body).lists
    const fam = lists.find((l: { id: string }) => l.id === listId)
    expect(fam).toMatchObject({ name: 'Family', goalCount: 0 })
    expect(fam.members[0]).toMatchObject({ name: 'Kevin' })

    await call('POST', '/api/goals', kevin, { title: 'In list', goalListId: listId, goalType: 'count', trackingMode: 'shared_total', targetValue: 5 })
    await call('POST', '/api/goals', kevin, { title: 'No list', goalType: 'count', trackingMode: 'shared_total', targetValue: 5 })

    const scoped = JSON.parse((await call('GET', `/api/goals?listId=${listId}`, kevin)).body).goals
    expect(scoped.map((g: { title: string }) => g.title)).toEqual(['In list'])
    expect(JSON.parse((await call('GET', '/api/goal-lists', kevin)).body).lists.find((l: { id: string }) => l.id === listId).goalCount).toBe(1)
  })

  it('returns a goal detail with milestones, recent activity, and totals', async () => {
    const add = await call('POST', '/api/goals', kevin, {
      title: '1,000 Hours Outside', goalType: 'total', unit: 'hours', targetValue: 1000,
      trackingMode: 'shared_total', isFeatured: true, hasRewards: true, participantIds: [kevinId],
      milestones: [
        { threshold: 250, emoji: '🌱', label: '250 hrs', rewardText: '+25 stars' },
        { threshold: 500, emoji: '⛺', label: '500 hrs', rewardText: 'Movie night' },
      ],
    })
    const id = JSON.parse(add.body).goal.id
    await call('POST', `/api/goals/${id}/log`, kevin, { amount: 300, personId: kevinId, note: 'Creek hike' })

    const detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect(detail).toMatchObject({ title: '1,000 Hours Outside', totalProgress: 300, target: 1000, thisWeek: 300 })
    expect(detail.milestones).toHaveLength(2)
    expect(detail.milestones[0]).toMatchObject({ label: '250 hrs', reached: true })
    expect(detail.milestones[1]).toMatchObject({ label: '500 hrs', reached: false })
    expect(detail.recent[0]).toMatchObject({ amount: 300, note: 'Creek hike' })
    expect(detail.recent[0].participants[0]).toMatchObject({ name: 'Kevin' })
    expect(detail.streakDays).toBe(1)
    expect(detail.milestoneReached).toBe(1)

    expect((await call('GET', '/api/goals/00000000-0000-0000-0000-000000000000', kevin)).statusCode).toBe(404)
  })

  it('tags recent entries with a household-timezone dateKey, not the raw UTC date', async () => {
    // Household is America/Chicago (UTC-6 in January, no DST). A log at
    // 2026-01-02T05:30:00Z is 2026-01-01 23:30 local — the household-tz day is
    // Jan 1, but a naive read of the raw UTC timestamp's date would say Jan 2.
    // The goal-detail data views' day drill-down needs this field to match
    // entries against the SAME day bucketing /activity uses, regardless of the
    // viewing device's own timezone.
    const add = await call('POST', '/api/goals', kevin, {
      title: 'Tz check', goalType: 'total', unit: 'hours', targetValue: 100,
      trackingMode: 'shared_total', participantIds: [kevinId],
    })
    const id = JSON.parse(add.body).goal.id
    await withClient((c) =>
      c.query(
        `insert into goal_logs (household_id, goal_id, person_id, amount, note, counts_total, logged_at)
         values ($1,$2,$3,1,'Late one','t','2026-01-02T05:30:00Z')`,
        [householdId, id, kevinId]
      )
    )

    const detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect(detail.recent[0]).toMatchObject({ note: 'Late one', dateKey: '2026-01-01' })

    const activity = JSON.parse((await call('GET', `/api/goals/${id}/activity`, kevin)).body)
    expect(activity.days.find((d: { dateKey: string }) => d.dateKey === '2026-01-01')).toBeTruthy()
  })

  it('logs a time goal in hours and minutes, converting to decimal hours server-side', async () => {
    const add = await call('POST', '/api/goals', kevin, {
      title: '750 Hours Outside', goalType: 'total', unit: 'hours', targetValue: 750,
      trackingMode: 'shared_total', participantIds: [kevinId],
    })
    const id = JSON.parse(add.body).goal.id
    // 2h 10m -> 2 + 10/60; the client no longer has to compute the decimal.
    expect((await call('POST', `/api/goals/${id}/log`, kevin, { hours: 2, minutes: 10, personId: kevinId })).statusCode).toBe(201)
    // 45m alone -> 0.75; hours may be omitted.
    expect((await call('POST', `/api/goals/${id}/log`, kevin, { minutes: 45, personId: kevinId })).statusCode).toBe(201)

    const detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect(detail.totalProgress).toBeCloseTo(2 + 10 / 60 + 0.75, 5)
    expect(detail.recent[0]).toMatchObject({ amount: 0.75 })
  })

  it('rejects hours/minutes when they do not apply, and validates the fields', async () => {
    const timeId = JSON.parse((await call('POST', '/api/goals', kevin, {
      title: 'Hours', goalType: 'total', unit: 'hours', targetValue: 100, trackingMode: 'shared_total', participantIds: [kevinId],
    })).body).goal.id
    const countId = JSON.parse((await call('POST', '/api/goals', kevin, {
      title: 'Books', goalType: 'count', unit: 'books', targetValue: 20, trackingMode: 'shared_total', participantIds: [kevinId],
    })).body).goal.id

    // hours/minutes only make sense for a time goal — a "books" count goal rejects them.
    expect((await call('POST', `/api/goals/${countId}/log`, kevin, { hours: 1, minutes: 0 })).statusCode).toBe(400)
    // Ambiguous: don't accept a decimal amount and hours/minutes together.
    expect((await call('POST', `/api/goals/${timeId}/log`, kevin, { amount: 1, hours: 1 })).statusCode).toBe(400)
    // Zero total time is not a log.
    expect((await call('POST', `/api/goals/${timeId}/log`, kevin, { hours: 0, minutes: 0 })).statusCode).toBe(400)
    // Negative components are invalid.
    expect((await call('POST', `/api/goals/${timeId}/log`, kevin, { minutes: -5 })).statusCode).toBe(400)
    // Minutes is a 0–59 remainder — the server reasserts it even though the UI clamps.
    expect((await call('POST', `/api/goals/${timeId}/log`, kevin, { minutes: 200 })).statusCode).toBe(400)
    // Whole hours + whole minutes only (no fractional components).
    expect((await call('POST', `/api/goals/${timeId}/log`, kevin, { hours: 1.5 })).statusCode).toBe(400)
    // A nonexistent goal still 404s before any hours/minutes math.
    expect((await call('POST', '/api/goals/00000000-0000-0000-0000-000000000000/log', kevin, { hours: 1 })).statusCode).toBe(404)
  })

  it('validates goal-list create input (400)', async () => {
    expect((await call('POST', '/api/goal-lists', kevin, {})).statusCode).toBe(400)
  })

  it('edits a goal (fields + participants + milestones) via PATCH', async () => {
    const add = await call('POST', '/api/goals', kevin, { title: 'Draft', goalType: 'count', trackingMode: 'shared_total', targetValue: 5, participantIds: [kevinId] })
    const id = JSON.parse(add.body).goal.id

    const patched = await call('PATCH', `/api/goals/${id}`, kevin, {
      title: 'Edited goal', targetValue: 12, isFeatured: true,
      milestones: [{ threshold: 6, emoji: '🌱', label: 'half', rewardText: 'treat' }],
    })
    expect(patched.statusCode).toBe(200)
    const detail = JSON.parse(patched.body).goal
    expect(detail).toMatchObject({ title: 'Edited goal', target: 12, isFeatured: true })
    expect(detail.milestones).toHaveLength(1)

    expect((await call('PATCH', '/api/goals/00000000-0000-0000-0000-000000000000', kevin, { title: 'x' })).statusCode).toBe(404)
    expect((await call('PATCH', `/api/goals/${id}`, kevin, { goalType: 'bogus' })).statusCode).toBe(400)
  })

  it('enforces the count whole-number target on PATCH even when goalType is omitted', async () => {
    const add = await call('POST', '/api/goals', kevin, { title: 'Parks', goalType: 'count', trackingMode: 'shared_total', targetValue: 5, participantIds: [kevinId] })
    const id = JSON.parse(add.body).goal.id
    // No goalType in the body: the guard must fall back to the STORED type (count),
    // so a fractional target is still rejected.
    expect((await call('PATCH', `/api/goals/${id}`, kevin, { targetValue: 5.5 })).statusCode).toBe(400)
    // A whole-number target still passes.
    expect((await call('PATCH', `/api/goals/${id}`, kevin, { targetValue: 6 })).statusCode).toBe(200)
  })

  it('logs progress for multiple people at once', async () => {
    const add = await call('POST', '/api/goals', kevin, { title: 'Hours', goalType: 'total', unit: 'hours', targetValue: 100, trackingMode: 'each_tracks', participantIds: [kevinId] })
    const id = JSON.parse(add.body).goal.id
    // a second person to credit
    const kelly = await call('POST', '/api/persons', kevin, { name: 'Kelly', memberType: 'adult' })
    const kellyId = JSON.parse(kelly.body).person.id

    expect((await call('POST', `/api/goals/${id}/log`, kevin, { amount: 2, personIds: [kevinId, kellyId], note: 'Creek hike' })).statusCode).toBe(201)
    const detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect(detail.totalProgress).toBe(4) // 2 each
    expect(detail.recent).toHaveLength(2)
    expect(detail.recent.every((r: { note: string }) => r.note === 'Creek hike')).toBe(true)
  })

  it('splits a shared divisible pool evenly across the people credited', async () => {
    const kelly = await call('POST', '/api/persons', kevin, { name: 'Kelly', memberType: 'adult' })
    const kellyId = JSON.parse(kelly.body).person.id
    const add = await call('POST', '/api/goals', kevin, { title: 'Outside', goalType: 'total', unit: 'hours', targetValue: 1000, trackingMode: 'shared_total', participantMode: 'split', participantIds: [kevinId, kellyId] })
    const id = JSON.parse(add.body).goal.id

    // 2 hours together → +2 to the pool (NOT 4), split 1h each.
    expect((await call('POST', `/api/goals/${id}/log`, kevin, { amount: 2, personIds: [kevinId, kellyId] })).statusCode).toBe(201)
    // Kelly logs 1 more solo hour.
    expect((await call('POST', `/api/goals/${id}/log`, kevin, { amount: 1, personIds: [kellyId] })).statusCode).toBe(201)

    const detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect(detail.totalProgress).toBe(3) // 2 (shared) + 1 (solo)
    const byName = Object.fromEntries(detail.participants.map((p: { name: string; progress: number }) => [p.name, p.progress]))
    expect(byName.Kevin).toBe(1) // his half of the shared session
    expect(byName.Kelly).toBe(2) // half of shared + 1 solo
  })

  it('groups split-log siblings into one activity row (summed amount + participant avatars), keeping raw rows intact', async () => {
    const kelly = await call('POST', '/api/persons', kevin, { name: 'Kelly', memberType: 'adult' })
    const kellyId = JSON.parse(kelly.body).person.id
    const add = await call('POST', '/api/goals', kevin, { title: 'Park hours', goalType: 'total', unit: 'hours', targetValue: 1000, trackingMode: 'shared_total', participantMode: 'split', participantIds: [kevinId, kellyId] })
    const id = JSON.parse(add.body).goal.id

    // 2h together → split 1h + 1h across two rows under one batch.
    expect((await call('POST', `/api/goals/${id}/log`, kevin, { amount: 2, personIds: [kevinId, kellyId], note: 'At the park' })).statusCode).toBe(201)

    const detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    const parkRows = detail.recent.filter((r: { note: string }) => r.note === 'At the park')
    expect(parkRows).toHaveLength(1) // one line, not two
    expect(parkRows[0].amount).toBe(2) // summed back to what was entered
    expect(parkRows[0].participants.map((p: { name: string }) => p.name).sort()).toEqual(['Kelly', 'Kevin'])

    // The underlying per-person rows are still there — source of truth intact.
    const raw = await withClient((c) =>
      c.query<{ n: string }>(`select count(*) n from goal_logs where goal_id=$1 and note='At the park' and deleted_at is null`, [id])
    )
    expect(Number(raw.rows[0].n)).toBe(2)

    // A later solo log is its own action — its own row, not merged into the batch.
    expect((await call('POST', `/api/goals/${id}/log`, kevin, { amount: 1, personIds: [kellyId], note: 'Solo walk' })).statusCode).toBe(201)
    const detail2 = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    const solo = detail2.recent.filter((r: { note: string }) => r.note === 'Solo walk')
    expect(solo).toHaveLength(1)
    expect(solo[0].amount).toBe(1)
    expect(solo[0].participants.map((p: { name: string }) => p.name)).toEqual(['Kelly'])
  })

  it('does not split when a whole-unit shared goal credits the family (one log)', async () => {
    const add = await call('POST', '/api/goals', kevin, { title: 'Parks', goalType: 'count', unit: 'parks', targetValue: 30, trackingMode: 'shared_total', participantIds: [kevinId] })
    const id = JSON.parse(add.body).goal.id
    // The modal sends a single target for whole-unit goals (here: no person = family).
    expect((await call('POST', `/api/goals/${id}/log`, kevin, { amount: 1, personIds: [] })).statusCode).toBe(201)
    const detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect(detail.totalProgress).toBe(1)
    expect(detail.recent).toHaveLength(1)
  })

  it('caps a habit to one completion per day per person', async () => {
    const add = await call('POST', '/api/goals', kevin, { title: 'Read nightly', goalType: 'habit', trackingMode: 'each_tracks', habitPeriod: 'week', habitTargetPerPeriod: 5, participantIds: [kevinId] })
    const id = JSON.parse(add.body).goal.id
    // Log the habit three times today — only the first counts.
    await call('POST', `/api/goals/${id}/log`, kevin, { amount: 1, personIds: [kevinId] })
    await call('POST', `/api/goals/${id}/log`, kevin, { amount: 5, personIds: [kevinId] })
    await call('POST', `/api/goals/${id}/log`, kevin, { amount: 1, personIds: [kevinId] })
    const detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect(detail.totalProgress).toBe(1) // one completion, even with amount=5
    expect(detail.periodDone).toBe(1)
    expect(detail.recent).toHaveLength(1)
  })

  it('checklist goals progress by ticking steps', async () => {
    const add = await call('POST', '/api/goals', kevin, {
      title: 'Lake trip prep', goalType: 'checklist', trackingMode: 'shared_total',
      participantIds: [kevinId], steps: [{ label: 'Book campsite' }, { label: 'Pack gear' }, { label: 'Drive up' }],
    })
    const id = JSON.parse(add.body).goal.id
    let detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect(detail.stepTotal).toBe(3)
    expect(detail.stepDone).toBe(0)
    expect(detail.steps).toHaveLength(3)

    // tick two steps
    const [s1, s2] = detail.steps
    expect((await call('PATCH', `/api/goals/${id}/steps/${s1.id}`, kevin, { done: true })).statusCode).toBe(200)
    expect((await call('PATCH', `/api/goals/${id}/steps/${s2.id}`, kevin, { done: true })).statusCode).toBe(200)
    detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect(detail.stepDone).toBe(2)
    expect(detail.recent).toHaveLength(2) // ticks mirror into the activity feed

    // untick one — progress and activity both drop
    expect((await call('PATCH', `/api/goals/${id}/steps/${s1.id}`, kevin, { done: false })).statusCode).toBe(200)
    detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect(detail.stepDone).toBe(1)
    expect(detail.recent).toHaveLength(1)

    // editing the goal keeps existing step completion (reconcile by id) + adds one
    await call('PATCH', `/api/goals/${id}`, kevin, { steps: [{ id: s1.id, label: 'Book campsite' }, { id: s2.id, label: 'Pack gear' }, { label: 'Buy snacks' }] })
    detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect(detail.stepTotal).toBe(3)
    expect(detail.stepDone).toBe(1) // s2 still done; s1 still unticked; "Drive up" dropped
  })

  it('edits a goal list name and replaces its members', async () => {
    const kelly = await call('POST', '/api/persons', kevin, { name: 'Kelly', memberType: 'adult' })
    const kellyId = JSON.parse(kelly.body).person.id
    const made = await call('POST', '/api/goal-lists', kevin, { name: 'Parents', memberIds: [kevinId] })
    const listId = JSON.parse(made.body).list.id

    const patch = await call('PATCH', `/api/goal-lists/${listId}`, kevin, { name: 'Mom & Dad', memberIds: [kevinId, kellyId] })
    expect(patch.statusCode).toBe(200)

    const lists = JSON.parse((await call('GET', '/api/goal-lists', kevin)).body).lists
    const updated = lists.find((l: { id: string }) => l.id === listId)
    expect(updated.name).toBe('Mom & Dad')
    expect(updated.members.map((m: { personId: string }) => m.personId).sort()).toEqual([kevinId, kellyId].sort())

    expect((await call('PATCH', '/api/goal-lists/00000000-0000-0000-0000-000000000000', kevin, { name: 'X' })).statusCode).toBe(404)
    expect((await call('PATCH', `/api/goal-lists/${listId}`, kevin, { name: '  ' })).statusCode).toBe(400)
  })
})

describe('goal tiers (spotlight / featured)', () => {
  async function newList(name: string): Promise<string> {
    return JSON.parse((await call('POST', '/api/goal-lists', kevin, { name, memberIds: [kevinId] })).body).list.id
  }
  const mk = async (listId: string, title: string, extra: Record<string, unknown> = {}) =>
    JSON.parse((await call('POST', '/api/goals', kevin, {
      title, goalType: 'count', unit: 'x', targetValue: 5, trackingMode: 'shared_total',
      goalListId: listId, participantIds: [kevinId], ...extra,
    })).body).goal.id
  const byId = async (listId: string) => {
    const goals = JSON.parse((await call('GET', `/api/goals?listId=${listId}`, kevin)).body).goals
    return Object.fromEntries(goals.map((g: { id: string }) => [g.id, g]))
  }

  it('exposes isSpotlight and keeps at most one spotlight per list', async () => {
    const list = await newList('Tiers A')
    const a = await mk(list, 'Alpha', { isSpotlight: true })
    let g = await byId(list)
    expect(g[a].isSpotlight).toBe(true)

    // A second spotlight in the SAME list demotes the first to Featured.
    const b = await mk(list, 'Beta', { isSpotlight: true })
    g = await byId(list)
    expect(g[b].isSpotlight).toBe(true)
    expect(g[a].isSpotlight).toBe(false)
    expect(g[a].isFeatured).toBe(true) // demoted, not dropped to normal
  })

  it('PATCH-ing a goal to spotlight demotes the list’s current spotlight', async () => {
    const list = await newList('Tiers B')
    const a = await mk(list, 'Aaa', { isSpotlight: true })
    const b = await mk(list, 'Bbb')
    expect((await call('PATCH', `/api/goals/${b}`, kevin, { isSpotlight: true })).statusCode).toBe(200)
    const g = await byId(list)
    expect(g[b].isSpotlight).toBe(true)
    expect(g[a].isSpotlight).toBe(false)
    expect(g[a].isFeatured).toBe(true)
  })

  it('spotlight is per-list — a spotlight in another list is untouched', async () => {
    const l1 = await newList('Tiers C1'); const l2 = await newList('Tiers C2')
    const a = await mk(l1, 'One', { isSpotlight: true })
    const b = await mk(l2, 'Two', { isSpotlight: true })
    const g1 = await byId(l1); const g2 = await byId(l2)
    expect(g1[a].isSpotlight).toBe(true)
    expect(g2[b].isSpotlight).toBe(true)
  })
})

describe('goal list ordering', () => {
  it('lists goals purely alphabetically by title (case-insensitive) — featured does NOT reorder', async () => {
    const mk = (title: string, isFeatured = false) =>
      call('POST', '/api/goals', kevin, { title, goalType: 'count', unit: 'x', targetValue: 5, trackingMode: 'shared_total', participantIds: [kevinId], isFeatured })
    // ZZ_Bravo is featured, but it still sorts by title — no pinning to the top.
    await mk('ZZ_Zebra'); await mk('ZZ_apple'); await mk('ZZ_Mango'); await mk('ZZ_Bravo', true)
    const goals = JSON.parse((await call('GET', '/api/goals', kevin)).body).goals
    const mine = goals.filter((g: { title: string }) => g.title.startsWith('ZZ_')).map((g: { title: string }) => g.title)
    expect(mine).toEqual(['ZZ_apple', 'ZZ_Bravo', 'ZZ_Mango', 'ZZ_Zebra'])
  })
})

describe('participant counting modes (shared goals)', () => {
  async function newPerson(name: string): Promise<string> {
    const r = await call('POST', '/api/persons', kevin, { name, memberType: 'adult' })
    return JSON.parse(r.body).person.id
  }

  it('rejects an invalid participantMode on create (400) — including the retired credit_each', async () => {
    expect(
      (await call('POST', '/api/goals', kevin, { title: 'X', goalType: 'count', trackingMode: 'shared_total', participantMode: 'bogus' })).statusCode
    ).toBe(400)
    // credit_each was the confusing "family counts once but each gets full credit" mode.
    // It's retired in favour of the four clear types — the API must now reject it.
    expect(
      (await call('POST', '/api/goals', kevin, { title: 'X', goalType: 'total', trackingMode: 'shared_total', participantMode: 'credit_each' })).statusCode
    ).toBe(400)
  })

  it('rejects an invalid targetBasis on create (400)', async () => {
    expect(
      (await call('POST', '/api/goals', kevin, { title: 'X', goalType: 'total', trackingMode: 'each_tracks', targetBasis: 'bogus' })).statusCode
    ).toBe(400)
  })

  it("count_once: a shared event counts +1 no matter how many people attended", async () => {
    const kramerId = await newPerson('Kramer')
    const georgeId = await newPerson('George')
    // Default mode is count_once, but be explicit.
    const add = await call('POST', '/api/goals', kevin, {
      title: 'State parks', goalType: 'count', unit: 'parks', targetValue: 5,
      trackingMode: 'shared_total', participantMode: 'count_once',
      participantIds: [kevinId, kramerId, georgeId],
    })
    const id = JSON.parse(add.body).goal.id

    // One visit, three people present → the goal goes up by ONE, not three.
    expect((await call('POST', `/api/goals/${id}/log`, kevin, { amount: 1, personIds: [kevinId, kramerId, georgeId], note: 'Big Bend' })).statusCode).toBe(201)

    const detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect(detail.totalProgress).toBe(1)
    // Each attendee's personal tally stays 0 — they were present, not multipliers.
    const byName = Object.fromEntries(detail.participants.map((p: { name: string; progress: number }) => [p.name, p.progress]))
    expect(byName.Kevin).toBe(0)
    expect(byName.Kramer).toBe(0)
    expect(byName.George).toBe(0)
    // The activity feed shows a single line for the visit, with all three avatars.
    const visit = detail.recent.filter((r: { note: string }) => r.note === 'Big Bend')
    expect(visit).toHaveLength(1)
    expect(visit[0].amount).toBe(1)
    expect(visit[0].participants.map((p: { name: string }) => p.name).sort()).toEqual(['George', 'Kevin', 'Kramer'])
  })

  it("count_once is the default for a new shared goal", async () => {
    const kramerId = await newPerson('Kramer2')
    const add = await call('POST', '/api/goals', kevin, {
      title: 'Camping trips', goalType: 'count', unit: 'trips', targetValue: 3,
      trackingMode: 'shared_total', participantIds: [kevinId, kramerId],
    })
    const id = JSON.parse(add.body).goal.id
    const goal = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect(goal.participantMode).toBe('count_once')

    expect((await call('POST', `/api/goals/${id}/log`, kevin, { amount: 1, personIds: [kevinId, kramerId] })).statusCode).toBe(201)
    expect(JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal.totalProgress).toBe(1)
  })

  it("#2 'We all chip in' (each_tracks, family target): everyone tapped is credited full and the total sums", async () => {
    // Type #2 — one shared family target, everyone's contributions stack. Jerry + Kramer
    // each spend an hour and both are tapped → each +1 AND the family total goes up by 2.
    const kramerId = await newPerson('Kramer3')
    const add = await call('POST', '/api/goals', kevin, {
      title: 'Family reads 12 (combined)', goalType: 'total', unit: 'books', targetValue: 12,
      trackingMode: 'each_tracks', targetBasis: 'family',
      participantIds: [kevinId, kramerId],
    })
    const id = JSON.parse(add.body).goal.id

    expect((await call('POST', `/api/goals/${id}/log`, kevin, { amount: 1, personIds: [kevinId, kramerId], note: 'Two books' })).statusCode).toBe(201)

    const detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect(detail.targetBasis).toBe('family')
    expect(detail.target).toBe(12) // flat family target — not ×N
    expect(detail.totalProgress).toBe(2) // each person's contribution stacks: 1 + 1
    const byName = Object.fromEntries(detail.participants.map((p: { name: string; progress: number }) => [p.name, p.progress]))
    expect(byName.Kevin).toBe(1)
    expect(byName.Kramer3).toBe(1)
  })

  it("#1 'Everyone individually' (each_tracks, per_person target): per-person tallies sum and the basis round-trips", async () => {
    // Type #1 — each person aims for the full amount on their own (read 12 books EACH).
    // Counting is the same "stacks up" mechanic as #2; the difference is the target basis,
    // which the client multiplies by member count for the ring (12 × 2 = 24 here).
    const kramerId = await newPerson('Kramer4')
    const add = await call('POST', '/api/goals', kevin, {
      title: 'Read 12 books each', goalType: 'count', unit: 'books', targetValue: 12,
      trackingMode: 'each_tracks', targetBasis: 'per_person',
      participantIds: [kevinId, kramerId],
    })
    const id = JSON.parse(add.body).goal.id

    // Kevin reads a book (logged for himself only) → his tally +1, total +1.
    expect((await call('POST', `/api/goals/${id}/log`, kevin, { amount: 1, personIds: [kevinId], note: 'A book' })).statusCode).toBe(201)

    const detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect(detail.targetBasis).toBe('per_person')
    expect(detail.target).toBe(12) // stored per-person target; ring = 12 × members on the client
    expect(detail.totalProgress).toBe(1)
    const byName = Object.fromEntries(detail.participants.map((p: { name: string; progress: number }) => [p.name, p.progress]))
    expect(byName.Kevin).toBe(1)
    expect(byName.Kramer4).toBe(0)
  })

  it("targetBasis defaults to 'family' when omitted", async () => {
    const add = await call('POST', '/api/goals', kevin, {
      title: 'Hours', goalType: 'total', unit: 'hours', targetValue: 750,
      trackingMode: 'shared_total', participantMode: 'split', participantIds: [kevinId],
    })
    const id = JSON.parse(add.body).goal.id
    expect(JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal.targetBasis).toBe('family')
  })
})

describe('goal input validation (hardening)', () => {
  const base = { title: 'V', trackingMode: 'shared_total' as const }

  it('rejects a habitPeriod that is not day/week/month (would break the progress query)', async () => {
    expect((await call('POST', '/api/goals', kevin, { ...base, goalType: 'habit', habitPeriod: 'fortnight', habitTargetPerPeriod: 3 })).statusCode).toBe(400)
    // a valid period is accepted
    expect((await call('POST', '/api/goals', kevin, { ...base, goalType: 'habit', habitPeriod: 'week', habitTargetPerPeriod: 3 })).statusCode).toBe(201)
  })

  it('rejects a non-numeric or fractional target where it makes no sense', async () => {
    expect((await call('POST', '/api/goals', kevin, { ...base, goalType: 'total', targetValue: 'abc' })).statusCode).toBe(400)
    // count goals are whole things — no 5.5 parks
    expect((await call('POST', '/api/goals', kevin, { ...base, goalType: 'count', targetValue: 5.5 })).statusCode).toBe(400)
    expect((await call('POST', '/api/goals', kevin, { ...base, goalType: 'count', targetValue: 5 })).statusCode).toBe(201)
  })

  it('rejects a malformed deadline and a bad milestone threshold', async () => {
    expect((await call('POST', '/api/goals', kevin, { ...base, goalType: 'total', targetValue: 10, deadline: 'someday' })).statusCode).toBe(400)
    expect((await call('POST', '/api/goals', kevin, { ...base, goalType: 'total', targetValue: 10, milestones: [{ threshold: 'lots' }] })).statusCode).toBe(400)
  })

  it('rejects a malformed field on PATCH too', async () => {
    const add = await call('POST', '/api/goals', kevin, { ...base, goalType: 'total', targetValue: 10 })
    const id = JSON.parse(add.body).goal.id
    expect((await call('PATCH', `/api/goals/${id}`, kevin, { deadline: 'nope' })).statusCode).toBe(400)
    expect((await call('PATCH', `/api/goals/${id}`, kevin, { habitPeriod: 'fortnight' })).statusCode).toBe(400)
  })

  it('rejects a fractional /log against a count goal, and an unknown person', async () => {
    const add = await call('POST', '/api/goals', kevin, { ...base, goalType: 'count', unit: 'parks', targetValue: 5, participantIds: [kevinId] })
    const id = JSON.parse(add.body).goal.id
    expect((await call('POST', `/api/goals/${id}/log`, kevin, { amount: 1.5, personId: kevinId })).statusCode).toBe(400)
    expect((await call('POST', `/api/goals/${id}/log`, kevin, { amount: 1, personId: kevinId })).statusCode).toBe(201)
    // a person id that isn't in this household can't be credited
    expect((await call('POST', `/api/goals/${id}/log`, kevin, { amount: 1, personIds: ['11111111-1111-1111-1111-111111111111'] })).statusCode).toBe(400)
  })
})

describe('editing and deleting logged entries', () => {
  async function newPerson(name: string): Promise<string> {
    const r = await call('POST', '/api/persons', kevin, { name, memberType: 'adult' })
    return JSON.parse(r.body).person.id
  }

  it('deletes a logged entry, restoring the total', async () => {
    const add = await call('POST', '/api/goals', kevin, { title: 'Books', goalType: 'count', unit: 'books', targetValue: 20, trackingMode: 'shared_total', participantIds: [kevinId] })
    const id = JSON.parse(add.body).goal.id
    await call('POST', `/api/goals/${id}/log`, kevin, { amount: 3, personId: kevinId })
    await call('POST', `/api/goals/${id}/log`, kevin, { amount: 2, personId: kevinId, note: 'oops' })

    let detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect(detail.totalProgress).toBe(5)
    const oops = detail.recent.find((r: { note: string }) => r.note === 'oops')

    expect((await call('DELETE', `/api/goals/${id}/logs/${oops.id}`, kevin)).statusCode).toBe(200)
    detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect(detail.totalProgress).toBe(3)
    expect(detail.recent.some((r: { note: string }) => r.note === 'oops')).toBe(false)
    // deleting again 404s
    expect((await call('DELETE', `/api/goals/${id}/logs/${oops.id}`, kevin)).statusCode).toBe(404)
  })

  it('deleting a split entry removes the whole batch (both per-person rows)', async () => {
    const kellyId = await newPerson('KellyD')
    const add = await call('POST', '/api/goals', kevin, { title: 'Shared hrs', goalType: 'total', unit: 'hours', targetValue: 100, trackingMode: 'shared_total', participantMode: 'split', participantIds: [kevinId, kellyId] })
    const id = JSON.parse(add.body).goal.id
    await call('POST', `/api/goals/${id}/log`, kevin, { amount: 2, personIds: [kevinId, kellyId], note: 'together' })

    let detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect(detail.totalProgress).toBe(2)
    const entry = detail.recent.find((r: { note: string }) => r.note === 'together')

    expect((await call('DELETE', `/api/goals/${id}/logs/${entry.id}`, kevin)).statusCode).toBe(200)
    detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect(detail.totalProgress).toBe(0)
    const raw = await withClient((c) => c.query<{ n: string }>(`select count(*) n from goal_logs where goal_id=$1 and deleted_at is null`, [id]))
    expect(Number(raw.rows[0].n)).toBe(0)
  })

  it('edits a logged entry amount and note', async () => {
    const add = await call('POST', '/api/goals', kevin, { title: 'Hours', goalType: 'total', unit: 'hours', targetValue: 100, trackingMode: 'shared_total', participantIds: [kevinId] })
    const id = JSON.parse(add.body).goal.id
    await call('POST', `/api/goals/${id}/log`, kevin, { amount: 5, personId: kevinId, note: 'hike' })
    let detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    const entry = detail.recent[0]

    expect((await call('PATCH', `/api/goals/${id}/logs/${entry.id}`, kevin, { amount: 8, note: 'long hike' })).statusCode).toBe(200)
    detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect(detail.totalProgress).toBe(8)
    expect(detail.recent[0]).toMatchObject({ amount: 8, note: 'long hike' })
  })

  it('edits a logged entry’s participants (re-plans who took part)', async () => {
    const pippaId = JSON.parse((await call('POST', '/api/persons', kevin, { name: 'Pippa', memberType: 'adult' })).body).person.id
    const add = await call('POST', '/api/goals', kevin, { title: 'Parks', goalType: 'count', unit: 'parks', targetValue: 5, trackingMode: 'shared_total', participantMode: 'count_once', participantIds: [kevinId, pippaId] })
    const id = JSON.parse(add.body).goal.id
    await call('POST', `/api/goals/${id}/log`, kevin, { amount: 1, personIds: [kevinId, pippaId], note: 'Big Bend' })
    let detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    const entry = detail.recent[0]
    expect(entry.participants.map((p: { name: string }) => p.name).sort()).toEqual(['Kevin', 'Pippa'])

    // Correct "who was there" to Kevin only — the visit still counts once.
    expect((await call('PATCH', `/api/goals/${id}/logs/${entry.id}`, kevin, { personIds: [kevinId] })).statusCode).toBe(200)
    detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect(detail.totalProgress).toBe(1)
    expect(detail.recent[0].participants.map((p: { name: string }) => p.name)).toEqual(['Kevin'])
  })

  it('rejects editing an entry to a person outside the household (400)', async () => {
    const add = await call('POST', '/api/goals', kevin, { title: 'Hours', goalType: 'total', unit: 'hours', targetValue: 100, trackingMode: 'shared_total', participantIds: [kevinId] })
    const id = JSON.parse(add.body).goal.id
    await call('POST', `/api/goals/${id}/log`, kevin, { amount: 5, personId: kevinId })
    const entry = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal.recent[0]
    expect((await call('PATCH', `/api/goals/${id}/logs/${entry.id}`, kevin, { personIds: ['00000000-0000-0000-0000-000000000000'] })).statusCode).toBe(400)
  })

  it('will not edit/delete a derived (checklist-tick) log through this endpoint', async () => {
    const add = await call('POST', '/api/goals', kevin, { title: 'Prep', goalType: 'checklist', trackingMode: 'shared_total', participantIds: [kevinId], steps: [{ label: 'Pack' }] })
    const id = JSON.parse(add.body).goal.id
    const detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    await call('PATCH', `/api/goals/${id}/steps/${detail.steps[0].id}`, kevin, { done: true })
    const withLog = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    const tick = withLog.recent[0]
    // a checklist tick is managed by the step toggle, not the log endpoints
    expect((await call('DELETE', `/api/goals/${id}/logs/${tick.id}`, kevin)).statusCode).toBe(400)
    expect((await call('PATCH', `/api/goals/${id}/logs/${tick.id}`, kevin, { amount: 2 })).statusCode).toBe(400)
  })

  it('404s editing/deleting an unknown entry', async () => {
    const add = await call('POST', '/api/goals', kevin, { title: 'X', goalType: 'count', trackingMode: 'shared_total', targetValue: 5 })
    const id = JSON.parse(add.body).goal.id
    expect((await call('DELETE', `/api/goals/${id}/logs/00000000-0000-0000-0000-000000000000`, kevin)).statusCode).toBe(404)
    expect((await call('PATCH', `/api/goals/${id}/logs/00000000-0000-0000-0000-000000000000`, kevin, { note: 'x' })).statusCode).toBe(404)
  })
})

describe('checklist goals reject numeric progress logs', () => {
  it('a checklist goal is updated by ticking steps, not POST /log (400)', async () => {
    const add = await call('POST', '/api/goals', kevin, {
      title: 'Paint the house', goalType: 'checklist', trackingMode: 'shared_total',
      participantIds: [kevinId], steps: [{ label: 'Kitchen' }, { label: 'Living room' }],
    })
    const id = JSON.parse(add.body).goal.id
    // Logging "1" against a checklist makes no sense — it must go through the step toggle.
    const res = await call('POST', `/api/goals/${id}/log`, kevin, { amount: 1, personId: kevinId })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toMatch(/step/i)
    // Ticking a step still works and drives progress.
    const detail = JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal
    expect((await call('PATCH', `/api/goals/${id}/steps/${detail.steps[0].id}`, kevin, { done: true })).statusCode).toBe(200)
    expect(JSON.parse((await call('GET', `/api/goals/${id}`, kevin)).body).goal.stepDone).toBe(1)
  })
})

// Capture Tier 2 — the 'goal' target (resolve a spoken noun phrase → a goal, then
// `log` progress). Runs in an ISOLATED household so the many reading-ish goals seeded
// by earlier tests don't pollute the candidate lists.
describe('capture — goals target', () => {
  const capToken = mint('dev|capgoals')
  let capHh = ''
  let capPerson = ''
  let otherPerson = ''
  let readCountGoal = ''
  let checklistGoal = ''
  let pianoTimeGoal = ''
  let habitGoal = ''
  let gardenMine = ''
  let gardenOther = ''

  const resolve = (token: string, body: unknown) => call('POST', '/api/capture/resolve', token, body)
  const commit = (token: string, body: unknown) => call('POST', '/api/capture/commit', token, body)
  const goalProgress = async (id: string): Promise<number> =>
    JSON.parse((await call('GET', `/api/goals/${id}`, capToken)).body).goal.totalProgress

  beforeAll(async () => {
    await withClient(async (c) => {
      const h = await c.query<{ id: string }>(
        `insert into households (name, timezone) values ('CapGoals','America/Chicago') returning id`
      )
      capHh = h.rows[0].id
      const p = await c.query<{ id: string }>(
        `insert into persons (household_id, name, member_type, is_admin) values ($1,'Cap','adult',true) returning id`,
        [capHh]
      )
      capPerson = p.rows[0].id
      const o = await c.query<{ id: string }>(
        `insert into persons (household_id, name, member_type, is_admin) values ($1,'Otto','adult',false) returning id`,
        [capHh]
      )
      otherPerson = o.rows[0].id
      await c.query(
        `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|capgoals',true)`,
        [capHh, capPerson]
      )
    })
    const mk = async (body: Record<string, unknown>): Promise<string> => {
      const res = await call('POST', '/api/goals', capToken, body)
      expect(res.statusCode).toBe(201)
      return JSON.parse(res.body).goal.id
    }
    // reading concept: one loggable count goal + one checklist (must be EXCLUDED from `log`).
    readCountGoal = await mk({ title: 'Read books', goalType: 'count', unit: 'books', targetValue: 20, trackingMode: 'shared_total', participantIds: [capPerson] })
    checklistGoal = await mk({ title: 'Reading challenge', goalType: 'checklist', trackingMode: 'shared_total', participantIds: [capPerson], steps: [{ label: 'Pick a book' }] })
    // music concept: a total goal measured in hours → hours/minutes folding.
    pianoTimeGoal = await mk({ title: 'Piano practice', goalType: 'total', unit: 'hours', targetValue: 100, trackingMode: 'shared_total', participantIds: [capPerson] })
    // meditation concept: a habit (each completion counts 1).
    habitGoal = await mk({ title: 'Meditate', goalType: 'habit', trackingMode: 'each_tracks', habitPeriod: 'day', habitTargetPerPeriod: 1, participantIds: [capPerson] })
    // garden concept: two goals, one the speaker is in, one only the other person is —
    // for "my …" participant scoping.
    gardenMine = await mk({ title: 'Garden beds', goalType: 'count', unit: 'beds', targetValue: 10, trackingMode: 'shared_total', participantIds: [capPerson] })
    gardenOther = await mk({ title: 'Garden weeds', goalType: 'count', unit: 'weeds', targetValue: 10, trackingMode: 'shared_total', participantIds: [otherPerson] })
  })

  it('resolves "reading" to the count goal (checklist excluded)', async () => {
    const res = await resolve(capToken, { verb: 'log', targetKind: 'goal', target: { description: 'reading' }, args: {} })
    expect(res.statusCode).toBe(200)
    const { candidates } = JSON.parse(res.body)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].id).toBe(readCountGoal)
    expect(candidates.map((c: { id: string }) => c.id)).not.toContain(checklistGoal)
    // carries the verb extras commit uses
    expect(candidates[0].meta).toMatchObject({ goalType: 'count', unit: 'books' })
  })

  it('scopes "my …" to goals the speaker participates in', async () => {
    const res = await resolve(capToken, { verb: 'log', targetKind: 'goal', target: { description: 'my garden' }, args: {} })
    expect(res.statusCode).toBe(200)
    const { candidates } = JSON.parse(res.body)
    const ids = candidates.map((c: { id: string }) => c.id)
    expect(ids).toContain(gardenMine)
    expect(ids).not.toContain(gardenOther)
    expect(ids).toHaveLength(1)
  })

  it('commits a log on a count goal (amount rounds to a whole number)', async () => {
    const before = await goalProgress(readCountGoal)
    const res = await commit(capToken, { verb: 'log', targetKind: 'goal', targetId: readCountGoal, args: { amount: 2 } })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.message).toMatch(/Read books/)
    expect(await goalProgress(readCountGoal)).toBe(before + 2)
  })

  it('commits a log on a total+time goal, folding minutes to decimal hours', async () => {
    const before = await goalProgress(pianoTimeGoal)
    const res = await commit(capToken, { verb: 'log', targetKind: 'goal', targetId: pianoTimeGoal, args: { minutes: 20 } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).ok).toBe(true)
    expect(await goalProgress(pianoTimeGoal)).toBeCloseTo(before + 20 / 60, 3)
  })

  it('400s a count goal given minutes (same rule as POST /goals/:id/log — no silent 1)', async () => {
    const before = await goalProgress(readCountGoal)
    const res = await commit(capToken, { verb: 'log', targetKind: 'goal', targetId: readCountGoal, args: { minutes: 20 } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toMatch(/time goal/i)
    expect(await goalProgress(readCountGoal)).toBe(before) // nothing logged
  })

  it('logs a bare amount on a time goal as hours (same as the route), not a spurious 400', async () => {
    const before = await goalProgress(pianoTimeGoal)
    const res = await commit(capToken, { verb: 'log', targetKind: 'goal', targetId: pianoTimeGoal, args: { amount: 2 } })
    expect(res.statusCode).toBe(200)
    expect(await goalProgress(pianoTimeGoal)).toBeCloseTo(before + 2, 3)
  })

  it('400s minutes outside 0–59 on a time goal (the route’s fold guard applies here too)', async () => {
    const before = await goalProgress(pianoTimeGoal)
    const res = await commit(capToken, { verb: 'log', targetKind: 'goal', targetId: pianoTimeGoal, args: { minutes: 200 } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toMatch(/minutes 0–59/)
    expect(await goalProgress(pianoTimeGoal)).toBe(before)
  })

  it('commits a log on a habit goal (amount forced to 1)', async () => {
    const res = await commit(capToken, { verb: 'log', targetKind: 'goal', targetId: habitGoal, args: { amount: 5 } })
    expect(res.statusCode).toBe(200)
    expect(await goalProgress(habitGoal)).toBe(1)
  })

  it('rejects a non-log verb', async () => {
    const res = await commit(capToken, { verb: 'delete', targetKind: 'goal', targetId: readCountGoal, args: {} })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toMatch(/goal/i)
  })

  it('returns candidates:[] + disabledReason when Goals is turned off', async () => {
    await withClient((c) =>
      c.query(`update households set settings = coalesce(settings,'{}'::jsonb) || '{"modules":{"goals":false}}'::jsonb where id=$1`, [capHh])
    )
    try {
      const res = await resolve(capToken, { verb: 'log', targetKind: 'goal', target: { description: 'reading' }, args: {} })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.candidates).toEqual([])
      expect(body.disabledReason).toBe('Goals is turned off.')
    } finally {
      await withClient((c) =>
        c.query(`update households set settings = coalesce(settings,'{}'::jsonb) || '{"modules":{"goals":true}}'::jsonb where id=$1`, [capHh])
      )
    }
  })
})
