// P2.1 of multi-household identity (docs/design/multi-household-identity.md §5.1, §6):
// the account-aware tenant resolver. The household a request acts on is resolved
// DB-side from the token. This proves:
//   - legacy/no-claim tokens resolve exactly as before (sub → identity → person → household)
//   - an account-scoped token (sub = account.id + household claim) resolves to THAT
//     membership — and the SAME account with a different claim resolves to a different
//     household (the seam that makes switching work)
//   - a claim for a household the account isn't a member of is rejected (403)
//   - signup now creates + links an account (account_id on persons, last_household_id)
// Driven end-to-end through the real app handler, like the other integration suites.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'nook-local-dev-secret-change-me'
// config default (HOUSEHOLD_CLAIM unset in tests).
const HH_CLAIM = 'https://nook.app/household_id'

let pg: StartedPostgreSqlContainer
let dbUrl = ''
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let query: any

let ownerToken = ''
let accountId = ''
let householdA = ''
let householdB = ''
let kevinBId = ''

// A legacy-shaped token: subject only, no household claim.
function mintLegacy(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'nook-local', audience: 'nook-api', expiresIn: '1h' })
}
// An account-scoped token: subject = account id + the active household claim.
function mintAccount(accountSub: string, householdId: string): string {
  return jwt.sign({ [HH_CLAIM]: householdId }, SECRET, {
    algorithm: 'HS256', subject: accountSub, issuer: 'nook-local', audience: 'nook-api', expiresIn: '1h',
  })
}

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

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  dbUrl = pg.getConnectionUri()
  await runMigrations(dbUrl)

  process.env.DATABASE_URL = dbUrl
  delete process.env.AUTH0_DOMAIN
  process.env.LOCAL_JWT_SECRET = SECRET
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64')

  app = (await import('../src/app')).default
  ;({ query, closePool } = await import('../src/platform/db'))

  // First-run setup → household A + owner Kevin (now also creates an account).
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'A', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  ownerToken = JSON.parse(setup.body).accessToken

  // Account row + link were created by provisioning.
  const acct = await query(`select id, last_household_id from accounts where lower(email) = 'kevin@example.com' and deleted_at is null`)
  expect(acct.rows).toHaveLength(1)
  accountId = acct.rows[0].id

  const owner = await query(`select household_id, account_id from persons where name = 'Kevin'`)
  householdA = owner.rows[0].household_id
  expect(owner.rows[0].account_id).toBe(accountId)
  // last_household_id defaults to the household just created.
  expect(acct.rows[0].last_household_id).toBe(householdA)

  // Simulate a SECOND membership for the same account: a new household B with a
  // person linked to Kevin's account. (The real "join" flow lands in P2.4; here we
  // wire it directly to exercise the resolver.)
  const hb = await query(`insert into households (name, timezone) values ('B','America/Chicago') returning id`)
  householdB = hb.rows[0].id
  const pb = await query(
    `insert into persons (household_id, name, member_type, is_admin, account_id) values ($1,'KevinB','adult',true,$2) returning id`,
    [householdB, accountId]
  )
  kevinBId = pb.rows[0].id
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('P2.1 resolveTenant — account-aware', () => {
  it('legacy no-claim token resolves to the original household (backward compatible)', async () => {
    const res = await call('GET', '/api/persons', ownerToken)
    expect(res.statusCode).toBe(200)
    const names = JSON.parse(res.body).persons.map((p: { name: string }) => p.name)
    expect(names).toContain('Kevin')
    expect(names).not.toContain('KevinB') // household B is a different tenant
  })

  it('account token + household-A claim resolves to household A', async () => {
    const res = await call('GET', '/api/persons', mintAccount(accountId, householdA))
    expect(res.statusCode).toBe(200)
    const names = JSON.parse(res.body).persons.map((p: { name: string }) => p.name)
    expect(names).toContain('Kevin')
    expect(names).not.toContain('KevinB')
  })

  it('the SAME account with a household-B claim resolves to household B (the switch seam)', async () => {
    const res = await call('GET', '/api/persons', mintAccount(accountId, householdB))
    expect(res.statusCode).toBe(200)
    const names = JSON.parse(res.body).persons.map((p: { name: string }) => p.name)
    expect(names).toContain('KevinB')
    expect(names).not.toContain('Kevin')
  })

  it('rejects a claim for a household the account is not a member of (403)', async () => {
    const orphan = await query(`insert into households (name, timezone) values ('Orphan','UTC') returning id`)
    const res = await call('GET', '/api/persons', mintAccount(accountId, orphan.rows[0].id))
    expect(res.statusCode).toBe(403)
  })

  it('rejects an account token whose subject is not a real account', async () => {
    const res = await call('GET', '/api/persons', mintAccount('00000000-0000-0000-0000-000000000000', householdA))
    expect(res.statusCode).toBe(403)
  })

  it('a non-uuid subject with a claim does not 500 — it is rejected cleanly', async () => {
    const res = await call('GET', '/api/persons', mintAccount('not-a-uuid', householdA))
    expect(res.statusCode).toBe(403)
  })

  it('/api/household reflects the household in the account token claim', async () => {
    const a = await call('GET', '/api/household', mintAccount(accountId, householdA))
    expect(JSON.parse(a.body).household.name).toBe('A')
    const b = await call('GET', '/api/household', mintAccount(accountId, householdB))
    expect(JSON.parse(b.body).household.name).toBe('B')
  })

  it('PowerSync token carries the claimed household, not just the default', async () => {
    const res = await call('GET', '/api/powersync/token', mintAccount(accountId, householdB))
    expect(res.statusCode).toBe(200)
    const token = JSON.parse(res.body).token as string
    const decoded = jwt.decode(token) as { household_id: string }
    expect(decoded.household_id).toBe(householdB)
  })
})
