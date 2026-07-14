// Admin CLI (scripts/admin.ts) — exercises the operator/break-glass commands
// against a real Testcontainers Postgres. The command functions are imported
// directly (the module skips its auto-run under VITEST) and driven by setting
// process.argv per call, just like the real CLI parses it. DATABASE_URL +
// LOCAL_JWT_SECRET + TOKEN_ENCRYPTION_KEY must be set BEFORE importing the app or
// the admin module (both build their pool/config at import).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
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
let memberId = ''

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}

interface RunResult { statusCode: number; body: string }
function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}

// Drive a CLI command exactly as argv would: process.argv = [node, admin, ...args].
async function run(...cliArgs: string[]): Promise<void> {
  const saved = process.argv
  process.argv = ['node', 'admin', ...cliArgs]
  try {
    const [name] = cliArgs
    if (name === 'list-members') return await cmds.listMembers()
    if (name === 'reset-password') return await cmds.resetPassword()
    if (name === 'make-admin') return await cmds.makeAdmin(true)
    if (name === 'revoke-admin') return await cmds.makeAdmin(false)
    if (name === 'password-login') return await cmds.passwordLogin()
    if (name === 'clear-calendar-error') return await cmds.clearCalendarError()
    if (name === 'prune-sessions') return await cmds.pruneSessions()
    if (name === 'regenerate-powersync-key') return cmds.regeneratePowerSyncKey()
    if (name === 'list-households') return await cmds.listHouseholds()
    if (name === 'delete-household') return await cmds.deleteHousehold()
    throw new Error(`unknown test command ${name}`)
  } finally {
    process.argv = saved
  }
}

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

  // First-run setup → household + owner admin (email/password).
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  const ownerToken = JSON.parse(setup.body).accessToken as string

  // A second member with a login (email + password), not an admin.
  memberId = JSON.parse((await call('POST', '/api/persons', ownerToken, { name: 'Wally', memberType: 'teen', colorHex: '#4477CC' })).body).person.id
  expect((await call('PUT', `/api/persons/${memberId}/login`, ownerToken, { email: 'wally@example.com', password: 'wallypass1' })).statusCode).toBeLessThan(300)
}, 60_000)

afterAll(async () => {
  delete process.env.VITEST
  await closePool?.()
  await pg?.stop()
})

describe('admin CLI', () => {
  it('list-members prints each member (smoke)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await run('list-members')
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n')
    spy.mockRestore()
    expect(out).toMatch(/Kevin/)
    expect(out).toMatch(/Wally/)
    expect(out).toMatch(/wally@example\.com/)
  })

  it('reset-password sets a new password and revokes sessions', async () => {
    // Establish a live session for Wally first.
    expect((await call('POST', '/api/auth/login', undefined, { email: 'wally@example.com', password: 'wallypass1' })).statusCode).toBe(200)
    const before = await query(`select count(*)::int as n from refresh_tokens where person_id = $1 and revoked_at is null`, [memberId])
    expect(before.rows[0].n).toBeGreaterThan(0)

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await run('reset-password', '--email', 'wally@example.com', '--password', 'brandnew9', '--yes')
    log.mockRestore()

    // New password works, old one doesn't.
    expect((await call('POST', '/api/auth/login', undefined, { email: 'wally@example.com', password: 'brandnew9' })).statusCode).toBe(200)
    expect((await call('POST', '/api/auth/login', undefined, { email: 'wally@example.com', password: 'wallypass1' })).statusCode).toBe(401)
    // Sessions from before the reset were revoked.
    const after = await query(`select count(*)::int as n from refresh_tokens where person_id = $1 and revoked_at is null`, [memberId])
    // (the fresh login above created one) — but the pre-reset token is revoked
    const revoked = await query(`select count(*)::int as n from refresh_tokens where person_id = $1 and revoked_at is not null`, [memberId])
    expect(revoked.rows[0].n).toBeGreaterThan(0)
    expect(after.rows[0].n).toBe(1)
  })

  it('make-admin / revoke-admin toggles is_admin', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await run('make-admin', '--email', 'wally@example.com')
    expect((await query(`select is_admin from persons where id = $1`, [memberId])).rows[0].is_admin).toBe(true)
    await run('revoke-admin', '--person', memberId)
    expect((await query(`select is_admin from persons where id = $1`, [memberId])).rows[0].is_admin).toBe(false)
    log.mockRestore()
  })

  it('password-login on/off flips the auth_config flag', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await run('password-login', 'off')
    expect((await query(`select password_login_enabled from auth_config where id = true`)).rows[0].password_login_enabled).toBe(false)
    await run('password-login', 'on')
    expect((await query(`select password_login_enabled from auth_config where id = true`)).rows[0].password_login_enabled).toBe(true)
    log.mockRestore()
  })

  it('clear-calendar-error clears a stuck account flag', async () => {
    const hh = (await query(`select household_id from persons where id = $1`, [memberId])).rows[0].household_id
    await query(
      `insert into calendar_accounts (household_id, google_sub, email, scope, refresh_token_encrypted, last_sync_error, last_sync_error_at)
       values ($1, 'sub-stuck', 'stuck@example.com', 'calendar', 'x', 'invalid_grant: revoked', now())`,
      [hh]
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await run('clear-calendar-error', '--all', '--yes')
    log.mockRestore()
    const row = await query(`select last_sync_error from calendar_accounts where google_sub = 'sub-stuck'`)
    expect(row.rows[0].last_sync_error).toBeNull()
  })

  it('prune-sessions revokes a member’s active tokens', async () => {
    expect((await call('POST', '/api/auth/login', undefined, { email: 'wally@example.com', password: 'brandnew9' })).statusCode).toBe(200)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await run('prune-sessions', '--email', 'wally@example.com', '--yes')
    log.mockRestore()
    const live = await query(`select count(*)::int as n from refresh_tokens where person_id = $1 and revoked_at is null`, [memberId])
    expect(live.rows[0].n).toBe(0)
  })

  it('list-households shows households with counts', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await run('list-households')
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n')
    spy.mockRestore()
    expect(out).toMatch(/Sites/)
    expect(out).toMatch(/member/)
  })

  it('delete-household removes a household and all its scoped rows', async () => {
    // A throwaway household with a person + a list (carries household_id) and no logins.
    const hh = (await query(`insert into households (name, timezone) values ('Junk', 'America/Chicago') returning id`)).rows[0].id
    const pid = (await query(`insert into persons (household_id, name, member_type) values ($1, 'Temp', 'adult') returning id`, [hh])).rows[0].id
    await query(`insert into lists (household_id, name, list_type) values ($1, 'Scratch', 'custom')`, [hh])
    expect((await query(`select 1 from households where id = $1`, [hh])).rowCount).toBe(1)

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await run('delete-household', '--id', hh, '--yes')
    log.mockRestore()

    expect((await query(`select 1 from households where id = $1`, [hh])).rowCount).toBe(0)
    expect((await query(`select 1 from persons where id = $1`, [pid])).rowCount).toBe(0)
    expect((await query(`select 1 from lists where household_id = $1`, [hh])).rowCount).toBe(0)
    // The real household is untouched.
    expect((await query(`select 1 from persons where id = $1`, [memberId])).rowCount).toBe(1)
  })

  it('regenerate-powersync-key prints a base64 PEM env line', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await run('regenerate-powersync-key')
    const out = spy.mock.calls.map((c) => c.join(' ')).join('\n')
    spy.mockRestore()
    const m = out.match(/POWERSYNC_JWT_PRIVATE_KEY=([A-Za-z0-9+/=]+)/)
    expect(m).toBeTruthy()
    const pem = Buffer.from(m![1], 'base64').toString('utf8')
    expect(pem).toContain('BEGIN PRIVATE KEY')
  })
})
