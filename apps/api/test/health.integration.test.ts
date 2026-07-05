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

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let householdId = ''

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
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
  process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), 'waffled-media-'))
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

describe('GET /api/health — backup check', () => {
  async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = new Client({ connectionString: url })
    await c.connect()
    try {
      return await fn(c)
    } finally {
      await c.end()
    }
  }
  async function backupCheck() {
    const res = await call('GET', '/api/health', kevin)
    return JSON.parse(res.body)
  }

  it('is ok with no backup yet (enabled, nothing recorded)', async () => {
    await withClient((c) => c.query('delete from backup_runs'))
    const body = await backupCheck()
    expect(body.checks.backup.status).toBe('ok')
    expect(body.checks.backup.enabled).toBe(true)
    expect(body.checks.backup.lastBackupAt).toBeNull()
  })

  it('reports the last successful run and stays ok when recent', async () => {
    await withClient((c) =>
      c.query(
        `insert into backup_runs (status, finished_at, file_name, size_bytes)
         values ('success', now(), 'waffled-test.sql.gz', 1234)`
      )
    )
    const body = await backupCheck()
    expect(body.checks.backup.status).toBe('ok')
    expect(body.checks.backup.lastStatus).toBe('success')
    expect(body.checks.backup.lastSizeBytes).toBe(1234)
  })

  it('degrades when the last run failed', async () => {
    await withClient(async (c) => {
      await c.query('delete from backup_runs')
      await c.query(
        `insert into backup_runs (status, finished_at, error) values ('failed', now(), 'S3 upload failed')`
      )
    })
    const body = await backupCheck()
    expect(body.checks.backup.status).toBe('degraded')
    expect(body.checks.backup.error).toContain('S3')
    expect(body.status).toBe('degraded')
  })

  it('degrades when the last successful backup is stale (>48h)', async () => {
    await withClient(async (c) => {
      await c.query('delete from backup_runs')
      await c.query(
        `insert into backup_runs (status, finished_at, file_name) values ('success', now() - interval '3 days', 'old.sql.gz')`
      )
    })
    const body = await backupCheck()
    expect(body.checks.backup.status).toBe('degraded')
    expect(body.checks.backup.hint).toMatch(/ago/)
  })

  it('is ok and marked disabled when BACKUP_ENABLED=false', async () => {
    const saved = process.env.BACKUP_ENABLED
    process.env.BACKUP_ENABLED = 'false'
    try {
      // A failed row exists from the prior test, but disabled must win.
      const body = await backupCheck()
      expect(body.checks.backup.status).toBe('ok')
      expect(body.checks.backup.enabled).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.BACKUP_ENABLED
      else process.env.BACKUP_ENABLED = saved
    }
  })

  it('cleans up so later runs start fresh', async () => {
    await withClient((c) => c.query('delete from backup_runs'))
    const body = await backupCheck()
    expect(body.checks.backup.status).toBe('ok')
  })
})
