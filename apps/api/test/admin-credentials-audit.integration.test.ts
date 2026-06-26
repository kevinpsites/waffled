// Pre-migration gate for retiring the legacy `credentials` table: the read-only
// `./nook admin audit-credentials` command must report 0 gaps when every active
// credential is mirrored into `accounts`, and flag (exit 1) when a credential has no
// matching account or its person isn't linked. Drives the exported _cmds directly.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { randomBytes } from 'node:crypto'
import { runMigrations } from '../src/migrate'

const SECRET = 'nook-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cmds: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let query: any
let householdA = ''

interface RunResult { statusCode: number; body: string }
function call(method: string, path: string, body?: unknown): Promise<RunResult> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}

// Capture console.log output + the resulting process.exitCode for one audit run.
async function audit(): Promise<{ out: string; code: number | undefined }> {
  const lines: string[] = []
  const orig = console.log
  console.log = (...a: unknown[]) => { lines.push(a.join(' ')) }
  process.exitCode = 0
  try {
    await cmds.auditCredentials()
  } finally {
    console.log = orig
  }
  // eslint-disable-next-line no-control-regex
  return { out: lines.join('\n').replace(/\x1b\[[0-9;]*m/g, ''), code: process.exitCode }
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const dbUrl = pg.getConnectionUri()
  await runMigrations(dbUrl)

  process.env.VITEST = '1'
  process.env.DATABASE_URL = dbUrl
  delete process.env.AUTH0_DOMAIN
  process.env.LOCAL_JWT_SECRET = SECRET
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64')

  app = (await import('../src/app')).default
  ;({ query, closePool } = await import('../src/platform/db'))
  cmds = (await import('../scripts/admin'))._cmds

  // A clean first-run setup creates a credential + matching account + linked person.
  const setup = await call('POST', '/api/auth/setup', {
    household: { name: 'A', timezone: 'America/Chicago' },
    admin: { name: 'Owner', email: 'owner@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  householdA = (await query(`select id from households where name = 'A'`)).rows[0].id
}, 60_000)

afterAll(async () => {
  delete process.env.VITEST
  await closePool?.()
  await pg?.stop()
})

beforeEach(() => { process.exitCode = 0 })

describe('admin audit-credentials', () => {
  it('reports an airtight backfill (all zeros, exit 0) for a clean instance', async () => {
    const { out, code } = await audit()
    expect(out).toContain('creds whose email has NO active account .... 0')
    expect(out).toContain('creds w/ password but account hash MISMATCH  0')
    expect(out).toContain('persons w/ active credential, NULL account_id 0')
    expect(out).toContain('airtight')
    expect(code === 0 || code === undefined).toBe(true)
  })

  it('flags a credential with no matching account / unlinked person (exit 1)', async () => {
    // Seed a legacy-style gap: a person with no account_id + a credential whose email
    // exists in NO account.
    const per = await query(`insert into persons (household_id, name, member_type) values ($1,'Gap','kid') returning id`, [householdA])
    await query(
      `insert into credentials (household_id, person_id, email, password_hash) values ($1,$2,'gap@example.com',$3)`,
      [householdA, per.rows[0].id, 'scrypt$deadbeef$cafe']
    )
    const { out, code } = await audit()
    expect(out).toMatch(/creds whose email has NO active account \.\.\.\. [1-9]/)
    expect(out).toMatch(/persons w\/ active credential, NULL account_id [1-9]/)
    expect(out).toContain('Gaps found')
    expect(code).toBe(1)
  })
})
