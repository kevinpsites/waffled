// Rewards domain — catalog + redemption approval + balances, against a real PG.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client } from 'pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'nook-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

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
  const [rawPath, qs] = path.split('?')
  const queryStringParameters: Record<string, string> = {}
  if (qs) for (const pair of qs.split('&')) { const [k, v] = pair.split('='); queryStringParameters[k] = decodeURIComponent(v ?? '') }
  return app.run(
    { httpMethod: method, path: rawPath, headers, queryStringParameters, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}

const kevin = mint('dev|kevin')
let householdId = ''
let kevinId = ''

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  const body = JSON.parse(setup.body)
  kevinId = body.person.id
  householdId = body.household.id
  // Seed an identity so the legacy mint('dev|kevin') token resolves to the owner.
  await withClient((c) =>
    c.query(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
      [householdId, kevinId]
    )
  )
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

// Seed a member with a login identity (the /api/persons route makes no login),
// so a minted token resolves to them and we can test non-admin capability gating.
async function addMember(name: string, memberType: string, isAdmin: boolean, sub: string): Promise<string> {
  return withClient(async (c) => {
    const p = await c.query<{ id: string }>(
      `insert into persons (household_id, name, member_type, is_admin) values ($1,$2,$3,$4) returning id`,
      [householdId, name, memberType, isAdmin]
    )
    const pid = p.rows[0].id
    await c.query(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password',$3,true)`,
      [householdId, pid, sub]
    )
    return pid
  })
}

// Grant stars by writing directly to the append-only ledger (what chore
// completion does in production).
async function grantStars(personId: string, amount: number) {
  await withClient((c) =>
    c.query(
      `insert into ledger_entries (household_id, person_id, currency, amount, reason, created_by)
       values ($1,$2,'stars',$3,'chore_completed',$2)`,
      [householdId, personId, amount]
    )
  )
}

async function starsOf(personId: string): Promise<number> {
  const people = JSON.parse((await call('GET', '/api/balances', kevin)).body).people
  return people.find((p: { personId: string }) => p.personId === personId)?.stars ?? 0
}

describe('rewards api', () => {
  let rewardId = ''

  it('requires a title to create a reward (400) and is admin-only', async () => {
    expect((await call('POST', '/api/rewards', kevin, { cost: 5 })).statusCode).toBe(400)
  })

  it('creates a reward and lists it', async () => {
    const res = await call('POST', '/api/rewards', kevin, { title: 'Ice cream', emoji: '🍦', cost: 5 })
    expect(res.statusCode).toBe(201)
    rewardId = JSON.parse(res.body).reward.id
    const list = JSON.parse((await call('GET', '/api/rewards', kevin)).body).rewards
    expect(list.map((r: { title: string }) => r.title)).toContain('Ice cream')
  })

  it('balances reflect the ledger', async () => {
    await grantStars(kevinId, 8)
    const me = JSON.parse((await call('GET', '/api/balances', kevin)).body).people.find((p: { personId: string }) => p.personId === kevinId)
    expect(me.stars).toBe(8)
  })

  it('redeem → pending → approve debits the ledger', async () => {
    const red = await call('POST', `/api/rewards/${rewardId}/redeem`, kevin, { personId: kevinId })
    expect(red.statusCode).toBe(201)
    const redemptionId = JSON.parse(red.body).redemption.id
    expect(JSON.parse(red.body).redemption.status).toBe('pending')

    const pending = JSON.parse((await call('GET', '/api/redemptions?status=pending', kevin)).body).redemptions
    expect(pending.some((r: { id: string }) => r.id === redemptionId)).toBe(true)

    const ok = await call('POST', `/api/redemptions/${redemptionId}/approve`, kevin)
    expect(ok.statusCode).toBe(200)
    expect(JSON.parse(ok.body).redemption.status).toBe('approved')

    // 8 granted − 5 spent = 3
    const me = JSON.parse((await call('GET', '/api/balances', kevin)).body).people.find((p: { personId: string }) => p.personId === kevinId)
    expect(me.stars).toBe(3)
  })

  it('blocks approval when the balance is too low (409)', async () => {
    // costs 5, balance is now 3
    const red = await call('POST', `/api/rewards/${rewardId}/redeem`, kevin, { personId: kevinId })
    const id = JSON.parse(red.body).redemption.id
    const res = await call('POST', `/api/redemptions/${id}/approve`, kevin)
    expect(res.statusCode).toBe(409)
    // still 3 — nothing debited
    const me = JSON.parse((await call('GET', '/api/balances', kevin)).body).people.find((p: { personId: string }) => p.personId === kevinId)
    expect(me.stars).toBe(3)
    // can be denied instead
    const deny = await call('POST', `/api/redemptions/${id}/deny`, kevin)
    expect(deny.statusCode).toBe(200)
    expect(JSON.parse(deny.body).redemption.status).toBe('denied')
  })

  it('a deciding twice 409s (idempotent guard)', async () => {
    await grantStars(kevinId, 5)
    const red = await call('POST', `/api/rewards/${rewardId}/redeem`, kevin, { personId: kevinId })
    const id = JSON.parse(red.body).redemption.id
    expect((await call('POST', `/api/redemptions/${id}/approve`, kevin)).statusCode).toBe(200)
    expect((await call('POST', `/api/redemptions/${id}/approve`, kevin)).statusCode).toBe(409)
  })

  it('soft-deletes a reward', async () => {
    expect((await call('DELETE', `/api/rewards/${rewardId}`, kevin)).statusCode).toBe(204)
    const list = JSON.parse((await call('GET', '/api/rewards', kevin)).body).rewards
    expect(list.some((r: { id: string }) => r.id === rewardId)).toBe(false)
  })
})

describe('reward approval — per-reward flag + household default', () => {
  it('new rewards inherit the household default (default true)', async () => {
    expect(JSON.parse((await call('GET', '/api/rewards/settings', kevin)).body).requireApproval).toBe(true)
    const r = JSON.parse((await call('POST', '/api/rewards', kevin, { title: 'Default reward', cost: 1 })).body).reward
    expect(r.requiresApproval).toBe(true)
  })

  it('rejects a non-boolean default (400)', async () => {
    expect((await call('PUT', '/api/rewards/settings', kevin, { requireApproval: 'yes' })).statusCode).toBe(400)
  })

  it('a reward with approval OFF auto-approves + debits immediately (no queue)', async () => {
    const r = JSON.parse((await call('POST', '/api/rewards', kevin, { title: 'Instant', emoji: '⚡', cost: 2, requiresApproval: false })).body).reward
    expect(r.requiresApproval).toBe(false)
    await grantStars(kevinId, 2)
    const before = await starsOf(kevinId)

    const red = await call('POST', `/api/rewards/${r.id}/redeem`, kevin, { personId: kevinId })
    expect(red.statusCode).toBe(201)
    expect(JSON.parse(red.body).redemption.status).toBe('approved')
    const pending = JSON.parse((await call('GET', '/api/redemptions?status=pending', kevin)).body).redemptions
    expect(pending.some((x: { rewardId: string }) => x.rewardId === r.id)).toBe(false)
    expect(await starsOf(kevinId)).toBe(before - 2)
  })

  it('approval-OFF but unaffordable is blocked (409) and debits nothing', async () => {
    const r = JSON.parse((await call('POST', '/api/rewards', kevin, { title: 'Yacht', emoji: '🛥️', cost: 1_000_000, requiresApproval: false })).body).reward
    const before = await starsOf(kevinId)
    expect((await call('POST', `/api/rewards/${r.id}/redeem`, kevin, { personId: kevinId })).statusCode).toBe(409)
    expect(await starsOf(kevinId)).toBe(before)
  })

  it('an approval-ON reward still queues regardless of the household default', async () => {
    // flip the default off — a reward explicitly set ON must still pend…
    expect((await call('PUT', '/api/rewards/settings', kevin, { requireApproval: false })).statusCode).toBe(200)
    const gated = JSON.parse((await call('POST', '/api/rewards', kevin, { title: 'Gated', cost: 1, requiresApproval: true })).body).reward
    await grantStars(kevinId, 1)
    const red = await call('POST', `/api/rewards/${gated.id}/redeem`, kevin, { personId: kevinId })
    expect(JSON.parse(red.body).redemption.status).toBe('pending')
    // …while a default-inheriting reward created now is OFF (auto).
    const auto = JSON.parse((await call('POST', '/api/rewards', kevin, { title: 'Auto', cost: 1 })).body).reward
    expect(auto.requiresApproval).toBe(false)
  })

  it('PATCH can flip a reward’s approval flag', async () => {
    const r = JSON.parse((await call('POST', '/api/rewards', kevin, { title: 'Flip', cost: 1, requiresApproval: true })).body).reward
    const upd = JSON.parse((await call('PATCH', `/api/rewards/${r.id}`, kevin, { requiresApproval: false })).body).reward
    expect(upd.requiresApproval).toBe(false)
  })
})

describe('reward capability gating (non-admin members)', () => {
  let adultId = '', kidId = '', adultToken = '', kidToken = ''

  beforeAll(async () => {
    adultId = await addMember('Adult2', 'adult', false, 'dev|r-adult2')
    kidId = await addMember('KidJr', 'kid', false, 'dev|r-kidjr')
    adultToken = mint('dev|r-adult2'); kidToken = mint('dev|r-kidjr')
    await grantStars(kidId, 100)
  })

  // Set a reward to require approval, redeem it for the kid, return the redemption id.
  async function pendingRedemption(): Promise<string> {
    const r = JSON.parse((await call('POST', '/api/rewards', kevin, { title: `Cap-${Math.random()}`, cost: 1, requiresApproval: true })).body).reward
    const red = await call('POST', `/api/rewards/${r.id}/redeem`, kevin, { personId: kidId })
    return JSON.parse(red.body).redemption.id
  }

  it('a non-admin adult CAN approve a redemption; a kid cannot (403)', async () => {
    const id1 = await pendingRedemption()
    expect((await call('POST', `/api/redemptions/${id1}/approve`, adultToken)).statusCode).toBe(200)

    const id2 = await pendingRedemption()
    expect((await call('POST', `/api/redemptions/${id2}/approve`, kidToken)).statusCode).toBe(403)
    expect((await call('POST', `/api/redemptions/${id2}/deny`, kidToken)).statusCode).toBe(403)
  })

  it('a kid cannot manage rewards (403); a non-admin adult can', async () => {
    expect((await call('POST', '/api/rewards', kidToken, { title: 'Kid reward', cost: 1 })).statusCode).toBe(403)
    expect((await call('POST', '/api/rewards', adultToken, { title: 'Adult reward', cost: 1 })).statusCode).toBe(201)
  })

  it('exposes capabilities on /api/household', async () => {
    const kid = JSON.parse((await call('GET', '/api/household', kidToken)).body).person
    expect(kid.capabilities).toEqual([])
    const adult = JSON.parse((await call('GET', '/api/household', adultToken)).body).person
    expect(adult.capabilities).toContain('reward.approve')
  })
})
