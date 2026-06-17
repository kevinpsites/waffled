// Calendar — outbound write-back (5.4): events authored in Nook are routed to the
// owner's write-target calendar and created/updated/deleted on Google, exercised
// against an in-process stub for the token + event write/list endpoints. Covers
// routing to a single target when a person owns several writable calendars, the
// write-target override, update + delete mirroring, local-only events (no push),
// and the push_failed → retry path via POST /api/calendar/sync.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'nook-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let stub: Server
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let kevinId = ''

// Records every event write so tests can assert which calendar received what.
let writeCalls: Array<{ method: string; calendar: string; eventId?: string }> = []
let failInsertOnce = false
let seq = 0

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'nook-local', audience: 'nook-api', expiresIn: '1h' })
}

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

const kevin = mint('dev|kevin')

function startStub(): Promise<number> {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      const u = new URL(req.url ?? '', 'http://stub')
      res.setHeader('content-type', 'application/json')
      const path = u.pathname
      const method = req.method ?? 'GET'

      if (method === 'POST' && path === '/token') {
        res.end(JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3599, scope: 'openid email https://www.googleapis.com/auth/calendar', id_token: 'id-1' }))
        return
      }
      if (path === '/userinfo') {
        res.end(JSON.stringify({ sub: 'google-sub-123', email: 'kevin@example.com' }))
        return
      }
      if (path === '/users/me/calendarList') {
        res.end(JSON.stringify({ items: [
          { id: 'primary', summary: 'Kevin', primary: true, accessRole: 'owner', timeZone: 'America/Chicago', backgroundColor: '#4285F4' },
          { id: 'work@group.calendar.google.com', summary: 'Work', accessRole: 'owner', timeZone: 'America/Chicago', backgroundColor: '#0B8043' },
          { id: 'holidays@group.calendar.google.com', summary: 'Holidays', accessRole: 'reader', timeZone: 'America/Chicago', backgroundColor: '#999' },
        ] }))
        return
      }

      const m = path.match(/^\/calendars\/(.+?)\/events(?:\/(.+))?$/)
      if (m) {
        const calendar = decodeURIComponent(m[1])
        const eventId = m[2] ? decodeURIComponent(m[2]) : undefined

        if (method === 'GET') {
          // events.list (inbound, run after pushes during /api/calendar/sync)
          res.end(JSON.stringify({ items: [], nextSyncToken: 'synctok-1' }))
          return
        }
        writeCalls.push({ method, calendar, eventId })
        if (method === 'DELETE') { res.statusCode = 204; res.end(); return }
        if (method === 'POST' && failInsertOnce) { failInsertOnce = false; res.statusCode = 500; res.end('{"error":"boom"}'); return }
        seq++
        res.end(JSON.stringify({ id: eventId ?? `g-evt-${seq}`, etag: `"w${seq}"`, sequence: 0, updated: '2026-07-01T00:00:00Z' }))
        return
      }

      res.statusCode = 404
      res.end('{}')
    })
    stub.listen(0, '127.0.0.1', () => resolve((stub.address() as { port: number }).port))
  })
}

function stateFrom(url: string): string {
  return new URL(url).searchParams.get('state') ?? ''
}
async function calBySummary(summary: string) {
  const status = JSON.parse((await call('GET', '/api/calendar/google/status', kevin)).body)
  return status.calendars.find((c: { summary: string }) => c.summary === summary)
}
function writesSince(n: number) {
  return writeCalls.slice(n)
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const dbUrl = pg.getConnectionUri()
  await runMigrations(dbUrl)
  const port = await startStub()

  process.env.DATABASE_URL = dbUrl
  delete process.env.AUTH0_DOMAIN
  process.env.GOOGLE_CLIENT_ID = 'client-abc'
  process.env.GOOGLE_CLIENT_SECRET = 'secret-xyz'
  process.env.GOOGLE_CALENDAR_REDIRECT_URI = 'http://localhost:8080/auth/google/calendar/callback'
  process.env.GOOGLE_TOKEN_URL = `http://127.0.0.1:${port}/token`
  process.env.GOOGLE_USERINFO_URL = `http://127.0.0.1:${port}/userinfo`
  process.env.GOOGLE_CALENDAR_API_BASE = `http://127.0.0.1:${port}`
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64')

  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool

  kevinId = JSON.parse((await call('POST', '/api/households', kevin, { name: 'Sites', timezone: 'America/Chicago', person: { name: 'Kevin' } })).body).person.id

  // Connect; primary auto-maps to Kevin. Also map the second writable calendar
  // (Work) to Kevin so he owns two writable calendars — the routing test.
  const state = stateFrom(JSON.parse((await call('POST', '/api/calendar/google/connect', kevin, {})).body).url)
  await call('GET', `/auth/google/calendar/callback?code=code-1&state=${state}`)
  const work = await calBySummary('Work')
  await call('PATCH', `/api/calendar/google/calendars/${work.id}`, kevin, { personId: kevinId })
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await new Promise<void>((r) => stub?.close(() => r()))
  await pg?.stop()
})

describe('outbound write-back', () => {
  it('routes a new event to the owner’s primary (default) calendar — only one', async () => {
    const n = writeCalls.length
    const res = await call('POST', '/api/events', kevin, { title: 'Dentist', startsAt: '2026-07-02T15:00:00Z', personId: kevinId })
    expect(res.statusCode).toBe(201)
    const writes = writesSince(n)
    expect(writes).toHaveLength(1) // not duplicated across Kevin's two calendars
    expect(writes[0]).toMatchObject({ method: 'POST', calendar: 'primary' })
  })

  it('honors the write-target override (events go to Work instead)', async () => {
    const work = await calBySummary('Work')
    await call('PATCH', `/api/calendar/google/calendars/${work.id}`, kevin, { isWriteTarget: true })

    const n = writeCalls.length
    await call('POST', '/api/events', kevin, { title: 'Standup', startsAt: '2026-07-03T14:00:00Z', personId: kevinId })
    const writes = writesSince(n)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ method: 'POST', calendar: 'work@group.calendar.google.com' })
  })

  it('mirrors edits (PATCH) and deletes (DELETE) to Google', async () => {
    const created = JSON.parse((await call('POST', '/api/events', kevin, { title: 'Lunch', startsAt: '2026-07-04T17:00:00Z', personId: kevinId })).body).event

    let n = writeCalls.length
    await call('PATCH', `/api/events/${created.id}`, kevin, { title: 'Lunch with Kelly' })
    expect(writesSince(n)).toEqual([{ method: 'PATCH', calendar: 'work@group.calendar.google.com', eventId: expect.stringContaining('g-evt') }])

    n = writeCalls.length
    await call('DELETE', `/api/events/${created.id}`, kevin)
    expect(writesSince(n)).toEqual([{ method: 'DELETE', calendar: 'work@group.calendar.google.com', eventId: expect.stringContaining('g-evt') }])
  })

  it('does not push an event with no Google-mapped owner (stays local)', async () => {
    const n = writeCalls.length
    const res = await call('POST', '/api/events', kevin, { title: 'Private note', startsAt: '2026-07-05T12:00:00Z' })
    expect(res.statusCode).toBe(201)
    expect(writesSince(n)).toHaveLength(0)
  })

  it('retries a failed push on the next sync (push_failed → synced)', async () => {
    failInsertOnce = true
    const created = JSON.parse((await call('POST', '/api/events', kevin, { title: 'Flaky', startsAt: '2026-07-06T16:00:00Z', personId: kevinId })).body).event
    expect(created.id).toBeTruthy() // create still succeeds despite the push failing

    const n = writeCalls.length
    const sync = JSON.parse((await call('POST', '/api/calendar/sync', kevin, {})).body)
    expect(sync.pushed.created).toBe(1) // the queued event was pushed on sync
    const retried = writesSince(n).filter((w) => w.method === 'POST')
    expect(retried).toHaveLength(1)
    expect(retried[0].calendar).toBe('work@group.calendar.google.com')
  })

  it('honors an explicit calendarId from the create picker (overrides the ★ target)', async () => {
    // Work is the write target, but the picker explicitly chooses primary.
    const status = JSON.parse((await call('GET', '/api/calendar/google/status', kevin)).body)
    const primaryCal = status.calendars.find((c: { isPrimary: boolean }) => c.isPrimary)
    const n = writeCalls.length
    await call('POST', '/api/events', kevin, {
      title: 'Explicit cal',
      startsAt: '2026-07-07T15:00:00Z',
      personId: kevinId,
      calendarId: primaryCal.id,
    })
    const writes = writesSince(n)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ method: 'POST', calendar: 'primary' })
  })

  it('creates a Nook-only event when calendarId is null (no push)', async () => {
    const n = writeCalls.length
    const res = await call('POST', '/api/events', kevin, {
      title: 'Nook only',
      startsAt: '2026-07-08T15:00:00Z',
      personId: kevinId,
      calendarId: null,
    })
    expect(res.statusCode).toBe(201)
    expect(writesSince(n)).toHaveLength(0)
  })
})
