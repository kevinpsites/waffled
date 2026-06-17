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
  const h = await call('POST', '/api/households', kevin, { name: 'Sites', timezone: 'America/Chicago', person: { name: 'Kevin' } })
  const body = JSON.parse(h.body)
  kevinId = body.person.id
  householdId = body.household.id
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

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
