// Calendar — inbound Google sync (5.3): POST /api/calendar/sync pulling events from
// connected calendars into the events table, exercised against an in-process stub
// standing in for Google's token + events.list endpoints. Covers the first full pull
// (paged → nextSyncToken), the incremental pull (updates + cancellations via the
// stored cursor), nook-owned person inheritance/preservation, the 410 stale-token
// full-resync path, and skipping unselected calendars.
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
let kellyId = ''

// Records each events.list hit so tests can assert cursor use + skip behavior.
let eventCalls: Array<{ calendar: string; syncToken: string | null; hasWindow: boolean }> = []
let primaryFullSyncs = 0

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

const evStandup = {
  id: 'evt-a', status: 'confirmed', summary: 'Standup', description: null, location: 'Office',
  start: { dateTime: '2026-06-20T09:00:00-05:00' }, end: { dateTime: '2026-06-20T09:30:00-05:00' },
  iCalUID: 'a@google', etag: '"1"', sequence: 0, updated: '2026-06-10T00:00:00Z',
}
const evTrip = {
  id: 'evt-b', status: 'confirmed', summary: 'Trip', description: null, location: null,
  start: { date: '2026-06-21' }, end: { date: '2026-06-22' },
  iCalUID: 'b@google', etag: '"1"', sequence: 0, updated: '2026-06-10T00:00:00Z',
}
const evStandupMoved = {
  ...evStandup, summary: 'Standup (moved)', start: { dateTime: '2026-06-20T10:00:00-05:00' },
  end: { dateTime: '2026-06-20T10:30:00-05:00' }, etag: '"2"', sequence: 1, updated: '2026-06-12T00:00:00Z',
}
const evTripCancelled = { id: 'evt-b', status: 'cancelled' }

// Google stand-in: /token (auth-code + refresh grants), /userinfo, calendarList,
// and the per-calendar events feed with paging + sync-token phases.
function startStub(): Promise<number> {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      const u = new URL(req.url ?? '', 'http://stub')
      res.setHeader('content-type', 'application/json')
      const path = u.pathname

      if (req.method === 'POST' && path === '/token') {
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
          { id: 'fam@group.calendar.google.com', summary: 'Family', accessRole: 'writer', timeZone: 'America/Chicago', backgroundColor: '#0B8043' },
        ] }))
        return
      }

      // events.list: /calendars/:id/events
      const m = path.match(/^\/calendars\/(.+)\/events$/)
      if (m) {
        const calendar = decodeURIComponent(m[1])
        const syncToken = u.searchParams.get('syncToken')
        const pageToken = u.searchParams.get('pageToken')
        eventCalls.push({ calendar, syncToken, hasWindow: u.searchParams.has('timeMin') })

        if (calendar !== 'primary') { res.statusCode = 404; res.end('{}'); return }

        if (syncToken) {
          if (syncToken === 'sync-primary-1') {
            res.end(JSON.stringify({ items: [evStandupMoved, evTripCancelled], nextSyncToken: 'sync-primary-2' }))
          } else if (syncToken === 'sync-primary-2') {
            res.statusCode = 410; res.end(JSON.stringify({ error: { code: 410 } }))
          } else {
            res.end(JSON.stringify({ items: [], nextSyncToken: syncToken }))
          }
          return
        }

        // Full window (timeMin present): first run is paged; later (post-410) is one page.
        // Count a sync only at its first page (no pageToken), not per page.
        if (!pageToken) primaryFullSyncs++
        if (primaryFullSyncs === 1) {
          if (!pageToken) res.end(JSON.stringify({ items: [evStandup], nextPageToken: 'p2' }))
          else res.end(JSON.stringify({ items: [evTrip], nextSyncToken: 'sync-primary-1' }))
        } else {
          res.end(JSON.stringify({ items: [evStandupMoved], nextSyncToken: 'sync-primary-3' }))
        }
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

async function eventsInJune(): Promise<Array<{ id: string; title: string; allDay: boolean; personName: string | null }>> {
  const res = await call('GET', '/api/events?from=2026-06-01&to=2026-06-30', kevin)
  return JSON.parse(res.body).events
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
  closePool = (await import('../src/db')).closePool

  await call('POST', '/api/households', kevin, { name: 'Sites', timezone: 'America/Chicago', person: { name: 'Kevin' } })
  kellyId = JSON.parse((await call('POST', '/api/persons', kevin, { name: 'Kelly', memberType: 'adult', colorHex: '#E0548B' })).body).person.id

  // Connect Google (primary → Kevin auto-mapped), then turn the Family calendar OFF
  // so the sync tests operate on a single, predictable calendar.
  const state = stateFrom(JSON.parse((await call('POST', '/api/calendar/google/connect', kevin, {})).body).url)
  await call('GET', `/auth/google/calendar/callback?code=code-1&state=${state}`)
  const status = JSON.parse((await call('GET', '/api/calendar/google/status', kevin)).body)
  const family = status.calendars.find((c: { summary: string }) => c.summary === 'Family')
  await call('PATCH', `/api/calendar/google/calendars/${family.id}`, kevin, { selected: false })
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await new Promise<void>((r) => stub?.close(() => r()))
  await pg?.stop()
})

describe('inbound sync', () => {
  it('403s for a caller with no household', async () => {
    expect((await call('POST', '/api/calendar/sync', mint('dev|nobody'))).statusCode).toBe(403)
  })

  it('first sync pulls events (paged) and they inherit the calendar person', async () => {
    const res = await call('POST', '/api/calendar/sync', kevin, {})
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.imported).toBe(2)
    // Only the selected (primary) calendar was touched — Family was skipped.
    expect(body.calendars).toHaveLength(1)
    expect(body.calendars[0]).toMatchObject({ summary: 'Kevin', imported: 2, fullResync: true })
    expect(eventCalls.every((c) => c.calendar === 'primary')).toBe(true)

    const june = await eventsInJune()
    const standup = june.find((e) => e.title === 'Standup')
    const trip = june.find((e) => e.title === 'Trip')
    expect(standup).toMatchObject({ allDay: false, personName: 'Kevin' })
    expect(trip).toMatchObject({ allDay: true, personName: 'Kevin' })
  })

  it('second sync uses the stored cursor, applying updates + cancellations', async () => {
    // A manual person reassignment must survive sync (person_id is nook-owned).
    const before = await eventsInJune()
    const standupId = before.find((e) => e.title === 'Standup')!.id
    await call('PATCH', `/api/events/${standupId}`, kevin, { personId: kellyId })

    const res = await call('POST', '/api/calendar/sync', kevin, {})
    const body = JSON.parse(res.body)
    expect(body.calendars[0]).toMatchObject({ updated: 1, deleted: 1, fullResync: false })
    // It sent the cursor minted by the first sync.
    expect(eventCalls.some((c) => c.syncToken === 'sync-primary-1')).toBe(true)

    const june = await eventsInJune()
    expect(june.find((e) => e.title === 'Trip')).toBeUndefined() // cancelled → soft-deleted
    const moved = june.find((e) => e.title === 'Standup (moved)')
    expect(moved).toBeTruthy()
    expect(moved!.personName).toBe('Kelly') // manual mapping preserved through the update
  })

  it('recovers from an expired sync token by doing a full resync', async () => {
    const res = await call('POST', '/api/calendar/sync', kevin, {})
    const body = JSON.parse(res.body)
    expect(body.calendars[0].fullResync).toBe(true)
    expect(body.calendars[0].error).toBeUndefined()
    // The moved standup is still present after recovery.
    const june = await eventsInJune()
    expect(june.find((e) => e.title === 'Standup (moved)')).toBeTruthy()
  })
})
