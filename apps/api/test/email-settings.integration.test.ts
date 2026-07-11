// Outbound email settings — HTTP round-trip against a throwaway Postgres. Covers the
// Immich-style config model: save/read transport, never echo the password, preserve
// it on omit, admin-only, and the "send test email and save" action (with an injected
// fake SMTP transport so no socket opens).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client } from 'pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let setTransportFactory: (typeof import('../src/platform/email'))['setTransportFactory']
let kevinId = ''
let householdId = ''
const sentMail: Array<Record<string, unknown>> = []

function mint(sub: string): string {
  return jwt.sign({}, SECRET, {
    algorithm: 'HS256',
    subject: sub,
    issuer: 'waffled-local',
    audience: 'waffled-api',
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
const teen = mint('dev|teen')

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  // Password encryption needs a 32-byte key (base64). Set BEFORE importing config/app.
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.from('01234567890123456789012345678901').toString('base64')
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
  setTransportFactory = (await import('../src/platform/email')).setTransportFactory

  // Intercept every SMTP send; a null-ish "host" flag lets one test force a failure.
  setTransportFactory((settings: { host: string }) => ({
    async sendMail(opts: Record<string, unknown>) {
      if (settings.host === 'bad.host') throw new Error('535 Authentication failed')
      sentMail.push(opts)
      return { messageId: 'test' }
    },
  }))

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
  // A non-admin teen for the 403 checks.
  await withClient(async (c) => {
    const p = await c.query<{ id: string }>(
      `insert into persons (household_id, name, member_type, is_admin) values ($1,'Teen','teen',false) returning id`,
      [householdId]
    )
    await c.query(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|teen',true)`,
      [householdId, p.rows[0].id]
    )
  })
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

describe('email settings', () => {
  it('returns sane defaults before anything is configured', async () => {
    const res = await call('GET', '/api/email/settings', kevin)
    expect(res.statusCode).toBe(200)
    const s = JSON.parse(res.body)
    expect(s.enabled).toBe(false)
    expect(s.port).toBe(587)
    expect(s.hasPassword).toBe(false)
    expect(s.canEncrypt).toBe(true)
    expect(s.digestSections).toEqual(['calendar', 'meals', 'grocery', 'chores'])
  })

  it('saves transport config and never echoes the password', async () => {
    const res = await call('PUT', '/api/email/settings', kevin, {
      enabled: true,
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      username: 'me@gmail.com',
      password: 'super-secret-app-pw',
      fromName: 'Waffled',
      fromAddress: 'noreply@waffled.app',
    })
    expect(res.statusCode).toBe(200)
    // The password must not appear anywhere in the response.
    expect(res.body).not.toContain('super-secret-app-pw')
    const s = JSON.parse(res.body).settings
    expect(s.host).toBe('smtp.gmail.com')
    expect(s.port).toBe(465)
    expect(s.hasPassword).toBe(true)
    expect(s.password).toBeUndefined()
  })

  it('stores the password encrypted at rest (not plaintext)', async () => {
    const enc = await withClient((c) =>
      c.query<{ password_enc: string }>(
        `select password_enc from household_email_settings where household_id = $1`,
        [householdId]
      )
    )
    expect(enc.rows[0].password_enc).toBeTruthy()
    expect(enc.rows[0].password_enc).not.toContain('super-secret-app-pw')
  })

  it('preserves the stored password when a save omits it', async () => {
    const res = await call('PUT', '/api/email/settings', kevin, { fromName: 'Sites Family' })
    expect(res.statusCode).toBe(200)
    const s = JSON.parse(res.body).settings
    expect(s.fromName).toBe('Sites Family')
    expect(s.hasPassword).toBe(true) // still there
  })

  it('rejects enabling without a host', async () => {
    const res = await call('PUT', '/api/email/settings', kevin, { enabled: true, host: null })
    expect(res.statusCode).toBe(400)
  })

  it('is admin-only', async () => {
    expect((await call('GET', '/api/email/settings', teen)).statusCode).toBe(403)
    expect((await call('PUT', '/api/email/settings', teen, { fromName: 'x' })).statusCode).toBe(403)
  })
})

describe('send test email', () => {
  it('sends to the caller account email, records a delivery, and persists', async () => {
    sentMail.length = 0
    const res = await call('POST', '/api/email/settings/test', kevin, {
      enabled: true,
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      username: 'me@gmail.com',
      // password omitted → falls back to the stored one
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.sentTo).toBe('kevin@example.com')
    expect(sentMail).toHaveLength(1)
    expect(sentMail[0].to).toBe('kevin@example.com')

    const del = await withClient((c) =>
      c.query<{ kind: string; status: string }>(
        `select kind, status from email_deliveries where household_id = $1 and kind = 'test' order by created_at desc limit 1`,
        [householdId]
      )
    )
    expect(del.rows[0]).toMatchObject({ kind: 'test', status: 'sent' })
  })

  it('surfaces the SMTP error verbatim and logs a failed delivery', async () => {
    const res = await call('POST', '/api/email/settings/test', kevin, {
      host: 'bad.host',
      username: 'me@gmail.com',
      password: 'x',
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toContain('535 Authentication failed')
    const del = await withClient((c) =>
      c.query<{ status: string }>(
        `select status from email_deliveries where household_id = $1 and kind = 'test' order by created_at desc limit 1`,
        [householdId]
      )
    )
    expect(del.rows[0].status).toBe('failed')
  })

  it('is admin-only', async () => {
    expect((await call('POST', '/api/email/settings/test', teen, {})).statusCode).toBe(403)
  })
})
