// Update notifier — admin gating, the env + per-household off-switches, and the
// version compare. No real network: with UPDATE_CHECK_REPO unset, the check returns
// early (never calls GitHub), so these stay hermetic.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client } from 'pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'
import { isNewer } from '../src/modules/updates/updates'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}
interface RunResult { statusCode: number; body: string }
function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body ? JSON.stringify(body) : null, isBase64Encoded: false },
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
  delete process.env.UPDATE_CHECK_REPO // keep hermetic — no outbound call
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool

  const client = new Client({ connectionString: url })
  await client.connect()
  const hh = await client.query<{ id: string }>(`insert into households (name, timezone) values ('H','UTC') returning id`)
  const hid = hh.rows[0].id
  const adm = await client.query<{ id: string }>(
    `insert into persons (household_id, name, member_type, is_admin) values ($1,'Adm','adult',true) returning id`, [hid])
  await client.query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`, [hid, adm.rows[0].id])
  const kid = await client.query<{ id: string }>(
    `insert into persons (household_id, name, member_type, is_admin) values ($1,'Kid','kid',false) returning id`, [hid])
  await client.query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kid',true)`, [hid, kid.rows[0].id])
  await client.end()
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('isNewer', () => {
  it('compares semver and ignores dev/invalid', () => {
    expect(isNewer('v0.2.0', '0.1.0')).toBe(true)
    expect(isNewer('0.1.1', '0.1.0')).toBe(true)
    expect(isNewer('0.1.0', '0.1.0')).toBe(false)
    expect(isNewer('0.1.0', '0.2.0')).toBe(false)
    expect(isNewer('v1.0.0', '0.0.0')).toBe(false) // unreleased dev build: never nag
    expect(isNewer('not-a-tag', '0.1.0')).toBe(false)
  })
})

describe('GET/PUT /api/updates', () => {
  it('403s for a non-admin', async () => {
    expect((await call('GET', '/api/updates', mint('dev|kid'))).statusCode).toBe(403)
  })

  it('reports enabled with current version (repo unset → no update, no network)', async () => {
    const res = await call('GET', '/api/updates', kevin)
    expect(res.statusCode).toBe(200)
    const b = JSON.parse(res.body)
    expect(b.enabled).toBe(true)
    expect(b.current.version).toBeTruthy()
    expect(b.updateAvailable).toBe(false)
    expect(b.error).toContain('UPDATE_CHECK_REPO')
  })

  it('honors the per-household toggle', async () => {
    let res = await call('PUT', '/api/updates/settings', kevin, { enabled: false })
    expect(res.statusCode).toBe(200)
    res = await call('GET', '/api/updates', kevin)
    expect(JSON.parse(res.body).enabled).toBe(false)
    // turn back on
    await call('PUT', '/api/updates/settings', kevin, { enabled: true })
    expect(JSON.parse((await call('GET', '/api/updates', kevin)).body).enabled).toBe(true)
  })

  it('validates the toggle body', async () => {
    expect((await call('PUT', '/api/updates/settings', kevin, { enabled: 'yes' })).statusCode).toBe(400)
  })

  it('respects the UPDATE_CHECK_ENABLED env kill-switch', async () => {
    process.env.UPDATE_CHECK_ENABLED = 'false'
    try {
      const b = JSON.parse((await call('GET', '/api/updates', kevin)).body)
      expect(b.enabled).toBe(false)
      expect(b.reason).toBe('env')
    } finally {
      delete process.env.UPDATE_CHECK_ENABLED
    }
  })
})
