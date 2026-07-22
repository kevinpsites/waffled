// PowerSync offline-write upload sink (/api/powersync/crud): applies client row
// ops (with client-generated ids) to Postgres + routes/pushes events to Google,
// exercised against the in-process Google stub. Covers create (PUT) → routed +
// pushed, participant add, edit (PATCH) → pushed, and delete → pushed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { createServer, type Server } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let stub: Server
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let kevinId = ''
let foreignPersonId = ''
let localGoalId = ''
let foreignGoalId = ''
let foreignGoalStepId = ''
let foreignCalendarId = ''
let writeCalls: Array<{ method: string; calendar: string; eventId?: string }> = []

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}
const kevin = mint('dev|kevin')

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

function startStub(): Promise<number> {
  return new Promise((resolve) => {
    let seq = 0
    stub = createServer((req, res) => {
      const u = new URL(req.url ?? '', 'http://stub')
      res.setHeader('content-type', 'application/json')
      const path = u.pathname
      const method = req.method ?? 'GET'
      if (method === 'POST' && path === '/token') {
        res.end(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3599, scope: 'x', id_token: 'i' }))
        return
      }
      if (path === '/userinfo') { res.end(JSON.stringify({ sub: 'gsub', email: 'kevin@example.com' })); return }
      if (path === '/users/me/calendarList') {
        res.end(JSON.stringify({ items: [{ id: 'primary', summary: 'Kevin', primary: true, accessRole: 'owner', timeZone: 'America/Chicago' }] }))
        return
      }
      const m = path.match(/^\/calendars\/(.+?)\/events(?:\/(.+))?$/)
      if (m) {
        const calendar = decodeURIComponent(m[1])
        const eventId = m[2] ? decodeURIComponent(m[2]) : undefined
        if (method === 'GET') { res.end(JSON.stringify({ items: [], nextSyncToken: 't' })); return }
        writeCalls.push({ method, calendar, eventId })
        if (method === 'DELETE') { res.statusCode = 204; res.end(); return }
        seq++
        res.end(JSON.stringify({ id: eventId ?? `g-${seq}`, etag: `"${seq}"`, sequence: 0, updated: '2026-07-01T00:00:00Z' }))
        return
      }
      res.statusCode = 404; res.end('{}')
    })
    stub.listen(0, '127.0.0.1', () => resolve((stub.address() as { port: number }).port))
  })
}

function stateFrom(url: string): string { return new URL(url).searchParams.get('state') ?? '' }
async function eventsInJuly() {
  return JSON.parse((await call('GET', '/api/events?from=2026-07-01&to=2026-07-31', kevin)).body).events as Array<{
    id: string; title: string; participants: Array<{ id: string }>
  }>
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const dbUrl = pg.getConnectionUri()
  await runMigrations(dbUrl)
  const port = await startStub()
  process.env.DATABASE_URL = dbUrl
  delete process.env.AUTH0_DOMAIN
  process.env.GOOGLE_CLIENT_ID = 'c'
  process.env.GOOGLE_CLIENT_SECRET = 's'
  process.env.GOOGLE_CALENDAR_REDIRECT_URI = 'http://localhost:8080/auth/google/calendar/callback'
  process.env.GOOGLE_TOKEN_URL = `http://127.0.0.1:${port}/token`
  process.env.GOOGLE_USERINFO_URL = `http://127.0.0.1:${port}/userinfo`
  process.env.GOOGLE_CALENDAR_API_BASE = `http://127.0.0.1:${port}`
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64')

  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
  const query = (await import('../src/platform/db')).query
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  const sb = JSON.parse(setup.body)
  kevinId = sb.person.id
  // Seed an identity so the legacy mint('dev|kevin') token resolves to the owner.
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [sb.household.id, kevinId]
  )
  localGoalId = (await query<{ id: string }>(
    `insert into goals (household_id, title, goal_type, tracking_mode)
     values ($1,'Local goal','checklist','shared_total') returning id`,
    [sb.household.id]
  )).rows[0].id
  const h = await query<{ id: string }>(
    `insert into households (name, timezone) values ('Other PowerSync','UTC') returning id`
  )
  const foreignHouseholdId = h.rows[0].id
  const p = await query<{ id: string }>(
    `insert into persons (household_id, name, member_type) values ($1,'Outsider','adult') returning id`,
    [foreignHouseholdId]
  )
  foreignPersonId = p.rows[0].id
  const g = await query<{ id: string }>(
    `insert into goals (household_id, title, goal_type, tracking_mode)
     values ($1,'Foreign goal','checklist','shared_total') returning id`,
    [foreignHouseholdId]
  )
  foreignGoalId = g.rows[0].id
  const s = await query<{ id: string }>(
    `insert into goal_steps (household_id, goal_id, label) values ($1,$2,'Foreign step') returning id`,
    [foreignHouseholdId, foreignGoalId]
  )
  foreignGoalStepId = s.rows[0].id
  const a = await query<{ id: string }>(
    `insert into calendar_accounts (household_id, person_id, google_sub, refresh_token_encrypted)
     values ($1,$2,'foreign-powersync','encrypted') returning id`,
    [foreignHouseholdId, foreignPersonId]
  )
  foreignCalendarId = (await query<{ id: string }>(
    `insert into calendars (household_id, account_id, person_id, google_calendar_id)
     values ($1,$2,$3,'foreign-primary') returning id`,
    [foreignHouseholdId, a.rows[0].id, foreignPersonId]
  )).rows[0].id
  const state = stateFrom(JSON.parse((await call('POST', '/api/calendar/google/connect', kevin, {})).body).url)
  await call('GET', `/auth/google/calendar/callback?code=c1&state=${state}`)
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await new Promise<void>((r) => stub?.close(() => r()))
  await pg?.stop()
})

describe('powersync crud upload', () => {
  const eventId = randomUUID()

  it('applies an events PUT with the client id and pushes to Google', async () => {
    const n = writeCalls.length
    const res = await call('POST', '/api/powersync/crud', kevin, {
      ops: [{ op: 'PUT', table: 'events', id: eventId, data: {
        title: 'Soccer', starts_at: '2026-07-10T15:00:00Z', ends_at: '2026-07-10T16:00:00Z',
        all_day: 0, timezone: 'America/Chicago', person_id: kevinId,
      } }],
    })
    expect(res.statusCode).toBe(200)
    const events = await eventsInJuly()
    const ev = events.find((e) => e.id === eventId)
    expect(ev?.title).toBe('Soccer') // stored under the CLIENT id (no duplicate)
    const writes = writeCalls.slice(n)
    expect(writes).toEqual([{ method: 'POST', calendar: 'primary' }]) // routed + pushed
  })

  it('applies an event_participants PUT', async () => {
    const res = await call('POST', '/api/powersync/crud', kevin, {
      ops: [{ op: 'PUT', table: 'event_participants', id: randomUUID(), data: { event_id: eventId, person_id: kevinId } }],
    })
    expect(res.statusCode).toBe(200)
    const ev = (await eventsInJuly()).find((e) => e.id === eventId)
    expect(ev?.participants.some((p) => p.id === kevinId)).toBe(true)
  })

  it('applies an events PATCH and pushes the edit', async () => {
    const n = writeCalls.length
    await call('POST', '/api/powersync/crud', kevin, {
      ops: [{ op: 'PATCH', table: 'events', id: eventId, data: { title: 'Soccer (moved)' } }],
    })
    expect((await eventsInJuly()).find((e) => e.id === eventId)?.title).toBe('Soccer (moved)')
    expect(writeCalls.slice(n).some((w) => w.method === 'PATCH' && w.calendar === 'primary')).toBe(true)
  })

  it('rejects foreign references and applies no part of an invalid batch', async () => {
    for (const data of [
      { person_id: foreignPersonId },
      { goal_id: foreignGoalId },
      { goal_id: localGoalId, goal_step_id: foreignGoalStepId },
      { calendar_id: foreignCalendarId },
    ]) {
      const res = await call('POST', '/api/powersync/crud', kevin, {
        ops: [{ op: 'PUT', table: 'events', id: randomUUID(), data: {
          title: 'Unsafe', starts_at: '2026-07-11T15:00:00Z', ...data,
        } }],
      })
      expect(res.statusCode).toBe(404)
    }

    expect((await call('POST', '/api/powersync/crud', kevin, {
      ops: [{ op: 'PUT', table: 'event_participants', id: randomUUID(), data: {
        event_id: eventId, person_id: foreignPersonId,
      } }],
    })).statusCode).toBe(404)

    const before = (await eventsInJuly()).find((e) => e.id === eventId)?.title
    expect((await call('POST', '/api/powersync/crud', kevin, {
      ops: [
        { op: 'PATCH', table: 'events', id: eventId, data: { title: 'Must not stick' } },
        { op: 'PATCH', table: 'events', id: eventId, data: { person_id: foreignPersonId } },
      ],
    })).statusCode).toBe(404)
    expect((await eventsInJuly()).find((e) => e.id === eventId)?.title).toBe(before)
  })

  it('applies an events DELETE and pushes the deletion', async () => {
    const n = writeCalls.length
    await call('POST', '/api/powersync/crud', kevin, {
      ops: [{ op: 'DELETE', table: 'events', id: eventId }],
    })
    expect((await eventsInJuly()).find((e) => e.id === eventId)).toBeUndefined()
    expect(writeCalls.slice(n).some((w) => w.method === 'DELETE')).toBe(true)
  })

  it('403s for a caller with no household', async () => {
    expect((await call('POST', '/api/powersync/crud', mint('dev|nobody'), { ops: [] })).statusCode).toBe(403)
  })
})
