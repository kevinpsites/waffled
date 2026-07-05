// P2.4 of multi-household identity (docs/design/multi-household-identity.md §5.5,
// decision 1): invite-and-accept. An admin invites an existing account's email to
// their household; that creates a PENDING invite (not an instant membership). The
// invited account sees it on next login and accepts, which creates their membership
// (a persons row linked to their account). No one is attached without their OK.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { randomBytes } from 'node:crypto'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let query: any

let kevinToken = ''   // admin/owner of household A
let teenToken = ''    // non-admin member of household A
let householdA = ''
let householdB = ''
let bobAccountId = ''

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
const login = async (email: string, password: string) => json(await call('POST', '/api/auth/login', undefined, { email, password }))

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
  const { hashPassword } = await import('../src/modules/auth/auth')

  // Household A: owner Kevin + a non-admin teen, both with logins.
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'A', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  kevinToken = json(setup).accessToken
  householdA = (await query(`select household_id from persons where name='Kevin'`)).rows[0].household_id
  const teenId = json(await call('POST', '/api/persons', kevinToken, { name: 'Teeny', memberType: 'teen' })).person.id
  await call('PUT', `/api/persons/${teenId}/login`, kevinToken, { email: 'teen@example.com', password: 'teenpass12' })
  teenToken = (await login('teen@example.com', 'teenpass12')).accessToken

  // Household B with its own existing account, Bob (so bob@example.com is a real,
  // loginable account that already belongs to another household).
  householdB = (await query(`insert into households (name, timezone) values ('B','America/Chicago') returning id`)).rows[0].id
  const bobAcct = await query(
    `insert into accounts (email, password_hash, last_household_id) values ('bob@example.com',$1,$2) returning id`,
    [hashPassword('bobpass12'), householdB]
  )
  bobAccountId = bobAcct.rows[0].id
  await query(
    `insert into persons (household_id, name, member_type, is_admin, account_id) values ($1,'Bob','adult',true,$2) returning id`,
    [householdB, bobAccountId]
  )
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('P2.4 invite-and-accept', () => {
  let inviteId = ''

  it('an admin invites an existing account by email → a pending invite (201)', async () => {
    const r = await call('POST', '/api/households/invites', kevinToken, { email: 'bob@example.com', memberType: 'adult', isAdmin: false })
    expect(r.statusCode).toBe(201)
    inviteId = json(r).invite.id
    expect(inviteId).toBeTruthy()
    // it did NOT create a membership yet
    const members = await query(`select 1 from persons where household_id=$1 and account_id=$2 and deleted_at is null`, [householdA, bobAccountId])
    expect(members.rows).toHaveLength(0)
  })

  it('a non-admin cannot invite (403)', async () => {
    expect((await call('POST', '/api/households/invites', teenToken, { email: 'x@example.com' })).statusCode).toBe(403)
  })

  it('cannot invite someone already a member of the household (409)', async () => {
    expect((await call('POST', '/api/households/invites', kevinToken, { email: 'kevin@example.com' })).statusCode).toBe(409)
  })

  it('the invited account sees the pending invite on login and via GET /api/auth/invites', async () => {
    const d = await login('bob@example.com', 'bobpass12')
    expect(d.pendingInvites).toHaveLength(1)
    expect(d.pendingInvites[0]).toMatchObject({ householdId: householdA })
    const bobToken = d.accessToken

    const list = json(await call('GET', '/api/auth/invites', bobToken))
    expect(list.invites).toHaveLength(1)
    expect(list.invites[0]).toMatchObject({ id: inviteId, householdId: householdA, householdName: 'A' })
  })

  it('accepting creates the membership; the account can then switch into it', async () => {
    const bobToken = (await login('bob@example.com', 'bobpass12')).accessToken
    const acc = await call('POST', `/api/auth/invites/${inviteId}/accept`, bobToken)
    expect(acc.statusCode).toBe(201)

    // a membership in A now exists for Bob's account
    const m = await query(`select id, member_type, is_admin from persons where household_id=$1 and account_id=$2 and deleted_at is null`, [householdA, bobAccountId])
    expect(m.rows).toHaveLength(1)
    expect(m.rows[0].is_admin).toBe(false)

    // Bob can switch into A and is listed among A's people
    const sw = json(await call('POST', '/api/auth/switch', bobToken, { householdId: householdA }))
    expect(json(await call('GET', '/api/household', sw.accessToken)).household.name).toBe('A')
    const names = json(await call('GET', '/api/persons', sw.accessToken)).persons.map((p: { name: string }) => p.name)
    expect(names).toContain('Bob')

    // the invite is no longer pending
    expect((await login('bob@example.com', 'bobpass12')).pendingInvites).toHaveLength(0)
  })

  it('rejects accepting an invite addressed to a different email (403)', async () => {
    // a fresh invite for carol, but Bob (logged in) tries to accept it
    const carolInvite = json(await call('POST', '/api/households/invites', kevinToken, { email: 'carol@example.com' })).invite.id
    const bobToken = (await login('bob@example.com', 'bobpass12')).accessToken
    expect((await call('POST', `/api/auth/invites/${carolInvite}/accept`, bobToken)).statusCode).toBe(403)
  })

  it('an admin can revoke a pending invite', async () => {
    const r = json(await call('POST', '/api/households/invites', kevinToken, { email: 'dave@example.com' }))
    const id = r.invite.id
    expect((await call('DELETE', `/api/households/invites/${id}`, kevinToken)).statusCode).toBeLessThan(300)
    // revoked invites don't show in the household's pending list
    const list = json(await call('GET', '/api/households/invites', kevinToken))
    expect(list.invites.find((i: { id: string }) => i.id === id)).toBeUndefined()
  })
})
