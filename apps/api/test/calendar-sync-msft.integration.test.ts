// Calendar — Microsoft/Outlook provider (fork): the Graph adapter driving the same
// sync engine as Google, against an in-process stub standing in for the Microsoft
// identity platform + Graph. Covers connect (OAuth state/provider), the first
// calendarView/delta pull (paged → deltaLink), the incremental pull (update +
// @removed tombstone), REFRESH-TOKEN ROTATION persistence (the stub rejects any
// refresh token but the newest it issued), the 410 stale-delta full-resync path,
// and outbound write-back to Graph.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let stub: Server
let stubPort = 0
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let householdId = ''
let kevinId = ''

// Rotation bookkeeping: only the most recently issued refresh token is valid.
let currentRefresh = ''
let refreshGrants = 0
// Delta bookkeeping for assertions.
let deltaCalls: Array<{ deltatoken: string | null; skiptoken: string | null; initial: boolean }> = []
let fullSyncs = 0
// Outbound writes the stub received.
let writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = []

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
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

const msStandup = {
  id: 'evt-a', subject: 'Standup', bodyPreview: 'daily', isAllDay: false, isCancelled: false,
  location: { displayName: 'Office' },
  start: { dateTime: '2026-06-20T14:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-06-20T14:30:00.0000000', timeZone: 'UTC' },
  iCalUId: 'a@outlook', changeKey: 'ck-a-1', lastModifiedDateTime: '2026-06-10T00:00:00Z',
}
const msTrip = {
  id: 'evt-b', subject: 'Trip', bodyPreview: '', isAllDay: true, isCancelled: false,
  location: null,
  start: { dateTime: '2026-06-21T00:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-06-22T00:00:00.0000000', timeZone: 'UTC' },
  iCalUId: 'b@outlook', changeKey: 'ck-b-1', lastModifiedDateTime: '2026-06-10T00:00:00Z',
}
const msStandupMoved = {
  ...msStandup, subject: 'Standup (moved)',
  start: { dateTime: '2026-06-20T15:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-06-20T15:30:00.0000000', timeZone: 'UTC' },
  changeKey: 'ck-a-2', lastModifiedDateTime: '2026-06-12T00:00:00Z',
}
const msTripRemoved = { id: 'evt-b', '@removed': { reason: 'deleted' } }

// Microsoft stand-in: /token (rotating refresh tokens), /me, /me/calendars, the
// calendarView/delta feed (paged + delta phases + 410 expiry), and event writes.
function startStub(): Promise<number> {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      const u = new URL(req.url ?? '', 'http://stub')
      res.setHeader('content-type', 'application/json')
      const path = u.pathname
      const base = `http://127.0.0.1:${stubPort}`

      if (req.method === 'POST' && path === '/token') {
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', () => {
          const form = new URLSearchParams(raw)
          if (form.get('grant_type') === 'refresh_token') {
            // Rotation contract: only the newest refresh token is accepted.
            if (form.get('refresh_token') !== currentRefresh) {
              res.statusCode = 400
              return res.end(JSON.stringify({ error: 'invalid_grant' }))
            }
            refreshGrants++
          }
          currentRefresh = `refresh-${refreshGrants + 1}`
          res.end(JSON.stringify({
            access_token: `access-${refreshGrants + 1}`,
            refresh_token: currentRefresh,
            expires_in: 3599,
            scope: 'openid email offline_access User.Read Calendars.ReadWrite',
            id_token: 'id-1',
          }))
        })
        return
      }
      if (path === '/me') {
        return res.end(JSON.stringify({ id: 'ms-sub-1', mail: 'kevin@outlook.com', userPrincipalName: 'kevin@outlook.com' }))
      }
      if (path === '/me/calendars') {
        return res.end(JSON.stringify({ value: [
          { id: 'cal-1', name: 'Kevin', isDefaultCalendar: true, canEdit: true, hexColor: '#0078D4' },
          { id: 'cal-2', name: 'Birthdays', isDefaultCalendar: false, canEdit: false, hexColor: '' },
        ] }))
      }

      if (path === '/me/calendars/cal-1/calendarView/delta') {
        const deltatoken = u.searchParams.get('$deltatoken')
        const skiptoken = u.searchParams.get('$skiptoken')
        const initial = !deltatoken && !skiptoken
        deltaCalls.push({ deltatoken, skiptoken, initial })

        if (deltatoken === 'd1') {
          return res.end(JSON.stringify({
            value: [msStandupMoved, msTripRemoved],
            '@odata.deltaLink': `${base}/me/calendars/cal-1/calendarView/delta?$deltatoken=d2`,
          }))
        }
        if (deltatoken === 'd2') {
          res.statusCode = 410
          return res.end(JSON.stringify({ error: { code: 'syncStateNotFound' } }))
        }
        if (deltatoken) {
          return res.end(JSON.stringify({ value: [], '@odata.deltaLink': `${base}${path}?$deltatoken=${deltatoken}` }))
        }
        if (skiptoken === 'p2') {
          return res.end(JSON.stringify({
            value: [msTrip],
            '@odata.deltaLink': `${base}/me/calendars/cal-1/calendarView/delta?$deltatoken=d1`,
          }))
        }
        // Initial page 1 (has startDateTime). First full sync is paged; the
        // post-410 resync returns a single page with a fresh delta token.
        fullSyncs++
        if (fullSyncs === 1) {
          return res.end(JSON.stringify({
            value: [msStandup],
            '@odata.nextLink': `${base}/me/calendars/cal-1/calendarView/delta?$skiptoken=p2`,
          }))
        }
        return res.end(JSON.stringify({
          value: [msStandupMoved],
          '@odata.deltaLink': `${base}/me/calendars/cal-1/calendarView/delta?$deltatoken=d3`,
        }))
      }

      // Outbound writes.
      if (req.method === 'POST' && path === '/me/calendars/cal-1/events') {
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', () => {
          writes.push({ method: 'POST', path, body: JSON.parse(raw) })
          res.end(JSON.stringify({ id: 'evt-new-1', changeKey: 'ck-new-1', lastModifiedDateTime: '2026-06-15T00:00:00Z' }))
        })
        return
      }

      res.statusCode = 404
      res.end('{}')
    })
    stub.listen(0, '127.0.0.1', () => {
      stubPort = (stub.address() as { port: number }).port
      resolve(stubPort)
    })
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
  process.env.LOCAL_JWT_SECRET = SECRET
  delete process.env.AUTH0_DOMAIN
  delete process.env.GOOGLE_CLIENT_ID // Google intentionally unconfigured
  delete process.env.GOOGLE_CLIENT_SECRET
  delete process.env.GOOGLE_CALENDAR_REDIRECT_URI
  process.env.MS_CLIENT_ID = 'ms-client-abc'
  process.env.MS_CLIENT_SECRET = 'ms-secret-xyz'
  process.env.MS_CALENDAR_REDIRECT_URI = 'http://localhost:8080/auth/microsoft/calendar/callback'
  process.env.MS_AUTH_URL = `http://127.0.0.1:${port}/authorize`
  process.env.MS_TOKEN_URL = `http://127.0.0.1:${port}/token`
  process.env.MS_GRAPH_BASE = `http://127.0.0.1:${port}`
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
  householdId = sb.household.id
  kevinId = sb.person.id
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [householdId, kevinId]
  )
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await new Promise<void>((r) => stub?.close(() => r()))
  await pg?.stop()
})

describe('outlook connect', () => {
  it('connect returns the Microsoft consent URL and the callback stores the account', async () => {
    const conn = await call('POST', '/api/calendar/microsoft/connect', kevin, {})
    expect(conn.statusCode).toBe(200)
    const url = JSON.parse(conn.body).url
    expect(url).toContain('/authorize')
    expect(url).toContain('offline_access')

    const cb = await call('GET', `/auth/microsoft/calendar/callback?code=code-1&state=${stateFrom(url)}`)
    expect(cb.statusCode).toBe(200)
    expect(currentRefresh).toBe('refresh-1') // code exchange issued the first token

    const status = JSON.parse((await call('GET', '/api/calendar/google/status', kevin)).body)
    expect(status.microsoftConfigured).toBe(true)
    expect(status.configured).toBe(false) // Google intentionally off in this suite
    expect(status.accounts).toHaveLength(1)
    expect(status.accounts[0]).toMatchObject({ provider: 'microsoft', email: 'kevin@outlook.com' })
    const primary = status.calendars.find((c: { isPrimary: boolean }) => c.isPrimary)
    expect(primary).toMatchObject({ summary: 'Kevin', accessRole: 'writer' })
    // Read-only calendar mapped from canEdit=false.
    const bday = status.calendars.find((c: { summary: string }) => c.summary === 'Birthdays')
    expect(bday.accessRole).toBe('reader')
    // Keep the suite predictable: only the primary calendar syncs.
    await call('PATCH', `/api/calendar/google/calendars/${bday.id}`, kevin, { selected: false })
  })

  it('a Google state cannot be replayed against the Microsoft callback', async () => {
    const cb = await call('GET', `/auth/microsoft/calendar/callback?code=code-2&state=not-a-real-state`)
    expect(cb.statusCode).toBe(400)
  })
})

describe('outlook inbound sync', () => {
  it('first sync pulls the delta window (paged) into events', async () => {
    const res = await call('POST', '/api/calendar/sync', kevin, {})
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.imported).toBe(2)
    expect(body.calendars).toHaveLength(1)
    expect(body.calendars[0]).toMatchObject({ summary: 'Kevin', imported: 2, fullResync: true })

    const june = await eventsInJune()
    expect(june.find((e) => e.title === 'Standup')).toMatchObject({ allDay: false, personName: 'Kevin' })
    expect(june.find((e) => e.title === 'Trip')).toMatchObject({ allDay: true, personName: 'Kevin' })
  })

  it('incremental sync applies updates and @removed tombstones via the deltaLink', async () => {
    const res = await call('POST', '/api/calendar/sync', kevin, {})
    const body = JSON.parse(res.body)
    expect(body.calendars[0]).toMatchObject({ updated: 1, deleted: 1, fullResync: false })
    expect(deltaCalls.some((c) => c.deltatoken === 'd1')).toBe(true)

    const june = await eventsInJune()
    expect(june.find((e) => e.title === 'Standup (moved)')).toBeTruthy()
    expect(june.find((e) => e.title === 'Trip')).toBeUndefined() // tombstoned
  })

  it('persists rotated refresh tokens (the stub rejects stale ones)', async () => {
    // Two refresh grants have happened (one per sync). Each returned a NEW token
    // and the stub 400s any older one — so reaching here proves persistence. Also
    // check the ciphertext decrypts to the newest token.
    expect(refreshGrants).toBe(2)
    const { query } = await import('../src/platform/db')
    const { decryptSecret } = await import('../src/platform/crypto')
    const { rows } = await query<{ refresh_token_encrypted: string }>(
      `select refresh_token_encrypted from calendar_accounts where household_id = $1`,
      [householdId]
    )
    expect(decryptSecret(rows[0].refresh_token_encrypted)).toBe(currentRefresh)
  })

  it('recovers from an expired delta token (410) with a full resync', async () => {
    const res = await call('POST', '/api/calendar/sync', kevin, {})
    const body = JSON.parse(res.body)
    expect(body.calendars[0].fullResync).toBe(true)
    expect(body.calendars[0].error).toBeUndefined()
    expect(fullSyncs).toBe(2) // initial + the post-410 rebuild
  })
})

describe('outlook outbound push', () => {
  it('a Waffled event for a mapped person is written to Graph', async () => {
    const res = await call('POST', '/api/events', kevin, {
      title: 'Dentist', startsAt: '2026-06-25T15:00:00Z', personId: kevinId,
    })
    expect(res.statusCode).toBe(201)
    expect(writes).toHaveLength(1)
    expect(writes[0].body).toMatchObject({
      subject: 'Dentist',
      isAllDay: false,
      start: { dateTime: '2026-06-25T15:00:00', timeZone: 'UTC' },
    })
    const june25 = JSON.parse((await call('GET', '/api/events?from=2026-06-25&to=2026-06-26', kevin)).body).events
    const dentist = june25.find((e: { title: string }) => e.title === 'Dentist')
    expect(dentist).toBeTruthy()
  })
})
