// Capture Tier 2 — the 'reward' target (redeem an existing reward-shop item).
// Real PG (Testcontainers) + app.run. Resolve ranks the catalog (subtitle = the
// price); commit routes through requestRedemption, so the approval gate and the
// balance guard behave exactly like POST /api/rewards/:id/redeem.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { Client } from 'pg'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'
let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

interface RunResult { statusCode: number; body: string }
function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const [rawPath, qs] = path.split('?')
  const queryStringParameters: Record<string, string> = {}
  if (qs) for (const pair of qs.split('&')) {
    const [k, v] = pair.split('=')
    queryStringParameters[k] = decodeURIComponent(v ?? '')
  }
  return app.run({ httpMethod: method, path: rawPath, headers, queryStringParameters, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false }, {}) as Promise<RunResult>
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

let kevin = ''
let householdId = ''
let kevinId = ''
let wallyId = ''
let iceCream = '' // auto-approve, 50 stars
let movieNight = '' // requires approval, 30 stars

const resolve = (body: unknown) => call('POST', '/api/capture/resolve', kevin, body)
const commit = (body: unknown) => call('POST', '/api/capture/commit', kevin, body)

async function starsOf(personId: string): Promise<number> {
  const res = await call('GET', '/api/balances', kevin)
  expect(res.statusCode).toBe(200)
  const person = JSON.parse(res.body).people.find((p: { personId: string }) => p.personId === personId)
  return person?.stars ?? 0
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  process.env.LOCAL_JWT_SECRET = SECRET
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  kevin = JSON.parse(setup.body).accessToken
  householdId = JSON.parse(setup.body).household.id
  kevinId = JSON.parse(setup.body).person.id
  await withClient(async (c) => {
    const w = await c.query<{ id: string }>(
      `insert into persons (household_id, name, member_type, is_admin) values ($1,'Wally','kid',false) returning id`,
      [householdId]
    )
    wallyId = w.rows[0].id
  })

  const ice = await call('POST', '/api/rewards', kevin, { title: 'Ice cream night', cost: 50, requiresApproval: false })
  expect(ice.statusCode).toBe(201)
  iceCream = JSON.parse(ice.body).reward.id
  const movie = await call('POST', '/api/rewards', kevin, { title: 'Movie night', cost: 30, requiresApproval: true })
  expect(movie.statusCode).toBe(201)
  movieNight = JSON.parse(movie.body).reward.id

  // 60 stars: enough for ONE ice cream (50), not two — exercises the balance guard.
  const award = await call('POST', `/api/persons/${kevinId}/award`, kevin, { amount: 60 })
  expect(award.statusCode).toBe(201)
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('capture reward — resolve', () => {
  it('ranks the catalog with the price as the subtitle', async () => {
    const res = await resolve({ verb: 'redeem', targetKind: 'reward', target: { description: 'ice cream' }, args: {} })
    expect(res.statusCode).toBe(200)
    const { candidates } = JSON.parse(res.body)
    expect(candidates[0].id).toBe(iceCream)
    expect(candidates[0].subtitle).toMatch(/50/)
  })

  it('flags a verb the target does not support (complete) as unsupported', async () => {
    const res = await resolve({ verb: 'complete', targetKind: 'reward', target: { description: 'ice cream' }, args: {} })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.candidates).toEqual([])
    expect(body.unsupported).toBe(true)
    expect(body.disabledReason).toMatch(/reward/i)
  })
})

describe('capture reward — commit redeem', () => {
  it('auto-approves and debits the ledger when the reward needs no approval', async () => {
    const before = await starsOf(kevinId)
    const res = await commit({ verb: 'redeem', targetKind: 'reward', targetId: iceCream, args: {} })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.message).toMatch(/Ice cream night/)
    expect(await starsOf(kevinId)).toBe(before - 50)
  })

  it("409s the route's own message when the balance can't cover it", async () => {
    // 10 stars left after the first redemption — a second 50-star redeem must fail.
    const res = await commit({ verb: 'redeem', targetKind: 'reward', targetId: iceCream, args: {} })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).message).toMatch(/not enough stars/)
  })

  it('creates a pending request (no debit) when the reward requires approval', async () => {
    const before = await starsOf(kevinId)
    const res = await commit({ verb: 'redeem', targetKind: 'reward', targetId: movieNight, args: {} })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.message).toMatch(/approv/i) // "waiting for approval"
    expect(await starsOf(kevinId)).toBe(before) // nothing debited yet
    const pending = await call('GET', '/api/redemptions?status=pending', kevin)
    const rows = JSON.parse(pending.body).redemptions
    expect(rows.some((r: { rewardId: string; personId: string }) => r.rewardId === movieNight && r.personId === kevinId)).toBe(true)
  })

  it('redeems for another member by spoken name (args.personName)', async () => {
    const res = await commit({ verb: 'redeem', targetKind: 'reward', targetId: movieNight, args: { personName: 'wally' } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).message).toMatch(/Wally/)
    const pending = await call('GET', '/api/redemptions?status=pending', kevin)
    const rows = JSON.parse(pending.body).redemptions
    expect(rows.some((r: { rewardId: string; personId: string }) => r.rewardId === movieNight && r.personId === wallyId)).toBe(true)
  })

  it("400s a person name that isn't in the household", async () => {
    const res = await commit({ verb: 'redeem', targetKind: 'reward', targetId: movieNight, args: { personName: 'Newman' } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toMatch(/person/i)
  })

  it('404s a friendly message for a gone reward', async () => {
    const res = await commit({ verb: 'redeem', targetKind: 'reward', targetId: '00000000-0000-4000-8000-000000000000', args: {} })
    expect(res.statusCode).toBe(404)
    expect(typeof JSON.parse(res.body).message).toBe('string')
  })
})

describe('capture reward — rewards sub-toggle gate', () => {
  it('returns candidates:[] + disabledReason when the rewards shop is off', async () => {
    await withClient((c) =>
      c.query(`update households set settings = coalesce(settings,'{}'::jsonb) || '{"chores":{"rewards":false}}'::jsonb where id=$1`, [householdId])
    )
    try {
      const res = await resolve({ verb: 'redeem', targetKind: 'reward', target: { description: 'ice cream' }, args: {} })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.candidates).toEqual([])
      expect(typeof body.disabledReason).toBe('string')
      expect(body.disabledReason.length).toBeGreaterThan(0)
    } finally {
      await withClient((c) =>
        c.query(`update households set settings = coalesce(settings,'{}'::jsonb) || '{"chores":{"rewards":true}}'::jsonb where id=$1`, [householdId])
      )
    }
  })
})
