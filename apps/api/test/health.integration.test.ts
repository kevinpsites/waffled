// Deep health endpoint — migration + api + admin gating, over the in-process app
// against a real Postgres testcontainer. Mirrors the harness in chores.integration.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client } from 'pg'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'nook-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let householdId = ''

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'nook-local', audience: 'nook-api', expiresIn: '1h' })
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
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  // A writable media dir so the storage check passes in CI.
  process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), 'nook-media-'))
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool

  // Seed an admin household + a kid directly (provisioning needs a body; the DB
  // seed is simpler and gives us both an admin and a non-admin identity).
  const client = new Client({ connectionString: url })
  await client.connect()
  const hh = await client.query<{ id: string }>(
    `insert into households (name, timezone) values ('H','UTC') returning id`
  )
  householdId = hh.rows[0].id
  const adm = await client.query<{ id: string }>(
    `insert into persons (household_id, name, member_type, is_admin) values ($1,'Adm','adult',true) returning id`,
    [householdId]
  )
  await client.query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [householdId, adm.rows[0].id]
  )
  const kid = await client.query<{ id: string }>(
    `insert into persons (household_id, name, member_type, is_admin) values ($1,'Kid','kid',false) returning id`,
    [householdId]
  )
  await client.query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kid',true)`,
    [householdId, kid.rows[0].id]
  )
  await client.end()
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('GET /api/health', () => {
  it('reports ok for an admin on a healthy, migrated stack', async () => {
    const res = await call('GET', '/api/health', kevin)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('ok')
    expect(body.checks.db.status).toBe('ok')
    expect(body.checks.migrations.status).toBe('ok')
    expect(body.checks.migrations.applied).toBeGreaterThan(0)
    expect(body.checks.storage.status).toBe('ok')
    expect(body.version.sha).toBeTruthy()
  })

  it('403s for a non-admin member', async () => {
    const res = await call('GET', '/api/health', mint('dev|kid'))
    expect(res.statusCode).toBe(403)
  })

  it('degrades when the media dir is not writable', async () => {
    const saved = process.env.MEDIA_DIR
    process.env.MEDIA_DIR = '/proc/nonexistent/cannot-write-here'
    try {
      const res = await call('GET', '/api/health', kevin)
      const body = JSON.parse(res.body)
      expect(body.checks.storage.status).toBe('degraded')
      expect(body.status).toBe('degraded')
    } finally {
      process.env.MEDIA_DIR = saved
    }
  })
})
