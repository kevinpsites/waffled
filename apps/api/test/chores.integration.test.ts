// Chores domain — migration + api. Shares one Postgres testcontainer + app.
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
  return jwt.sign({}, SECRET, {
    algorithm: 'HS256',
    subject: sub,
    issuer: 'nook-local',
    audience: 'nook-api',
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
  return app.run(
    {
      httpMethod: method,
      path,
      headers,
      queryStringParameters: {},
      body: body !== undefined ? JSON.stringify(body) : null,
      isBase64Encoded: false,
    },
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

  const h = await call('POST', '/api/households', kevin, {
    name: 'Sites',
    timezone: 'America/Chicago',
    person: { name: 'Kevin' },
  })
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

describe('chores schema', () => {
  it('creates chores, chore_instances, ledger_entries + the balances view', async () => {
    const tables = await withClient((c) =>
      c.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema='public' and table_name = any($1)`,
        [['chores', 'chore_instances', 'ledger_entries']]
      )
    )
    expect(tables.rows.map((r) => r.table_name).sort()).toEqual([
      'chore_instances',
      'chores',
      'ledger_entries',
    ])
    const view = await withClient((c) =>
      c.query(`select table_name from information_schema.views where table_name='v_person_balances'`)
    )
    expect(view.rowCount).toBe(1)
  })

  it('enforces one instance per chore per day and derives star balances', async () => {
    await withClient(async (c) => {
      const h = await c.query<{ id: string }>(
        `insert into households (name, timezone) values ('C','UTC') returning id`
      )
      const hid = h.rows[0].id
      const p = await c.query<{ id: string }>(
        `insert into persons (household_id, name, member_type) values ($1,'Kid','kid') returning id`,
        [hid]
      )
      const pid = p.rows[0].id
      const ch = await c.query<{ id: string }>(
        `insert into chores (household_id, title, person_id, reward_currency, reward_amount)
         values ($1,'Dishes',$2,'stars',5) returning id`,
        [hid, pid]
      )
      const cid = ch.rows[0].id

      await c.query(
        `insert into chore_instances (household_id, chore_id, person_id, due_on) values ($1,$2,$3,'2026-06-08')`,
        [hid, cid, pid]
      )
      await expect(
        c.query(
          `insert into chore_instances (household_id, chore_id, person_id, due_on) values ($1,$2,$3,'2026-06-08')`,
          [hid, cid, pid]
        )
      ).rejects.toThrow()

      await c.query(
        `insert into ledger_entries (household_id, person_id, currency, amount, reason) values
         ($1,$2,'stars',5,'chore_completed'), ($1,$2,'stars',3,'bonus')`,
        [hid, pid]
      )
      const bal = await c.query<{ balance: string }>(
        `select balance from v_person_balances where person_id=$1 and currency='stars'`,
        [pid]
      )
      expect(Number(bal.rows[0].balance)).toBe(8)
    })
  })
})

describe('chores today api', () => {
  it('403s for a caller with no household', async () => {
    expect((await call('GET', '/api/chores/today', mint('dev|nobody'))).statusCode).toBe(403)
  })

  it('requires a title to create a chore (400)', async () => {
    expect((await call('POST', '/api/chores', kevin, { personId: kevinId })).statusCode).toBe(400)
  })

  it('creates a chore and surfaces it in today (per-person done/total + stars)', async () => {
    const add = await call('POST', '/api/chores', kevin, {
      title: 'Dishes',
      personId: kevinId,
      rewardAmount: 5,
    })
    expect(add.statusCode).toBe(201)

    const res = await call('GET', '/api/chores/today', kevin)
    expect(res.statusCode).toBe(200)
    const me = JSON.parse(res.body).people.find((p: { id: string }) => p.id === kevinId)
    expect(me).toMatchObject({ total: 1, done: 0, stars: 0 })
  })
})

describe('chore completion', () => {
  let instanceId = ''

  async function meStats() {
    const body = JSON.parse((await call('GET', '/api/chores/today', kevin)).body)
    return body.people.find((p: { id: string }) => p.id === kevinId) as { done: number; stars: number }
  }

  beforeAll(async () => {
    await call('POST', '/api/chores', kevin, { title: 'Trash', personId: kevinId, rewardAmount: 5 })
    const list = JSON.parse((await call('GET', '/api/chore-instances/today', kevin)).body)
    instanceId = list.instances.find((i: { choreTitle: string }) => i.choreTitle === 'Trash').id
  })

  it('completes an instance: marks it done and awards stars', async () => {
    const before = await meStats()
    const done = await call('POST', `/api/chore-instances/${instanceId}/complete`, kevin)
    expect(done.statusCode).toBe(200)
    expect(JSON.parse(done.body).instance.status).toBe('done')
    const after = await meStats()
    expect(after.done - before.done).toBe(1)
    expect(after.stars - before.stars).toBe(5)
  })

  it('is idempotent — completing again does not double-award', async () => {
    const before = await meStats()
    await call('POST', `/api/chore-instances/${instanceId}/complete`, kevin)
    const after = await meStats()
    expect(after.stars).toBe(before.stars)
  })

  it('uncompletes: back to pending and stars revoked', async () => {
    const before = await meStats()
    const res = await call('POST', `/api/chore-instances/${instanceId}/uncomplete`, kevin)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).instance.status).toBe('pending')
    const after = await meStats()
    expect(after.done - before.done).toBe(-1)
    expect(after.stars - before.stars).toBe(-5)
  })

  it('404s for an unknown instance', async () => {
    expect(
      (await call('POST', '/api/chore-instances/00000000-0000-0000-0000-000000000000/complete', kevin))
        .statusCode
    ).toBe(404)
  })
})
