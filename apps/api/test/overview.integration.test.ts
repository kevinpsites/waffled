// Person + family overview — goal/category/stars rollups against a real PG.
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
interface RunResult { statusCode: number; body: string }
function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const [rawPath, qs] = path.split('?')
  const queryStringParameters: Record<string, string> = {}
  if (qs) for (const pair of qs.split('&')) { const [k, v] = pair.split('='); queryStringParameters[k] = decodeURIComponent(v ?? '') }
  return app.run({ httpMethod: method, path: rawPath, headers, queryStringParameters, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false }, {}) as Promise<RunResult>
}

const kevin = mint('dev|kevin')
let householdId = ''
let kevinId = ''

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try { return await fn(client) } finally { await client.end() }
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

describe('person + family overview', () => {
  beforeAll(async () => {
    const list = await call('POST', '/api/goal-lists', kevin, { name: 'Kevin', emoji: '🐻', memberIds: [kevinId] })
    const listId = JSON.parse(list.body).list.id
    const g = await call('POST', '/api/goals', kevin, {
      goalListId: listId, title: 'Read 20 books', category: 'intellectual',
      goalType: 'count', trackingMode: 'shared_total', targetValue: 20, participantIds: [kevinId],
    })
    const goalId = JSON.parse(g.body).goal.id
    await call('POST', `/api/goals/${goalId}/log`, kevin, { amount: 12, personId: kevinId })
    await withClient((c) =>
      c.query(`insert into ledger_entries (household_id, person_id, currency, amount, reason, created_by) values ($1,$2,'stars',7,'chore_completed',$2)`, [householdId, kevinId])
    )
  })

  it('rolls up a person: goals, category balance, stars, and a local insight', async () => {
    const res = await call('GET', `/api/persons/${kevinId}/overview`, kevin)
    expect(res.statusCode).toBe(200)
    const d = JSON.parse(res.body)
    expect(d.person.name).toBe('Kevin')
    expect(d.activeGoals).toBe(1)
    expect(d.stars).toBe(7)
    const intellectual = d.categoryBalance.find((c: { category: string }) => c.category === 'intellectual')
    expect(intellectual.goalCount).toBe(1)
    expect(intellectual.avgPct).toBe(60) // 12 / 20
    expect(d.insight.lean).toContain('Intellectual')
    expect(d.insight.light.length).toBeGreaterThan(0) // categories with no goals
    expect(d.goals[0].title).toBe('Read 20 books')
    expect(d.recentLedger.length).toBeGreaterThan(0)
  })

  it('404s for an unknown person', async () => {
    expect((await call('GET', '/api/persons/00000000-0000-0000-0000-000000000000/overview', kevin)).statusCode).toBe(404)
  })

  it('rolls up the family: each member with goals + stars', async () => {
    const res = await call('GET', '/api/family/overview', kevin)
    expect(res.statusCode).toBe(200)
    const me = JSON.parse(res.body).people.find((p: { personId: string }) => p.personId === kevinId)
    expect(me).toMatchObject({ activeGoals: 1, stars: 7, avgProgressPct: 60 })
  })
})
