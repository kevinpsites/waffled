// Calendar (Nook-native events) — migration + api. Shares one PG container + app.
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

describe('events schema', () => {
  it('creates the events table', async () => {
    const res = await withClient((c) =>
      c.query(`select table_name from information_schema.tables where table_name='events'`)
    )
    expect(res.rowCount).toBe(1)
  })

  it('requires title/starts_at/timezone and links a person', async () => {
    await withClient(async (c) => {
      const h = await c.query<{ id: string }>(
        `insert into households (name, timezone) values ('E','UTC') returning id`
      )
      const hid = h.rows[0].id
      const p = await c.query<{ id: string }>(
        `insert into persons (household_id, name, member_type) values ($1,'Kid','kid') returning id`,
        [hid]
      )
      const ok = await c.query<{ id: string; origin: string; sync_state: string }>(
        `insert into events (household_id, title, starts_at, timezone, person_id)
         values ($1,'Swim','2026-06-08T13:30:00Z','UTC',$2) returning id, origin, sync_state`,
        [hid, p.rows[0].id]
      )
      expect(ok.rows[0].origin).toBe('manual')
      expect(ok.rows[0].sync_state).toBe('local_only')

      await expect(
        c.query(`insert into events (household_id, starts_at, timezone) values ($1, now(), 'UTC')`, [hid])
      ).rejects.toThrow() // missing title (not null)
    })
  })
})
