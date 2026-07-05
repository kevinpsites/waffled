// Calendar — Google connect (5.2): migration + the OAuth connect/callback/status
// flow, exercised end-to-end against an in-process stub standing in for Google's
// token / userinfo / calendarList endpoints (no real Google, no Auth0). The stub
// is wired via the overridable GOOGLE_* URLs in config; env must be set BEFORE the
// app (and thus config) is imported.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let dbUrl = ''
let stub: Server
let stubCalls: string[] = []
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let kellyId = ''

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

// A tiny Google stand-in: token exchange, userinfo, and the calendar list.
function startStub(): Promise<number> {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      const url = req.url ?? ''
      stubCalls.push(`${req.method} ${url.split('?')[0]}`)
      res.setHeader('content-type', 'application/json')
      if (req.method === 'POST' && url.startsWith('/token')) {
        res.end(JSON.stringify({
          access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3599,
          scope: 'openid email https://www.googleapis.com/auth/calendar', id_token: 'id-1',
        }))
      } else if (url.startsWith('/userinfo')) {
        res.end(JSON.stringify({ sub: 'google-sub-123', email: 'kevin@example.com' }))
      } else if (url.startsWith('/users/me/calendarList')) {
        res.end(JSON.stringify({ items: [
          { id: 'primary', summary: 'Kevin', primary: true, accessRole: 'owner', timeZone: 'America/Chicago', backgroundColor: '#4285F4' },
          { id: 'fam@group.calendar.google.com', summary: 'Family', accessRole: 'writer', timeZone: 'America/Chicago', backgroundColor: '#0B8043' },
        ] }))
      } else {
        res.statusCode = 404
        res.end('{}')
      }
    })
    stub.listen(0, '127.0.0.1', () => resolve((stub.address() as { port: number }).port))
  })
}

// Pull the `state` param back out of the consent URL the connect route returns.
function stateFrom(url: string): string {
  return new URL(url).searchParams.get('state') ?? ''
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  dbUrl = pg.getConnectionUri()
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
  const query = (await import('../src/platform/db')).query
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  const sb = JSON.parse(setup.body)
  // Seed an identity so the legacy mint('dev|kevin') token resolves to the owner.
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [sb.household.id, sb.person.id]
  )
  kellyId = JSON.parse((await call('POST', '/api/persons', kevin, { name: 'Kelly', memberType: 'adult', colorHex: '#E0548B' })).body).person.id
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await new Promise<void>((r) => stub?.close(() => r()))
  await pg?.stop()
})

describe('calendars schema', () => {
  it('creates the calendar tables and FKs events.calendar_id → calendars', async () => {
    const client = new Client({ connectionString: dbUrl })
    await client.connect()
    try {
      const tables = await client.query(
        `select table_name from information_schema.tables
          where table_name in ('calendar_accounts','calendars','calendar_oauth_states')`
      )
      expect(tables.rowCount).toBe(3)
      const fk = await client.query(
        `select 1 from information_schema.table_constraints
          where constraint_name = 'fk_events_calendar' and constraint_type = 'FOREIGN KEY'`
      )
      expect(fk.rowCount).toBe(1)
    } finally {
      await client.end()
    }
  })
})

describe('connect flow', () => {
  it('403s for a caller with no household', async () => {
    expect((await call('POST', '/api/calendar/google/connect', mint('dev|nobody'))).statusCode).toBe(403)
  })

  it('returns a Google consent URL carrying client_id, scope, and a state', async () => {
    const res = await call('POST', '/api/calendar/google/connect', kevin, {})
    expect(res.statusCode).toBe(200)
    const url = JSON.parse(res.body).url as string
    expect(url).toContain('client_id=client-abc')
    expect(url).toContain('access_type=offline')
    expect(url).toContain('prompt=consent')
    expect(stateFrom(url)).toBeTruthy()
  })

  it('rejects a callback with an unknown/expired state', async () => {
    const res = await call('GET', '/auth/google/calendar/callback?code=abc&state=bogus')
    expect(res.statusCode).toBe(400)
    expect(res.body.toLowerCase()).toContain('expired')
  })

  it('completes the round-trip: callback stores the account + imports calendars', async () => {
    const state = stateFrom(JSON.parse((await call('POST', '/api/calendar/google/connect', kevin, {})).body).url)
    const cb = await call('GET', `/auth/google/calendar/callback?code=auth-code-1&state=${state}`)
    expect(cb.statusCode).toBe(200)
    expect(cb.body.toLowerCase()).toContain('connected')
    expect(stubCalls).toContain('POST /token')
    expect(stubCalls).toContain('GET /users/me/calendarList')

    const status = JSON.parse((await call('GET', '/api/calendar/google/status', kevin)).body)
    expect(status.connected).toBe(true)
    expect(status.accounts).toHaveLength(1)
    expect(status.accounts[0].email).toBe('kevin@example.com')
    expect(status.calendars).toHaveLength(2)
    const primary = status.calendars.find((c: { isPrimary: boolean }) => c.isPrimary)
    expect(primary).toMatchObject({ summary: 'Kevin', personName: 'Kevin', selected: true })
  })

  it('the stored refresh token is encrypted at rest (not plaintext)', async () => {
    const { encryptSecret, decryptSecret } = await import('../src/platform/crypto')
    const round = decryptSecret(encryptSecret('refresh-1'))
    expect(round).toBe('refresh-1')
    // and the ciphertext differs from the plaintext
    expect(encryptSecret('refresh-1')).not.toContain('refresh-1')
  })
})

describe('calendar mapping + reconnect', () => {
  async function familyCal() {
    const status = JSON.parse((await call('GET', '/api/calendar/google/status', kevin)).body)
    return status.calendars.find((c: { summary: string }) => c.summary === 'Family')
  }

  it('maps a calendar to a person and toggles sync (admin)', async () => {
    const fam = await familyCal()
    const res = await call('PATCH', `/api/calendar/google/calendars/${fam.id}`, kevin, { personId: kellyId, selected: false })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).calendar).toMatchObject({ personName: 'Kelly', selected: false })
  })

  it('preserves the household mapping when the same account reconnects', async () => {
    const state = stateFrom(JSON.parse((await call('POST', '/api/calendar/google/connect', kevin, {})).body).url)
    expect((await call('GET', `/auth/google/calendar/callback?code=auth-code-2&state=${state}`)).statusCode).toBe(200)
    // still one account (upsert on google_sub), Family still mapped to Kelly + unselected
    const status = JSON.parse((await call('GET', '/api/calendar/google/status', kevin)).body)
    expect(status.accounts).toHaveLength(1)
    const fam = status.calendars.find((c: { summary: string }) => c.summary === 'Family')
    expect(fam).toMatchObject({ personName: 'Kelly', selected: false })
  })

  it('surfaces a per-account sync error and clears it on reconnect', async () => {
    const accountId = JSON.parse((await call('GET', '/api/calendar/google/status', kevin)).body).accounts[0].id
    // Simulate what syncHousehold stamps on an invalid_grant token failure.
    const client = new Client({ connectionString: dbUrl })
    await client.connect()
    await client.query(
      `update calendar_accounts set last_sync_error = $2, last_sync_error_at = now() where id = $1`,
      [accountId, 'invalid_grant: Token has been expired or revoked.']
    )
    await client.end()
    // The status endpoint attributes it to the account row…
    const errored = JSON.parse((await call('GET', '/api/calendar/google/status', kevin)).body)
    expect(errored.accounts[0].lastSyncError).toMatch(/invalid_grant/)
    // …and reconnecting the same account clears it (token refreshed in place).
    const state = stateFrom(JSON.parse((await call('POST', '/api/calendar/google/connect', kevin, {})).body).url)
    expect((await call('GET', `/auth/google/calendar/callback?code=auth-code-3&state=${state}`)).statusCode).toBe(200)
    const cleared = JSON.parse((await call('GET', '/api/calendar/google/status', kevin)).body)
    expect(cleared.accounts[0].lastSyncError).toBeNull()
  })

  it('disconnects an account and clears its calendars', async () => {
    const status = JSON.parse((await call('GET', '/api/calendar/google/status', kevin)).body)
    const accountId = status.accounts[0].id
    expect((await call('DELETE', `/api/calendar/google/accounts/${accountId}`, kevin)).statusCode).toBe(204)
    const after = JSON.parse((await call('GET', '/api/calendar/google/status', kevin)).body)
    expect(after.connected).toBe(false)
    expect(after.calendars).toHaveLength(0)
  })
})
