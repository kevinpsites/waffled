// P3a of multi-household identity: GET /api/household also returns the account's
// memberships[] + pendingInvites[], so the web client can render a household
// switcher and pending-invite prompt after any page reload (today those only ride
// the login response). account-less callers (kiosk/device) get empty arrays.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { randomBytes } from 'node:crypto'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let query: any

let kevinToken = ''
let teenToken = ''
let kevinAccountId = ''
let householdA = ''
let householdB = ''
let householdC = ''

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

  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'A', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  kevinAccountId = (await query(`select id from accounts where lower(email)='kevin@example.com' and deleted_at is null`)).rows[0].id
  householdA = (await query(`select household_id from persons where name='Kevin'`)).rows[0].household_id
  kevinToken = (await login('kevin@example.com', 'ownerpass1')).accessToken

  // A non-admin member of A with a login (single membership, no invites).
  const teenId = json(await call('POST', '/api/persons', kevinToken, { name: 'Teeny', memberType: 'teen' })).person.id
  await call('PUT', `/api/persons/${teenId}/login`, kevinToken, { email: 'teen@example.com', password: 'teenpass12' })
  teenToken = (await login('teen@example.com', 'teenpass12')).accessToken

  // Kevin gets a 2nd membership (household B) + a pending invite to a 3rd (household C).
  householdB = (await query(`insert into households (name, timezone) values ('B','America/Chicago') returning id`)).rows[0].id
  await query(`insert into persons (household_id, name, member_type, is_admin, account_id) values ($1,'KevinB','adult',true,$2)`, [householdB, kevinAccountId])
  householdC = (await query(`insert into households (name, timezone) values ('C','America/Chicago') returning id`)).rows[0].id
  await query(`insert into household_invites (household_id, email, member_type, is_admin) values ($1,'kevin@example.com','adult',false)`, [householdC])
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('P3a GET /api/household — memberships + pendingInvites', () => {
  it('returns all of the account memberships and pending invites', async () => {
    const d = json(await call('GET', '/api/household', kevinToken))
    expect(d.provisioned).toBe(true)
    expect(Array.isArray(d.memberships)).toBe(true)
    expect(d.memberships.map((m: { householdId: string }) => m.householdId).sort()).toEqual([householdA, householdB].sort())
    const a = d.memberships.find((m: { householdId: string }) => m.householdId === householdA)
    expect(a).toMatchObject({ householdName: 'A', isAdmin: true })
    expect(a.personId).toBeTruthy()

    expect(d.pendingInvites).toHaveLength(1)
    expect(d.pendingInvites[0]).toMatchObject({ householdId: householdC, householdName: 'C' })
  })

  it('a single-membership member sees one membership and no invites', async () => {
    const d = json(await call('GET', '/api/household', teenToken))
    expect(d.memberships).toHaveLength(1)
    expect(d.memberships[0]).toMatchObject({ householdId: householdA, isAdmin: false })
    expect(d.pendingInvites).toEqual([])
  })
})
