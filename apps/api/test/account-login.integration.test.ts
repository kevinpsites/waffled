// P2.2 of multi-household identity (docs/design/multi-household-identity.md §5.3):
// password login authenticates the *account*, mints an account-scoped token
// (sub = account.id + active-household claim), lands on the last-active household,
// and returns the membership list (+ a pending-invites field for P2.4). Single-
// membership accounts behave exactly as today (no forced picker). Refresh re-mints
// account-scoped tokens and UPGRADES in-flight legacy refresh tokens.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'nook-local-dev-secret-change-me'
const HH_CLAIM = 'https://nook.app/household_id'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let query: any

let ownerToken = ''
let kevinAccountId = ''
let wallyPersonId = ''
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
const decode = (t: string) => jwt.decode(t) as { sub: string; [k: string]: unknown }

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  process.env.LOCAL_JWT_SECRET = SECRET
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64')

  app = (await import('../src/app')).default
  ;({ query, closePool } = await import('../src/platform/db'))

  // Household A + owner Kevin.
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'A', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  ownerToken = json(setup).accessToken

  const acct = await query(`select id from accounts where lower(email) = 'kevin@example.com' and deleted_at is null`)
  kevinAccountId = acct.rows[0].id
  householdA = (await query(`select household_id from persons where name = 'Kevin'`)).rows[0].household_id

  // Member Wally — added post-provision (so his person starts WITHOUT an account_id;
  // login must lazily create + link one).
  wallyPersonId = json(await call('POST', '/api/persons', ownerToken, { name: 'Wally', memberType: 'adult' })).person.id
  expect((await call('PUT', `/api/persons/${wallyPersonId}/login`, ownerToken, { email: 'wally@example.com', password: 'wallypass1' })).statusCode).toBeLessThan(300)

  // A SECOND membership for Kevin in household B (wired directly; the join flow is P2.4).
  const hb = await query(`insert into households (name, timezone) values ('B','America/Chicago') returning id`)
  householdB = hb.rows[0].id
  await query(`insert into persons (household_id, name, member_type, is_admin, account_id) values ($1,'KevinB','adult',true,$2)`, [householdB, kevinAccountId])
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('P2.2 account login', () => {
  it('mints an account-scoped token and returns all memberships', async () => {
    const d = json(await call('POST', '/api/auth/login', undefined, { email: 'kevin@example.com', password: 'ownerpass1' }))
    const claims = decode(d.accessToken)
    expect(claims.sub).toBe(kevinAccountId)
    expect([householdA, householdB]).toContain(claims[HH_CLAIM])
    // both memberships are reported so the client can offer a switcher
    expect(Array.isArray(d.memberships)).toBe(true)
    const hhIds = d.memberships.map((m: { householdId: string }) => m.householdId).sort()
    expect(hhIds).toEqual([householdA, householdB].sort())
    expect(d.memberships.find((m: { householdId: string }) => m.householdId === householdA)).toMatchObject({ isAdmin: true })
    // pending-invites field exists (empty for now; populated in P2.4)
    expect(Array.isArray(d.pendingInvites)).toBe(true)
  })

  it('lands on the last-active household', async () => {
    // point last-active at B, then A, and confirm the claim follows
    await query(`update accounts set last_household_id = $1 where id = $2`, [householdB, kevinAccountId])
    let d = json(await call('POST', '/api/auth/login', undefined, { email: 'kevin@example.com', password: 'ownerpass1' }))
    expect(decode(d.accessToken)[HH_CLAIM]).toBe(householdB)
    // and the token actually resolves to B
    expect(json(await call('GET', '/api/household', d.accessToken)).household.name).toBe('B')

    await query(`update accounts set last_household_id = $1 where id = $2`, [householdA, kevinAccountId])
    d = json(await call('POST', '/api/auth/login', undefined, { email: 'kevin@example.com', password: 'ownerpass1' }))
    expect(decode(d.accessToken)[HH_CLAIM]).toBe(householdA)
    expect(json(await call('GET', '/api/household', d.accessToken)).household.name).toBe('A')
  })

  it('single-membership member: lazily creates+links an account and logs in', async () => {
    const before = await query(`select account_id from persons where id = $1`, [wallyPersonId])
    expect(before.rows[0].account_id).toBeNull() // added post-provision

    const d = json(await call('POST', '/api/auth/login', undefined, { email: 'wally@example.com', password: 'wallypass1' }))
    expect(d.accessToken).toBeTruthy()
    expect(d.memberships).toHaveLength(1)
    expect(d.memberships[0].householdId).toBe(householdA)

    // the account now exists and the person is linked
    const after = await query(`select p.account_id, a.email from persons p join accounts a on a.id = p.account_id where p.id = $1`, [wallyPersonId])
    expect(after.rows[0].account_id).toBeTruthy()
    expect(after.rows[0].email.toLowerCase()).toBe('wally@example.com')
    // sub is the account id, claim is household A, and it authorizes a request
    expect(decode(d.accessToken).sub).toBe(after.rows[0].account_id)
    expect(json(await call('GET', '/api/household', d.accessToken)).household.name).toBe('A')
  })

  it('rejects a wrong password and a missing field (unchanged)', async () => {
    expect((await call('POST', '/api/auth/login', undefined, { email: 'kevin@example.com', password: 'nope' })).statusCode).toBe(401)
    expect((await call('POST', '/api/auth/login', undefined, { email: 'kevin@example.com' })).statusCode).toBe(400)
  })

  it('refresh re-mints an account-scoped token that still resolves', async () => {
    const login = json(await call('POST', '/api/auth/login', undefined, { email: 'wally@example.com', password: 'wallypass1' }))
    const r = json(await call('POST', '/api/auth/refresh', undefined, { refreshToken: login.refreshToken }))
    const claims = decode(r.accessToken)
    expect(claims[HH_CLAIM]).toBe(householdA)
    expect(json(await call('GET', '/api/household', r.accessToken)).household.name).toBe('A')
  })

  it('upgrades an in-flight legacy refresh token (subject = credential id) to account-scoped', async () => {
    // Forge a pre-P2 refresh token: subject is the credential id, not the account id.
    const cred = await query(`select id, person_id from credentials where lower(email) = 'wally@example.com' and deleted_at is null`)
    const credId = cred.rows[0].id
    const personId = cred.rows[0].person_id
    const rawToken = randomBytes(32).toString('base64url')
    const tokenHash = (await import('../src/modules/auth/auth')).sha256(rawToken)
    await query(
      `insert into refresh_tokens (person_id, subject, token_hash, expires_at) values ($1,$2,$3, now() + interval '60 days')`,
      [personId, credId, tokenHash]
    )

    const r = json(await call('POST', '/api/auth/refresh', undefined, { refreshToken: rawToken }))
    const claims = decode(r.accessToken)
    // upgraded: sub is now the account id (not the credential id), claim is the household
    const acct = await query(`select account_id from persons where id = $1`, [personId])
    expect(claims.sub).toBe(acct.rows[0].account_id)
    expect(claims.sub).not.toBe(credId)
    expect(claims[HH_CLAIM]).toBe(householdA)
    // and it authorizes a request
    expect(json(await call('GET', '/api/household', r.accessToken)).household.name).toBe('A')
  })
})
