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
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { randomBytes } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'
// config default (HOUSEHOLD_CLAIM unset in tests).
const HH_CLAIM = 'https://waffled.app/household_id'

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
let temporaryAccountId = ''
let temporaryPersonA = ''
let temporaryPersonB = ''

// A legacy-shaped token: subject only, no household claim.
function mintLegacy(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}
// An account-scoped token: subject = account id + the active household claim.
function mintAccount(accountSub: string, householdId: string): string {
  return jwt.sign({ [HH_CLAIM]: householdId }, SECRET, {
    algorithm: 'HS256', subject: accountSub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h',
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

  // A non-owner account with two temporary memberships. Individual tests expire or
  // revoke A while leaving B active to exercise both terminal access classification
  // and the recovery switch without perturbing the household owner fixture.
  temporaryAccountId = (await query(
    `insert into accounts (email, last_household_id) values ('temporary@example.com',$1) returning id`,
    [householdA]
  )).rows[0].id
  temporaryPersonA = (await query(
    `insert into persons (household_id, name, member_type, account_id)
     values ($1,'Temporary A','caregiver',$2) returning id`,
    [householdA, temporaryAccountId]
  )).rows[0].id
  temporaryPersonB = (await query(
    `insert into persons (household_id, name, member_type, account_id)
     values ($1,'Temporary B','caregiver',$2) returning id`,
    [householdB, temporaryAccountId]
  )).rows[0].id
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
    const token = mintAccount(accountId, orphan.rows[0].id)
    const res = await call('GET', '/api/persons', token)
    expect(res.statusCode).toBe(403)
    const context = await call('GET', '/api/household', token)
    expect(context.statusCode).toBe(200)
    expect(JSON.parse(context.body)).toEqual({ provisioned: false })
  })

  it('rejects an account token whose subject is not a real account', async () => {
    const res = await call('GET', '/api/persons', mintAccount('00000000-0000-0000-0000-000000000000', householdA))
    expect(res.statusCode).toBe(403)
  })

  it('distinguishes an expired known membership from a never-provisioned principal', async () => {
    await query(`update persons set access_expires_at = now() - interval '1 minute' where id = $1`, [temporaryPersonA])
    try {
      const token = mintAccount(temporaryAccountId, householdA)
      for (const path of ['/api/household', '/api/persons', '/api/powersync/token', '/api/kiosk/display']) {
        const res = await call('GET', path, token)
        expect(res.statusCode).toBe(401)
        expect(JSON.parse(res.body)).toMatchObject({ error: 'membership_inactive' })
      }

      const unknown = await call(
        'GET', '/api/household',
        mintAccount('00000000-0000-0000-0000-000000000000', householdA)
      )
      expect(unknown.statusCode).toBe(200)
      expect(JSON.parse(unknown.body)).toEqual({ provisioned: false })
    } finally {
      await query(`update persons set access_expires_at = null where id = $1`, [temporaryPersonA])
    }
  })

  it('classifies a soft-deleted known membership as inactive', async () => {
    await query(`update persons set deleted_at = now() where id = $1`, [temporaryPersonA])
    try {
      const res = await call('GET', '/api/household', mintAccount(temporaryAccountId, householdA))
      expect(res.statusCode).toBe(401)
      expect(JSON.parse(res.body)).toMatchObject({ error: 'membership_inactive' })
    } finally {
      await query(`update persons set deleted_at = null where id = $1`, [temporaryPersonA])
    }
  })

  it('lets an inactive account session switch to another active membership', async () => {
    await query(`update persons set access_expires_at = now() - interval '1 minute' where id = $1`, [temporaryPersonA])
    try {
      const switched = await call('POST', '/api/auth/switch', mintAccount(temporaryAccountId, householdA), {
        householdId: householdB,
      })
      expect(switched.statusCode).toBe(200)
      const body = JSON.parse(switched.body)
      const claims = jwt.decode(body.accessToken) as Record<string, unknown>
      expect(claims.sub).toBe(temporaryAccountId)
      expect(claims[HH_CLAIM]).toBe(householdB)
      expect(JSON.parse((await call('GET', '/api/household', body.accessToken)).body).household.name).toBe('B')
      expect((await query(`select last_household_id from accounts where id = $1`, [temporaryAccountId])).rows[0].last_household_id).toBe(householdB)
      const refreshed = await call('POST', '/api/auth/refresh', undefined, { refreshToken: body.refreshToken })
      expect(refreshed.statusCode).toBe(200)
      expect((jwt.decode(JSON.parse(refreshed.body).accessToken) as Record<string, unknown>)[HH_CLAIM]).toBe(householdB)
    } finally {
      await query(`update persons set access_expires_at = null where id = $1`, [temporaryPersonA])
      await query(`update accounts set last_household_id = $1 where id = $2`, [householdA, temporaryAccountId])
    }
  })

  it('does not let inactive or unknown principals switch to an inactive target', async () => {
    await query(
      `update persons set access_expires_at = now() - interval '1 minute' where id = any($1::uuid[])`,
      [[temporaryPersonA, temporaryPersonB]]
    )
    try {
      expect((await call('POST', '/api/auth/switch', mintAccount(temporaryAccountId, householdA), {
        householdId: householdB,
      })).statusCode).toBe(403)

      // Make the target active again before testing the unknown subject, so that
      // denial proves the caller check rather than merely the target filter.
      await query(`update persons set access_expires_at = null where id = $1`, [temporaryPersonB])
      expect((await call(
        'POST', '/api/auth/switch',
        mintAccount('00000000-0000-0000-0000-000000000000', householdA),
        { householdId: householdB }
      )).statusCode).toBe(403)
    } finally {
      await query(
        `update persons set access_expires_at = null where id = any($1::uuid[])`,
        [[temporaryPersonA, temporaryPersonB]]
      )
    }
  })

  it('a non-uuid subject with a claim does not 500 — it is rejected cleanly', async () => {
    const res = await call('GET', '/api/persons', mintAccount('not-a-uuid', householdA))
    expect(res.statusCode).toBe(403)
  })

  it('a malformed household claim does not reach a UUID database comparison', async () => {
    const token = mintAccount(accountId, 'not-a-uuid')
    expect((await call('GET', '/api/persons', token)).statusCode).toBe(403)
    const context = await call('GET', '/api/household', token)
    expect(context.statusCode).toBe(200)
    expect(JSON.parse(context.body)).toEqual({ provisioned: false })
  })

  it('does not let a soft-deleted account switch through an otherwise active membership', async () => {
    await query(`update accounts set deleted_at = now() where id = $1`, [temporaryAccountId])
    try {
      const res = await call('POST', '/api/auth/switch', mintAccount(temporaryAccountId, householdA), {
        householdId: householdB,
      })
      expect(res.statusCode).toBe(403)
    } finally {
      await query(`update accounts set deleted_at = null where id = $1`, [temporaryAccountId])
    }
  })

  it('does not confuse a UUID-shaped legacy identity subject with an account id', async () => {
    const person = await query(
      `insert into persons (household_id, name, member_type)
       values ($1,'UUID Legacy','adult') returning id`,
      [householdA]
    )
    const personId = person.rows[0].id
    await query(
      `insert into identities (household_id, person_id, provider, auth0_user_id)
       values ($1,$2,'password',$3)`,
      [householdA, personId, temporaryAccountId]
    )
    try {
      const res = await call('POST', '/api/auth/switch', mintLegacy(temporaryAccountId), {
        householdId: householdB,
      })
      expect(res.statusCode).toBe(403)
    } finally {
      await query(`delete from identities where person_id = $1`, [personId])
      await query(`delete from persons where id = $1`, [personId])
    }
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
