// Goals domain — migration + api. Shares one Postgres testcontainer + app.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client } from 'pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'nook-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let kevinId = ''

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'nook-local', audience: 'nook-api', expiresIn: '1h' })
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
    expect(detail.recent[0]).toMatchObject({ amount: 300, note: 'Creek hike', name: 'Kevin' })
    expect(detail.streakDays).toBe(1)
    expect(detail.milestoneReached).toBe(1)

    expect((await call('GET', '/api/goals/00000000-0000-0000-0000-000000000000', kevin)).statusCode).toBe(404)
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
    const add = await call('POST', '/api/goals', kevin, { title: 'Outside', goalType: 'total', unit: 'hours', targetValue: 1000, trackingMode: 'shared_total', participantIds: [kevinId, kellyId] })
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
