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
  closePool = (await import('../src/db')).closePool
  const h = await call('POST', '/api/households', kevin, { name: 'Sites', timezone: 'America/Chicago', person: { name: 'Kevin' } })
  kevinId = JSON.parse(h.body).person.id
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
