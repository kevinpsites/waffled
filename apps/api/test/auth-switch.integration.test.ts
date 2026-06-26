// P2.3 of multi-household identity (docs/design/multi-household-identity.md §5.4):
// POST /api/auth/switch — given a valid account session, mint a fresh access+refresh
// pair for another household the account belongs to, and remember it as last-active.
// 403 if the account isn't a member of the target.
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

let kevinToken = ''
let kevinAccountId = ''
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

  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'A', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  kevinAccountId = (await query(`select id from accounts where lower(email)='kevin@example.com' and deleted_at is null`)).rows[0].id
  householdA = (await query(`select household_id from persons where name='Kevin'`)).rows[0].household_id

  // Second membership in household B.
  householdB = (await query(`insert into households (name, timezone) values ('B','America/Chicago') returning id`)).rows[0].id
  await query(`insert into persons (household_id, name, member_type, is_admin, account_id) values ($1,'KevinB','adult',true,$2)`, [householdB, kevinAccountId])

  // Log in → account-scoped token, landing on A (setup's last-active).
  kevinToken = json(await call('POST', '/api/auth/login', undefined, { email: 'kevin@example.com', password: 'ownerpass1' })).accessToken
  expect(decode(kevinToken)[HH_CLAIM]).toBe(householdA)
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('P2.3 POST /api/auth/switch', () => {
  it('switches to another membership and remembers it as last-active', async () => {
    const r = await call('POST', '/api/auth/switch', kevinToken, { householdId: householdB })
    expect(r.statusCode).toBe(200)
    const d = json(r)
    const claims = decode(d.accessToken)
    expect(claims.sub).toBe(kevinAccountId)
    expect(claims[HH_CLAIM]).toBe(householdB)
    // the new token resolves to B
    expect(json(await call('GET', '/api/household', d.accessToken)).household.name).toBe('B')
    // last-active persisted
    expect((await query(`select last_household_id from accounts where id=$1`, [kevinAccountId])).rows[0].last_household_id).toBe(householdB)
    // the rotated refresh token also lands on B
    const refreshed = json(await call('POST', '/api/auth/refresh', undefined, { refreshToken: d.refreshToken }))
    expect(decode(refreshed.accessToken)[HH_CLAIM]).toBe(householdB)
  })

  it('can switch back to A', async () => {
    const d = json(await call('POST', '/api/auth/switch', kevinToken, { householdId: householdA }))
    expect(decode(d.accessToken)[HH_CLAIM]).toBe(householdA)
    expect(json(await call('GET', '/api/household', d.accessToken)).household.name).toBe('A')
  })

  it('rejects switching to a household the account is not a member of (403)', async () => {
    const orphan = (await query(`insert into households (name, timezone) values ('Orphan','UTC') returning id`)).rows[0].id
    expect((await call('POST', '/api/auth/switch', kevinToken, { householdId: orphan })).statusCode).toBe(403)
  })

  it('400 on a missing householdId', async () => {
    expect((await call('POST', '/api/auth/switch', kevinToken, {})).statusCode).toBe(400)
  })

  it('401 without a token', async () => {
    expect((await call('POST', '/api/auth/switch', undefined, { householdId: householdB })).statusCode).toBe(401)
  })
})
