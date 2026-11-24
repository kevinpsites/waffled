// Trackers — schema + api. Shares one Postgres testcontainer + app.
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

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
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

describe('trackers schema', () => {
  it('creates trackers and tracker_entries', async () => {
    const res = await withClient((c) =>
      c.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema = 'public' and table_name in ('trackers','tracker_entries')`
      )
    )
    expect(res.rows.map((r) => r.table_name).sort()).toEqual(['tracker_entries', 'trackers'])
  })

  it('rejects a blank title', async () => {
    await withClient(async (c) => {
      await expect(c.query(`insert into trackers (household_id, title) values ($1, '  ')`, [householdId])).rejects.toThrow(/check constraint/)
    })
  })

  it('rejects an entry whose tracker belongs to another household', async () => {
    await withClient(async (c) => {
      const other = await c.query<{ id: string }>(
        `insert into households (name, timezone) values ('Other', 'UTC') returning id`
      )
      const t = await c.query<{ id: string }>(
        `insert into trackers (household_id, title) values ($1, 'Tylenol') returning id`,
        [householdId]
      )
      await expect(
        c.query(`insert into tracker_entries (household_id, tracker_id) values ($1, $2)`, [other.rows[0].id, t.rows[0].id])
      ).rejects.toThrow()
    })
  })

  it('nulls person_id when the person is deleted, keeping the entry', async () => {
    await withClient(async (c) => {
      const p = await c.query<{ id: string }>(
        `insert into persons (household_id, name, member_type) values ($1, 'Temp', 'adult') returning id`,
        [householdId]
      )
      const t = await c.query<{ id: string }>(
        `insert into trackers (household_id, title) values ($1, 'Water plants') returning id`,
        [householdId]
      )
      const e = await c.query<{ id: string }>(
        `insert into tracker_entries (household_id, tracker_id, person_id) values ($1, $2, $3) returning id`,
        [householdId, t.rows[0].id, p.rows[0].id]
      )
      await c.query(`delete from persons where id = $1`, [p.rows[0].id])
      const after = await c.query<{ person_id: string | null }>(`select person_id from tracker_entries where id = $1`, [e.rows[0].id])
      expect(after.rowCount).toBe(1)
      expect(after.rows[0].person_id).toBeNull()
    })
  })
})
