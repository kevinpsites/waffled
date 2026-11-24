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

describe('tracker entries api', () => {
  const kid = mint('dev|kid')
  let kidId = ''

  const mk = async (body: Record<string, unknown>): Promise<string> =>
    JSON.parse((await call('POST', '/api/trackers', kevin, body)).body).tracker.id
  const log = (trackerId: string, body: Record<string, unknown> = {}, token = kevin) =>
    call('POST', `/api/trackers/${trackerId}/entries`, token, body)
  const trackerOf = async (id: string) =>
    (JSON.parse((await call('GET', '/api/trackers', kevin)).body).trackers as { id: string; lastEntry: Record<string, unknown> | null }[]).find(
      (t) => t.id === id
    )!

  beforeAll(async () => {
    kidId = await withClient(async (c) => (await c.query<{ id: string }>(`select id from persons where household_id = $1 and name = 'Kiddo'`, [householdId])).rows[0].id)
  })

  it('log without person on a plain tracker: 201, lastEntry updates', async () => {
    const id = await mk({ title: 'Vitamin D' })
    const res = await log(id, { note: 'with breakfast' })
    expect(res.statusCode).toBe(201)
    const entry = JSON.parse(res.body).entry
    expect(entry).toMatchObject({ trackerId: id, personId: null, personName: null, loggedBy: kevinId, loggedByName: 'Kevin', note: 'with breakfast' })
    expect((await trackerOf(id)).lastEntry).toMatchObject({ id: entry.id, occurredAt: entry.occurredAt })
  })

  it('askPerson tracker: no personId is 422 PersonRequired; with personId is 201 and lastEntry.personName', async () => {
    const id = await mk({ title: 'Tylenol', askPerson: true })
    const missing = await log(id)
    expect(missing.statusCode).toBe(422)
    expect(JSON.parse(missing.body).error).toBe('PersonRequired')
    expect((await log(id, { personId: kidId })).statusCode).toBe(201)
    const last = (await trackerOf(id)).lastEntry
    expect(last).toMatchObject({ personId: kidId, personName: 'Kiddo' })
    expect(typeof last!.occurredAt).toBe('string')
  })

  it('personId from another household is 400', async () => {
    const id = await mk({ title: 'Cross' })
    const foreign = await withClient(async (c) => {
      const h = await c.query<{ id: string }>(`insert into households (name, timezone) values ('Foreign', 'UTC') returning id`)
      const p = await c.query<{ id: string }>(
        `insert into persons (household_id, name, member_type) values ($1, 'Stranger', 'adult') returning id`,
        [h.rows[0].id]
      )
      return p.rows[0].id
    })
    expect((await log(id, { personId: foreign })).statusCode).toBe(400)
    expect((await log(id, { personId: 'not-a-uuid' })).statusCode).toBe(400)
  })

  it('archived tracker is 409 Archived', async () => {
    const id = await mk({ title: 'Retired' })
    await call('PATCH', `/api/trackers/${id}`, kevin, { archived: true })
    const res = await log(id)
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toBe('Archived')
  })

  it('occurredAt in the future is 400 beyond 5 minutes of skew', async () => {
    const id = await mk({ title: 'Future' })
    const far = new Date(Date.now() + 60 * 60_000).toISOString()
    const near = new Date(Date.now() + 2 * 60_000).toISOString()
    expect((await log(id, { occurredAt: far })).statusCode).toBe(400)
    expect((await log(id, { occurredAt: near })).statusCode).toBe(201)
    expect((await log(id, { occurredAt: 'garbage' })).statusCode).toBe(400)
  })

  it('history: newest first, personId filter, before/limit paging with nextBefore', async () => {
    const id = await mk({ title: 'History' })
    const base = Date.now() - 10 * 60_000
    const stamps = [0, 1, 2, 3, 4].map((i) => new Date(base + i * 60_000).toISOString())
    for (let i = 0; i < stamps.length; i++) {
      expect((await log(id, { occurredAt: stamps[i], personId: i % 2 === 0 ? kidId : undefined })).statusCode).toBe(201)
    }
    const list = async (qs: string) => JSON.parse((await call('GET', `/api/trackers/${id}/entries${qs}`, kevin)).body)
    const all = await list('')
    expect(all.entries.map((e: { occurredAt: string }) => e.occurredAt)).toEqual([...stamps].reverse())
    expect(all.nextBefore).toBeNull()

    const p1 = await list('?limit=2')
    expect(p1.entries).toHaveLength(2)
    expect(p1.nextBefore).toBeTruthy()
    const p2 = await list(`?limit=2&before=${encodeURIComponent(p1.nextBefore)}`)
    expect(p2.entries.map((e: { occurredAt: string }) => e.occurredAt)).toEqual([stamps[2], stamps[1]])
    const p3 = await list(`?limit=2&before=${encodeURIComponent(p2.nextBefore)}`)
    expect(p3.entries.map((e: { occurredAt: string }) => e.occurredAt)).toEqual([stamps[0]])
    expect(p3.nextBefore).toBeNull()

    const mine = await list(`?personId=${kidId}`)
    expect(mine.entries).toHaveLength(3)
    expect(mine.entries.every((e: { personId: string }) => e.personId === kidId)).toBe(true)
  })

  it('paging is stable across entries with identical occurredAt', async () => {
    const id = await mk({ title: 'Ties' })
    const at = new Date(Date.now() - 60_000).toISOString()
    for (let i = 0; i < 3; i++) await log(id, { occurredAt: at })
    const seen: string[] = []
    let before = ''
    for (let guard = 0; guard < 5; guard++) {
      const page = JSON.parse((await call('GET', `/api/trackers/${id}/entries?limit=1${before}`, kevin)).body)
      seen.push(...page.entries.map((e: { id: string }) => e.id))
      if (!page.nextBefore) break
      before = `&before=${encodeURIComponent(page.nextBefore)}`
    }
    expect(new Set(seen).size).toBe(3)
  })

  it('kid can log, edit time, and delete', async () => {
    const id = await mk({ title: 'Kid access' })
    const made = await log(id, {}, kid)
    expect(made.statusCode).toBe(201)
    const entry = JSON.parse(made.body).entry
    expect(entry.loggedBy).toBe(kidId)
    const when = new Date(Date.now() - 3600_000).toISOString()
    const patched = await call('PATCH', `/api/tracker-entries/${entry.id}`, kid, { occurredAt: when, personId: kidId, note: 'oops' })
    expect(patched.statusCode).toBe(200)
    expect(JSON.parse(patched.body).entry).toMatchObject({ occurredAt: when, personId: kidId, personName: 'Kiddo', note: 'oops' })
    const cleared = await call('PATCH', `/api/tracker-entries/${entry.id}`, kid, { personId: null })
    expect(JSON.parse(cleared.body).entry.personId).toBeNull()
    expect((await call('PATCH', `/api/tracker-entries/${entry.id}`, kid, { occurredAt: new Date(Date.now() + 3600_000).toISOString() })).statusCode).toBe(400)
    expect((await call('DELETE', `/api/tracker-entries/${entry.id}`, kid)).statusCode).toBe(204)
    expect((await call('DELETE', `/api/tracker-entries/${entry.id}`, kid)).statusCode).toBe(404)
  })

  it('turning askPerson on keeps old personless entries listed', async () => {
    const id = await mk({ title: 'Later strict' })
    await log(id)
    await call('PATCH', `/api/trackers/${id}`, kevin, { askPerson: true })
    const list = JSON.parse((await call('GET', `/api/trackers/${id}/entries`, kevin)).body)
    expect(list.entries).toHaveLength(1)
    expect(list.entries[0].personId).toBeNull()
  })

  it("404s on another household's entry and tracker", async () => {
    const { entryId, trackerId } = await withClient(async (c) => {
      const h = await c.query<{ id: string }>(`insert into households (name, timezone) values ('Third', 'UTC') returning id`)
      const t = await c.query<{ id: string }>(`insert into trackers (household_id, title) values ($1, 'Theirs') returning id`, [h.rows[0].id])
      const e = await c.query<{ id: string }>(`insert into tracker_entries (household_id, tracker_id) values ($1, $2) returning id`, [h.rows[0].id, t.rows[0].id])
      return { entryId: e.rows[0].id, trackerId: t.rows[0].id }
    })
    expect((await call('DELETE', `/api/tracker-entries/${entryId}`, kevin)).statusCode).toBe(404)
    expect((await call('PATCH', `/api/tracker-entries/${entryId}`, kevin, { note: 'x' })).statusCode).toBe(404)
    expect((await log(trackerId)).statusCode).toBe(404)
    expect((await call('GET', `/api/trackers/${trackerId}/entries`, kevin)).statusCode).toBe(404)
  })
})
