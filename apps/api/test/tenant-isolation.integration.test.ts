// Cross-household isolation regression suite. Every test here seeds TWO households
// and proves that household A cannot (a) write a row that references household B's
// person, nor (b) read household B's person back through a join that forgot its
// household predicate. Each `it` corresponds to a finding in the 2026-09-08 tenant
// isolation audit; keep them here (rather than scattered per module) so the whole
// guarantee is provable in one place, against one throwaway Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { Client } from 'pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}

interface RunResult {
  statusCode: number
  body: string
}

function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const [rawPath, qs] = path.split('?')
  const queryStringParameters: Record<string, string> = {}
  if (qs) for (const pair of qs.split('&')) { const [k, v] = pair.split('='); queryStringParameters[k] = decodeURIComponent(v ?? '') }
  return app.run(
    { httpMethod: method, path: rawPath, headers, queryStringParameters, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

// Household A — the attacker's side. Owner is an admin (every capability).
const attacker = mint('dev|a-admin')
// A non-admin kid in A, for the "acting on behalf of another member" checks.
const attackerKid = mint('dev|a-kid')
// Household B — the victim's side. Its own admin, so B can read its own boards.
const victim = mint('dev|b-admin')

let householdA = ''
let householdB = ''
let aAdminId = ''
let aKidId = ''
let aSiblingId = ''
let bAdminId = ''
// The victim: a person in household B whose UUID the attacker somehow knows.
let bPersonId = ''
const VICTIM_NAME = 'SECRET-VICTIM-NAME'

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool

  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Attackers', timezone: 'UTC' },
    admin: { name: 'Ada', email: 'ada@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  const setupBody = JSON.parse(setup.body)
  householdA = setupBody.household.id
  aAdminId = setupBody.person.id

  await withClient(async (c) => {
    const identity = (householdId: string, personId: string, sub: string) =>
      c.query(
        `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified)
         values ($1,$2,'password',$3,true)`,
        [householdId, personId, sub]
      )
    const person = async (householdId: string, name: string, memberType: string, isAdmin: boolean) =>
      (await c.query<{ id: string }>(
        `insert into persons (household_id, name, member_type, is_admin) values ($1,$2,$3,$4) returning id`,
        [householdId, name, memberType, isAdmin]
      )).rows[0].id

    await identity(householdA, aAdminId, 'dev|a-admin')
    aKidId = await person(householdA, 'Kid A', 'kid', false)
    await identity(householdA, aKidId, 'dev|a-kid')
    aSiblingId = await person(householdA, 'Sib A', 'kid', false)

    householdB = (await c.query<{ id: string }>(
      `insert into households (name, timezone) values ('Victims','UTC') returning id`
    )).rows[0].id
    bAdminId = await person(householdB, 'Bea', 'adult', true)
    await identity(householdB, bAdminId, 'dev|b-admin')
    bPersonId = await person(householdB, VICTIM_NAME, 'kid', false)

    // Family Night is off by default; household A needs it on to reach its routes.
    await c.query(
      `update households set settings = coalesce(settings,'{}'::jsonb) || '{"modules":{"familyNight":true}}'::jsonb
        where id = $1`,
      [householdA]
    )
  })
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

// ---- Finding 1 — spot award (cross-household WRITE) -------------------------
// The only finding where household A can change what household B sees: the award
// wrote a ledger row stamped with A's household_id but B's person_id, and the
// chores summary joined the balances view on person_id alone.
describe('spot award cannot reach another household', () => {
  it('refuses a spot award aimed at a person outside the household', async () => {
    const res = await call('POST', `/api/persons/${bPersonId}/award`, attacker, { amount: 999, note: 'pwned' })
    expect(res.statusCode).toBe(404)
    const { rows } = await withClient((c) =>
      c.query(`select 1 from ledger_entries where person_id = $1`, [bPersonId])
    )
    expect(rows.length).toBe(0)
  })

  it("never counts a foreign household's ledger row on the victim's Today board", async () => {
    // Independent of the route guard: seed the poisoned row exactly as the bug
    // wrote it (A's household_id, B's person_id) plus a legitimate row in B, so
    // this test still fails if only the write guard were fixed.
    await withClient(async (c) => {
      await c.query(
        `insert into ledger_entries (household_id, person_id, currency, amount, reason)
         values ($1,$2,'stars',999,'spot_award')`,
        [householdA, bPersonId]
      )
      await c.query(
        `insert into ledger_entries (household_id, person_id, currency, amount, reason)
         values ($1,$2,'stars',7,'chore_completed')`,
        [householdB, bPersonId]
      )
    })
    const res = await call('GET', '/api/chores/today', victim)
    expect(res.statusCode).toBe(200)
    const people = JSON.parse(res.body).people as { id: string; stars: number }[]
    const rows = people.filter((p) => p.id === bPersonId)
    // Exactly one row: the unpredicated join also duplicated a person who already
    // had a legitimate balance.
    expect(rows.length).toBe(1)
    expect(rows[0].stars).toBe(7)
  })
})

// ---- Finding 2 — reward redemption ------------------------------------------
describe('reward redemption cannot reach another household', () => {
  it('refuses a redemption filed for a person outside the household', async () => {
    const reward = await call('POST', '/api/rewards', attacker, { title: 'Ice cream', cost: 5, requiresApproval: true })
    expect(reward.statusCode).toBe(201)
    const rewardId = JSON.parse(reward.body).reward.id as string

    const res = await call('POST', `/api/rewards/${rewardId}/redeem`, attacker, { personId: bPersonId })
    expect(res.statusCode).toBe(404)
    const { rows } = await withClient((c) =>
      c.query(`select 1 from reward_redemptions where person_id = $1`, [bPersonId])
    )
    expect(rows.length).toBe(0)
  })

  it('never discloses a foreign person through the redemptions list', async () => {
    // Independent of the write guard: a row already on file (or written by some
    // future missed guard) must still not resolve a stranger's profile.
    await withClient(async (c) => {
      const reward = await c.query<{ id: string }>(
        `insert into rewards (household_id, title, cost, currency) values ($1,'Poisoned',1,'stars') returning id`,
        [householdA]
      )
      await c.query(
        `insert into reward_redemptions (household_id, reward_id, person_id, title, cost, currency, status)
         values ($1,$2,$3,'Poisoned',1,'stars','pending')`,
        [householdA, reward.rows[0].id, bPersonId]
      )
    })
    const res = await call('GET', '/api/redemptions', attacker)
    expect(res.statusCode).toBe(200)
    const redemptions = JSON.parse(res.body).redemptions as { personId: string; personName: string | null }[]
    const poisoned = redemptions.find((r) => r.personId === bPersonId)
    expect(poisoned).toBeTruthy()
    expect(poisoned?.personName).toBe(null)
    expect(res.body).not.toContain(VICTIM_NAME)
  })
})

// ---- Finding 6 — redeeming on behalf of another member ----------------------
// Same rule its sibling POST /api/conversions/:id/apply already enforces: your own
// balance is yours to spend, someone else's needs the reward.manage capability.
describe('redeeming for another member needs the capability', () => {
  it('lets a kid redeem for themselves but not for a sibling', async () => {
    const reward = await call('POST', '/api/rewards', attacker, { title: 'Movie night', cost: 3, requiresApproval: true })
    const rewardId = JSON.parse(reward.body).reward.id as string

    const own = await call('POST', `/api/rewards/${rewardId}/redeem`, attackerKid, { personId: aKidId })
    expect(own.statusCode).toBe(201)

    const onBehalf = await call('POST', `/api/rewards/${rewardId}/redeem`, attackerKid, { personId: aSiblingId })
    expect(onBehalf.statusCode).toBe(403)

    // An admin (who holds reward.manage) still can.
    const byAdmin = await call('POST', `/api/rewards/${rewardId}/redeem`, attacker, { personId: aSiblingId })
    expect(byAdmin.statusCode).toBe(201)
  })
})
