// Self-service account API — GET /api/account plus PUT profile/password/email,
// over the in-process app against a real Postgres testcontainer. Mirrors the
// harness in familyNight.integration / health.integration.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'nook-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let householdId = ''
let kidId = ''

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'nook-local', audience: 'nook-api', expiresIn: '1h' })
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
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}

const admin = mint('dev|admin')
const kid = mint('dev|kid')

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
  const { query } = await import('../src/platform/db')
  const { hashPassword } = await import('../src/modules/auth/auth')

  // First-run: household + admin owner. Setup creates the account with a password
  // hash for the given password, so the admin has a real password login.
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'secret123' },
  })
  const setupBody = JSON.parse(setup.body)
  householdId = setupBody.household.id
  const adminPersonId = setupBody.person.id
  const accountRow = await query<{ id: string }>(
    `select id from accounts where lower(email) = lower('kevin@example.com') and deleted_at is null`
  )
  const accountId = accountRow.rows[0].id

  // A password identity so the admin's legacy-sub token (dev|admin) resolves to the
  // admin person, linked to the account (so email mirror-onto-identity is exercised).
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email, email_verified, is_primary, account_id)
     values ($1,$2,'password','dev|admin','kevin@example.com',true,true,$3)`,
    [householdId, adminPersonId, accountId]
  )

  // A kid with NO login (account_id null). Its identity is provider='password' but
  // carries no account, and the kid person has account_id null → hasAccount false.
  const kidPerson = await query<{ id: string }>(
    `insert into persons (household_id, name, member_type, is_admin) values ($1,'Wally','kid',false) returning id`,
    [householdId]
  )
  kidId = kidPerson.rows[0].id
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kid',true)`,
    [householdId, kidId]
  )

  // A SECOND account (a member of another household) whose email we can collide with.
  await query(
    `insert into accounts (email, password_hash) values ('taken@example.com', $1)`,
    [hashPassword('secret123')]
  )
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('account API', () => {
  it('GET /api/account for the admin: full account + profile', async () => {
    const res = await call('GET', '/api/account', admin)
    expect(res.statusCode).toBe(200)
    const a = JSON.parse(res.body)
    expect(a.name).toBe('Kevin')
    expect(a.isAdmin).toBe(true)
    expect(a.memberType).toBe('adult')
    expect(a.hasAccount).toBe(true)
    expect(a.email).toBe('kevin@example.com')
    expect(a.hasPassword).toBe(true)
    expect(a.provider).toBe('password')
  })

  it('GET /api/account for the kid: no login', async () => {
    const res = await call('GET', '/api/account', kid)
    expect(res.statusCode).toBe(200)
    const a = JSON.parse(res.body)
    expect(a.name).toBe('Wally')
    expect(a.hasAccount).toBe(false)
    expect(a.email).toBeNull()
    expect(a.hasPassword).toBe(false)
    expect(a.provider).toBe('none')
  })

  it('PUT /api/account/profile updates name + color, reflected in GET', async () => {
    const bad = await call('PUT', '/api/account/profile', admin, { name: '   ' })
    expect(bad.statusCode).toBe(400)

    const ok = await call('PUT', '/api/account/profile', admin, { name: 'Kevin S', colorHex: '#ff0088' })
    expect(ok.statusCode).toBe(200)
    expect(JSON.parse(ok.body).ok).toBe(true)

    const after = JSON.parse((await call('GET', '/api/account', admin)).body)
    expect(after.name).toBe('Kevin S')
    expect(after.colorHex).toBe('#ff0088')
  })

  it('PUT /api/account/password: wrong current 403, short new 400, correct 200 then login works', async () => {
    expect((await call('PUT', '/api/account/password', admin, { currentPassword: 'nope', newPassword: 'brandnew1' })).statusCode).toBe(403)
    expect((await call('PUT', '/api/account/password', admin, { currentPassword: 'secret123', newPassword: 'short' })).statusCode).toBe(400)

    const ok = await call('PUT', '/api/account/password', admin, { currentPassword: 'secret123', newPassword: 'brandnew1' })
    expect(ok.statusCode).toBe(200)

    // The new password authenticates through the real login path (proves it took).
    const login = await call('POST', '/api/auth/login', undefined, { email: 'kevin@example.com', password: 'brandnew1' })
    expect(login.statusCode).toBe(200)
    expect(JSON.parse(login.body).accessToken).toBeTruthy()
  })

  it("PUT /api/account/password on a no-login kid: 400", async () => {
    expect((await call('PUT', '/api/account/password', kid, { currentPassword: 'x', newPassword: 'brandnew1' })).statusCode).toBe(400)
  })

  it('PUT /api/account/email: wrong current 403, duplicate 409, valid 200 then GET reflects it', async () => {
    // Current password is now 'brandnew1' (changed above).
    expect((await call('PUT', '/api/account/email', admin, { email: 'new@example.com', currentPassword: 'wrong' })).statusCode).toBe(403)
    expect((await call('PUT', '/api/account/email', admin, { email: 'taken@example.com', currentPassword: 'brandnew1' })).statusCode).toBe(409)

    const ok = await call('PUT', '/api/account/email', admin, { email: 'kevin2@example.com', currentPassword: 'brandnew1' })
    expect(ok.statusCode).toBe(200)

    const after = JSON.parse((await call('GET', '/api/account', admin)).body)
    expect(after.email).toBe('kevin2@example.com')
  })
})
