// P4 of multi-household identity — operator CLI made account-aware. A human is now
// one account that may belong to many households (one persons row each), so:
//   - reset-password / prune-sessions must revoke sessions across ALL the account's
//     memberships, not just the credential's person, and reset keeps accounts.password_hash current.
//   - add-member attaches an existing account to another household (break-glass).
//   - list-accounts shows one human → all their households.
// Drives the CLI command functions directly (like admin-cli.integration.test.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { randomBytes } from 'node:crypto'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let dbUrl = ''
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cmds: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let query: any

let kevinAccountId = ''
let wallyAccountId = ''
let householdA = ''
let householdB = ''

interface RunResult { statusCode: number; body: string }
function call(method: string, path: string, token?: string, body?: unknown): Promise<RunResult> {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}
const json = (r: RunResult) => JSON.parse(r.body)

// Drive a CLI command by setting argv + dispatching to the exported _cmds.
async function run(...cliArgs: string[]): Promise<void> {
  const saved = process.argv
  process.argv = ['node', 'admin', ...cliArgs]
  try {
    const [name] = cliArgs
    if (name === 'reset-password') return await cmds.resetPassword()
    if (name === 'prune-sessions') return await cmds.pruneSessions()
    if (name === 'add-member') return await cmds.addMember()
    if (name === 'list-accounts') return await cmds.listAccounts()
    throw new Error(`unknown test command ${name}`)
  } finally {
    process.argv = saved
  }
}

const activeSessions = async (accountId: string): Promise<number> =>
  (await query(
    `select count(*)::int n from refresh_tokens
      where revoked_at is null and person_id in (select id from persons where account_id = $1)`,
    [accountId]
  )).rows[0].n

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  dbUrl = pg.getConnectionUri()
  await runMigrations(dbUrl)

  process.env.VITEST = '1'
  process.env.DATABASE_URL = dbUrl
  delete process.env.AUTH0_DOMAIN
  process.env.LOCAL_JWT_SECRET = SECRET
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64')

  app = (await import('../src/app')).default
  ;({ query, closePool } = await import('../src/platform/db'))
  cmds = (await import('../scripts/admin'))._cmds
  const { hashPassword } = await import('../src/modules/auth/auth')

  // Household A + owner Kevin.
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'A', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  kevinAccountId = (await query(`select id from accounts where lower(email)='kevin@example.com' and deleted_at is null`)).rows[0].id
  householdA = (await query(`select household_id from persons where name='Kevin'`)).rows[0].household_id

  // Kevin's 2nd membership (household B).
  householdB = (await query(`insert into households (name, timezone) values ('B','America/Chicago') returning id`)).rows[0].id
  await query(`insert into persons (household_id, name, member_type, is_admin, account_id) values ($1,'KevinB','adult',true,$2)`, [householdB, kevinAccountId])

  // A separate existing account, Wally (lives in household B), for add-member.
  const wp = await query(
    `insert into accounts (email, password_hash, last_household_id) values ('wally@example.com',$1,$2) returning id`,
    [hashPassword('wallypass1'), householdB]
  )
  wallyAccountId = wp.rows[0].id
  await query(`insert into persons (household_id, name, member_type, account_id) values ($1,'Wally','adult',$2)`, [householdB, wallyAccountId])
}, 60_000)

afterAll(async () => {
  delete process.env.VITEST
  await closePool?.()
  await pg?.stop()
})

describe('P4.1 account-scoped reset-password + prune-sessions', () => {
  it('reset-password revokes sessions across ALL the account memberships and lets the new password log in', async () => {
    // Kevin signs in (session on membership A), then switches to B (session on membership B).
    const login = json(await call('POST', '/api/auth/login', undefined, { email: 'kevin@example.com', password: 'ownerpass1' }))
    await call('POST', '/api/auth/switch', login.accessToken, { householdId: householdB })
    expect(await activeSessions(kevinAccountId)).toBeGreaterThanOrEqual(2)

    await run('reset-password', '--email', 'kevin@example.com', '--password', 'brandnew123', '--yes')

    // every membership's session is revoked
    expect(await activeSessions(kevinAccountId)).toBe(0)
    // the new password works; the old one does not
    expect((await call('POST', '/api/auth/login', undefined, { email: 'kevin@example.com', password: 'ownerpass1' })).statusCode).toBe(401)
    expect((await call('POST', '/api/auth/login', undefined, { email: 'kevin@example.com', password: 'brandnew123' })).statusCode).toBe(200)
    // the accounts mirror is kept current
    const acct = await query(`select password_hash from accounts where id=$1`, [kevinAccountId])
    expect(acct.rows[0].password_hash).toBeTruthy()
    const { verifyPassword } = await import('../src/modules/auth/auth')
    expect(verifyPassword('brandnew123', acct.rows[0].password_hash)).toBe(true)
  })

  it('prune-sessions --email revokes across all of the account memberships', async () => {
    const login = json(await call('POST', '/api/auth/login', undefined, { email: 'kevin@example.com', password: 'brandnew123' }))
    await call('POST', '/api/auth/switch', login.accessToken, { householdId: householdB })
    expect(await activeSessions(kevinAccountId)).toBeGreaterThanOrEqual(2)
    await run('prune-sessions', '--email', 'kevin@example.com', '--yes')
    expect(await activeSessions(kevinAccountId)).toBe(0)
  })
})

describe('P4.2 add-member + list-accounts', () => {
  it('add-member attaches an existing account to another household', async () => {
    // Wally is not yet in household A.
    expect((await query(`select 1 from persons where household_id=$1 and account_id=$2 and deleted_at is null`, [householdA, wallyAccountId])).rows).toHaveLength(0)
    await run('add-member', '--email', 'wally@example.com', '--household-id', householdA, '--yes')
    const m = await query(`select id, member_type, is_admin from persons where household_id=$1 and account_id=$2 and deleted_at is null`, [householdA, wallyAccountId])
    expect(m.rows).toHaveLength(1)
  })

  it('add-member is idempotent for an existing member (no duplicate)', async () => {
    await run('add-member', '--email', 'wally@example.com', '--household-id', householdA, '--yes')
    const m = await query(`select id from persons where household_id=$1 and account_id=$2 and deleted_at is null`, [householdA, wallyAccountId])
    expect(m.rows).toHaveLength(1)
  })

  it('add-member exits non-zero when no account uses the email', async () => {
    const saved = process.exit
    let code: number | undefined
    process.exit = ((c?: number): never => { code = c; throw new Error('exit') }) as typeof process.exit
    try {
      await run('add-member', '--email', 'nobody@example.com', '--household-id', householdA, '--yes').catch(() => {})
    } finally {
      process.exit = saved
    }
    expect(code).toBe(1)
  })

  it('list-accounts shows a human and all their households', async () => {
    const lines: string[] = []
    const origLog = console.log
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')) }
    try {
      await run('list-accounts')
    } finally {
      console.log = origLog
    }
    const out = lines.join('\n')
    expect(out).toContain('kevin@example.com')
    // Kevin belongs to both A and B
    expect(out).toMatch(/A/)
    expect(out).toMatch(/B/)
  })
})
