// PowerSync auth: our api serves a JWKS and mints short-lived RS256 tokens that
// carry the caller's real household_id (resolved from the DB). PowerSync validates
// those tokens against the JWKS; sync rules scope buckets by the household_id claim.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { createPublicKey } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let kevinHouseholdId = ''

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

function call(method: string, path: string, token?: string, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extraHeaders }
  if (token) headers.authorization = `Bearer ${token}`
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}

const kevin = mint('dev|kevin')

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

// helper that posts a JSON body (provisioning)
function post(path: string, token: string, body: unknown) {
  return app.run(
    {
      httpMethod: 'POST',
      path,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      queryStringParameters: {},
      body: JSON.stringify(body),
      isBase64Encoded: false,
    },
    {}
  ) as Promise<RunResult>
}

describe('powersync auth', () => {
  beforeAll(async () => {
    const query = (await import('../src/platform/db')).query
    const res = await post('/api/auth/setup', '', {
      household: { name: 'Sites', timezone: 'America/Chicago' },
      admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
    })
    expect(res.statusCode).toBe(201)
    const sb = JSON.parse(res.body)
    kevinHouseholdId = sb.household.id
    // Seed an identity so the legacy mint('dev|kevin') token resolves to the owner;
    // its PowerSync token must carry sub='dev|kevin'.
    await query(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
      [kevinHouseholdId, sb.person.id]
    )
  })

  it('serves a JWKS at /api/auth/keys without auth', async () => {
    const res = await call('GET', '/api/auth/keys')
    expect(res.statusCode).toBe(200)
    const jwks = JSON.parse(res.body)
    expect(jwks.keys).toHaveLength(1)
    expect(jwks.keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' })
    expect(typeof jwks.keys[0].kid).toBe('string')
  })

  it('mints a PowerSync token for a provisioned member, verifiable against the JWKS', async () => {
    const res = await call('GET', '/api/powersync/token', kevin)
    expect(res.statusCode).toBe(200)
    const { token } = JSON.parse(res.body)
    expect(typeof token).toBe('string')

    const jwks = JSON.parse((await call('GET', '/api/auth/keys')).body)
    const publicKey = createPublicKey({ key: jwks.keys[0], format: 'jwk' })
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      audience: 'powersync',
      issuer: 'waffled',
    }) as jwt.JwtPayload

    expect(decoded.sub).toBe('dev|kevin')
    expect(decoded.household_id).toBe(kevinHouseholdId)
  })

  it('refuses a PowerSync token for an unprovisioned caller (403)', async () => {
    const res = await call('GET', '/api/powersync/token', mint('dev|nobody'))
    expect(res.statusCode).toBe(403)
  })
})

// A fixed sync URL (it used to default to http://localhost:8090) only ever works on
// the server itself — every other device resolves localhost to ITSELF and silently
// degrades to REST-only. The URL is derived from the host the device actually
// reached us on, unless the operator pinned one.
describe('powersync url derivation', () => {
  const urlFor = async (headers: Record<string, string>) => {
    const res = await call('GET', '/api/powersync/token', kevin, headers)
    expect(res.statusCode).toBe(200)
    return JSON.parse(res.body).powerSyncUrl as string | null
  }

  afterEach(() => {
    delete process.env.POWERSYNC_PUBLIC_URL
    delete process.env.POWERSYNC_PORT
  })

  it('honours an explicitly configured POWERSYNC_PUBLIC_URL', async () => {
    process.env.POWERSYNC_PUBLIC_URL = 'https://powersync.example.com/'
    expect(await urlFor({ host: '192.168.1.20:8080' })).toBe('https://powersync.example.com')
  })

  it('derives from x-forwarded-proto / x-forwarded-host when proxied', async () => {
    expect(
      await urlFor({
        host: 'api:3000',
        'x-forwarded-proto': 'https, http',
        'x-forwarded-host': 'waffled.example.com , api.internal',
      })
    ).toBe('https://waffled.example.com:8090')
  })

  it('falls back to the Host header (the LAN address the device dialled)', async () => {
    expect(await urlFor({ host: '192.168.1.20:8080' })).toBe('http://192.168.1.20:8090')
  })

  it('swaps in POWERSYNC_PORT when PowerSync is published elsewhere', async () => {
    process.env.POWERSYNC_PORT = '9443'
    expect(await urlFor({ host: '192.168.1.20:8080' })).toBe('http://192.168.1.20:9443')
  })

  // Deriving a URL for a PowerSync that isn't there hands the client an endpoint it
  // will retry forever ("Offline", degraded sync health) where it used to notice the
  // null and stay cleanly REST-only. POWERSYNC_PUBLIC_URL=off says so out loud.
  it('reports no sync endpoint when POWERSYNC_PUBLIC_URL is off', async () => {
    process.env.POWERSYNC_PUBLIC_URL = 'off'
    expect(await urlFor({ host: '192.168.1.20:8080' })).toBeNull()
  })

  it('accepts the off switch in any case, with stray whitespace', async () => {
    process.env.POWERSYNC_PUBLIC_URL = '  OFF '
    expect(await urlFor({ host: '192.168.1.20:8080' })).toBeNull()
  })
})
