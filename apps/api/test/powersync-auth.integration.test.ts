// PowerSync auth: our api serves a JWKS and mints short-lived RS256 tokens that
// carry the caller's real household_id (resolved from the DB). PowerSync validates
// those tokens against the JWKS; sync rules scope buckets by the household_id claim.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { createPublicKey } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'nook-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let kevinHouseholdId = ''

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

function call(method: string, path: string, token?: string) {
  const headers: Record<string, string> = {}
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
  closePool = (await import('../src/db')).closePool
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
    const res = await post('/api/households', kevin, {
      name: 'Sites',
      timezone: 'America/Chicago',
      person: { name: 'Kevin' },
    })
    kevinHouseholdId = JSON.parse(res.body).household.id
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
      issuer: 'nook',
    }) as jwt.JwtPayload

    expect(decoded.sub).toBe('dev|kevin')
    expect(decoded.household_id).toBe(kevinHouseholdId)
  })

  it('refuses a PowerSync token for an unprovisioned caller (403)', async () => {
    const res = await call('GET', '/api/powersync/token', mint('dev|nobody'))
    expect(res.statusCode).toBe(403)
  })
})
