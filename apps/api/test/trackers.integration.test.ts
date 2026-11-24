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

describe('trackers api', () => {
  let kid = ''
  let adult = ''

  beforeAll(async () => {
    await withClient(async (c) => {
      for (const [name, type, sub] of [['Kiddo', 'kid', 'dev|kid'], ['Adele', 'adult', 'dev|adele']] as const) {
        const p = await c.query<{ id: string }>(
          `insert into persons (household_id, name, member_type, is_admin) values ($1, $2, $3, false) returning id`,
          [householdId, name, type]
        )
        await c.query(
          `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password',$3,true)`,
          [householdId, p.rows[0].id, sub]
        )
      }
    })
    kid = mint('dev|kid')
    adult = mint('dev|adele')
  })

  it('create then list shows it with lastEntry null', async () => {
    const created = await call('POST', '/api/trackers', kevin, { title: 'Ibuprofen', emoji: '💊', askPerson: true })
    expect(created.statusCode).toBe(201)
    const t = JSON.parse(created.body).tracker
    expect(t).toMatchObject({ title: 'Ibuprofen', emoji: '💊', askPerson: true, archivedAt: null, lastEntry: null })
    const list = JSON.parse((await call('GET', '/api/trackers', kevin)).body).trackers
    expect(list.find((x: { id: string }) => x.id === t.id)).toMatchObject({ lastEntry: null })
  })

  it('rejects a blank title with 400', async () => {
    expect((await call('POST', '/api/trackers', kevin, { title: '   ' })).statusCode).toBe(400)
  })

  it('kid cannot create, patch or delete; a non-admin adult can', async () => {
    const t = JSON.parse((await call('POST', '/api/trackers', kevin, { title: 'Perms' })).body).tracker
    expect((await call('POST', '/api/trackers', kid, { title: 'Nope' })).statusCode).toBe(403)
    expect((await call('PATCH', `/api/trackers/${t.id}`, kid, { title: 'Nope' })).statusCode).toBe(403)
    expect((await call('DELETE', `/api/trackers/${t.id}`, kid)).statusCode).toBe(403)
    expect((await call('GET', '/api/trackers', kid)).statusCode).toBe(200)
    const made = await call('POST', '/api/trackers', adult, { title: 'By adult' })
    expect(made.statusCode).toBe(201)
    const id = JSON.parse(made.body).tracker.id
    expect((await call('PATCH', `/api/trackers/${id}`, adult, { title: 'Renamed' })).statusCode).toBe(200)
    expect((await call('DELETE', `/api/trackers/${id}`, adult)).statusCode).toBe(204)
  })

  it('hides archived trackers unless includeArchived=1', async () => {
    const t = JSON.parse((await call('POST', '/api/trackers', kevin, { title: 'Old one' })).body).tracker
    const patched = await call('PATCH', `/api/trackers/${t.id}`, kevin, { archived: true })
    expect(JSON.parse(patched.body).tracker.archivedAt).toBeTruthy()
    const ids = async (qs: string) =>
      (JSON.parse((await call('GET', `/api/trackers${qs}`, kevin)).body).trackers as { id: string }[]).map((x) => x.id)
    expect(await ids('')).not.toContain(t.id)
    expect(await ids('?includeArchived=1')).toContain(t.id)
    const restored = await call('PATCH', `/api/trackers/${t.id}`, kevin, { archived: false })
    expect(JSON.parse(restored.body).tracker.archivedAt).toBeNull()
  })

  it("404s on another household's tracker id", async () => {
    const id = await withClient(async (c) => {
      const h = await c.query<{ id: string }>(`insert into households (name, timezone) values ('Elsewhere', 'UTC') returning id`)
      const t = await c.query<{ id: string }>(
        `insert into trackers (household_id, title) values ($1, 'Theirs') returning id`,
        [h.rows[0].id]
      )
      return t.rows[0].id
    })
    expect((await call('PATCH', `/api/trackers/${id}`, kevin, { title: 'Mine now' })).statusCode).toBe(404)
    expect((await call('DELETE', `/api/trackers/${id}`, kevin)).statusCode).toBe(404)
  })

  it('returns 403 on every route when the module is off, and recovers after', async () => {
    const set = (v: string) =>
      withClient((c) =>
        c.query(
          `update households set settings = coalesce(settings,'{}'::jsonb)
             || jsonb_build_object('modules', coalesce(settings->'modules','{}'::jsonb) || jsonb_build_object('trackers', $2::boolean))
           where id = $1`,
          [householdId, v]
        )
      )
    await set('false')
    try {
      expect((await call('GET', '/api/trackers', kevin)).statusCode).toBe(403)
      expect((await call('POST', '/api/trackers', kevin, { title: 'x' })).statusCode).toBe(403)
    } finally {
      await set('true')
    }
    expect((await call('GET', '/api/trackers', kevin)).statusCode).toBe(200)
  })
})
