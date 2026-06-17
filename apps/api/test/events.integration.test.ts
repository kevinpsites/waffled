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
  const [rawPath, qs] = path.split('?')
  const queryStringParameters: Record<string, string> = {}
  if (qs) {
    for (const pair of qs.split('&')) {
      const [k, v] = pair.split('=')
      queryStringParameters[k] = decodeURIComponent(v ?? '')
    }
  }
  return app.run(
    {
      httpMethod: method,
      path: rawPath,
      headers,
      queryStringParameters,
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
  closePool = (await import('../src/platform/db')).closePool
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

describe('event_participants schema', () => {
  it('creates the event_participants table', async () => {
    const res = await withClient((c) =>
      c.query(`select table_name from information_schema.tables where table_name='event_participants'`)
    )
    expect(res.rowCount).toBe(1)
  })

  it('enforces one row per person per event', async () => {
    await withClient(async (c) => {
      const h = await c.query<{ id: string }>(
        `insert into households (name,timezone) values ('EP','UTC') returning id`
      )
      const hid = h.rows[0].id
      const p = await c.query<{ id: string }>(
        `insert into persons (household_id,name,member_type) values ($1,'A','adult') returning id`,
        [hid]
      )
      const e = await c.query<{ id: string }>(
        `insert into events (household_id,title,starts_at,timezone) values ($1,'X',now(),'UTC') returning id`,
        [hid]
      )
      await c.query(
        `insert into event_participants (household_id,event_id,person_id) values ($1,$2,$3)`,
        [hid, e.rows[0].id, p.rows[0].id]
      )
      await expect(
        c.query(`insert into event_participants (household_id,event_id,person_id) values ($1,$2,$3)`, [
          hid,
          e.rows[0].id,
          p.rows[0].id,
        ])
      ).rejects.toThrow()
    })
  })
})

describe('events api', () => {
  it('403s for a caller with no household', async () => {
    expect((await call('GET', '/api/events/today', mint('dev|nobody'))).statusCode).toBe(403)
  })

  it('400 without title or with a bad startsAt', async () => {
    expect((await call('POST', '/api/events', kevin, { startsAt: '2026-06-08T13:30:00Z' })).statusCode).toBe(400)
    expect((await call('POST', '/api/events', kevin, { title: 'X', startsAt: 'not-a-date' })).statusCode).toBe(400)
  })

  it('creates an event and lists it in today with the person color', async () => {
    // 13:30Z = 08:30 in America/Chicago → local date 2026-06-08
    const add = await call('POST', '/api/events', kevin, {
      title: 'Swim lessons',
      startsAt: '2026-06-08T13:30:00Z',
      personId: kevinId,
    })
    expect(add.statusCode).toBe(201)

    const today = JSON.parse((await call('GET', '/api/events/today?date=2026-06-08', kevin)).body)
    const ev = today.events.find((e: { title: string }) => e.title === 'Swim lessons')
    expect(ev).toMatchObject({ title: 'Swim lessons', personName: 'Kevin', allDay: false })
  })

  it('orders all-day events after timed ones', async () => {
    await call('POST', '/api/events', kevin, {
      title: 'Recital tickets',
      startsAt: '2026-06-08T12:00:00Z',
      allDay: true,
    })
    const events = JSON.parse((await call('GET', '/api/events/today?date=2026-06-08', kevin)).body).events
    const flags = events.map((e: { allDay: boolean }) => Number(e.allDay))
    expect(flags).toEqual([...flags].sort((a, b) => a - b)) // timed (0) before all-day (1)
  })

  it('returns events within a date range', async () => {
    const r = JSON.parse((await call('GET', '/api/events?from=2026-06-08&to=2026-06-09', kevin)).body)
    expect(r.events.some((e: { title: string }) => e.title === 'Swim lessons')).toBe(true)
  })

  it('supports multiple participants (date night) and replaces them on edit', async () => {
    const kelly = JSON.parse(
      (await call('POST', '/api/persons', kevin, { name: 'Kelly', memberType: 'adult', colorHex: '#E0548B' })).body
    ).person.id

    const add = await call('POST', '/api/events', kevin, {
      title: 'Date night',
      startsAt: '2026-06-08T23:00:00Z',
      participantIds: [kevinId, kelly],
    })
    expect(add.statusCode).toBe(201)
    const id = JSON.parse(add.body).event.id

    let ev = JSON.parse((await call('GET', '/api/events/today?date=2026-06-08', kevin)).body).events.find(
      (e: { id: string }) => e.id === id
    )
    expect(ev.participants.map((p: { name: string }) => p.name).sort()).toEqual(['Kelly', 'Kevin'])
    expect(ev.personName).toBe('Kevin') // color owner = first participant

    await call('PATCH', `/api/events/${id}`, kevin, { participantIds: [kelly] })
    ev = JSON.parse((await call('GET', '/api/events/today?date=2026-06-08', kevin)).body).events.find(
      (e: { id: string }) => e.id === id
    )
    expect(ev.participants.map((p: { name: string }) => p.name)).toEqual(['Kelly'])
    expect(ev.personName).toBe('Kelly')
  })

  it('updates and deletes an event', async () => {
    const add = await call('POST', '/api/events', kevin, {
      title: 'Vet appt',
      startsAt: '2026-06-08T20:00:00Z',
    })
    const id = JSON.parse(add.body).event.id

    // edit title + assign a person
    const patched = await call('PATCH', `/api/events/${id}`, kevin, { title: 'Vet checkup', personId: kevinId })
    expect(patched.statusCode).toBe(200)
    let today = JSON.parse((await call('GET', '/api/events/today?date=2026-06-08', kevin)).body)
    const ev = today.events.find((e: { id: string }) => e.id === id)
    expect(ev).toMatchObject({ title: 'Vet checkup', personName: 'Kevin' })

    // empty patch → 400; unknown → 404
    expect((await call('PATCH', `/api/events/${id}`, kevin, {})).statusCode).toBe(400)
    expect(
      (await call('PATCH', '/api/events/00000000-0000-0000-0000-000000000000', kevin, { title: 'x' }))
        .statusCode
    ).toBe(404)

    // delete
    expect((await call('DELETE', `/api/events/${id}`, kevin)).statusCode).toBe(204)
    today = JSON.parse((await call('GET', '/api/events/today?date=2026-06-08', kevin)).body)
    expect(today.events.some((e: { id: string }) => e.id === id)).toBe(false)
    expect((await call('DELETE', `/api/events/${id}`, kevin)).statusCode).toBe(404)
  })
})
