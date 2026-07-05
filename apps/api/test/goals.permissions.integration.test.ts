// Goals capability gating — the `goal.manage` carve-outs. Shares one Postgres
// testcontainer + app. Mirrors the chores integration harness.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client } from 'pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let kevinId = ''
let householdId = ''

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
  if (qs) for (const pair of qs.split('&')) {
    const [k, v] = pair.split('=')
    queryStringParameters[k] = decodeURIComponent(v ?? '')
  }
  return app.run(
    { httpMethod: method, path: rawPath, headers, queryStringParameters, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<RunResult>
}

const kevin = mint('dev|kevin')

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
  kevinId = JSON.parse(setup.body).person.id
  householdId = JSON.parse(setup.body).household.id
  // Seed an identity so the legacy mint('dev|kevin') token resolves to the owner.
  await withClient((c) =>
    c.query(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
      [householdId, kevinId]
    )
  )
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

// Create a member with a login identity so a minted token resolves to them — the
// /api/persons route doesn't create logins, so we seed person + identity directly.
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

// A minimal valid goal body. Override participantIds per test.
function goalBody(extra: Record<string, unknown> = {}) {
  return { title: 'Read', goalType: 'count', trackingMode: 'each_tracks', ...extra }
}

async function createGoalAs(token: string, extra: Record<string, unknown> = {}) {
  return call('POST', '/api/goals', token, goalBody(extra))
}

describe('goal capability gating (non-admin members)', () => {
  let teenId = '', teenToken = ''

  beforeAll(async () => {
    teenId = await addMember('TeenT', 'teen', false, 'dev|teent')
    teenToken = mint('dev|teent')
  })

  it('a non-admin teen holds no goal.manage by default; an admin holds it', async () => {
    const teen = JSON.parse((await call('GET', '/api/household', teenToken)).body).person
    expect(teen.capabilities).toEqual([])
    const admin = JSON.parse((await call('GET', '/api/household', kevin)).body).person
    expect(admin.capabilities).toContain('goal.manage')
  })

  it('(a) a teen CAN create a self-only goal and CAN log progress for self', async () => {
    const created = await createGoalAs(teenToken, { participantIds: [teenId] })
    expect(created.statusCode).toBe(201)
    const goalId = JSON.parse(created.body).goal.id

    // log for self (explicit personId)
    expect((await call('POST', `/api/goals/${goalId}/log`, teenToken, { amount: 1, personId: teenId })).statusCode).toBe(201)
    // log for the family (no person) is also allowed
    expect((await call('POST', `/api/goals/${goalId}/log`, teenToken, { amount: 1 })).statusCode).toBe(201)
  })

  it('(b) a teen CANNOT log progress attributed to another person (403)', async () => {
    const created = await createGoalAs(teenToken, { participantIds: [teenId] })
    const goalId = JSON.parse(created.body).goal.id
    expect((await call('POST', `/api/goals/${goalId}/log`, teenToken, { amount: 1, personId: kevinId })).statusCode).toBe(403)
    // a multi-person log that includes someone else is also blocked
    expect((await call('POST', `/api/goals/${goalId}/log`, teenToken, { amount: 1, personIds: [teenId, kevinId] })).statusCode).toBe(403)
  })

  it('(c) a teen CANNOT create a goal assigning another participant (403)', async () => {
    expect((await createGoalAs(teenToken, { participantIds: [kevinId] })).statusCode).toBe(403)
    expect((await createGoalAs(teenToken, { participantIds: [teenId, kevinId] })).statusCode).toBe(403)
  })

  it('(d) a teen CAN edit/delete their own sole-participant goal but NOT a shared one', async () => {
    // own goal — editable + deletable
    const mine = JSON.parse((await createGoalAs(teenToken, { participantIds: [teenId] })).body).goal.id
    expect((await call('PATCH', `/api/goals/${mine}`, teenToken, { title: 'Read more' })).statusCode).toBe(200)
    expect((await call('DELETE', `/api/goals/${mine}`, teenToken)).statusCode).toBe(204)

    // shared goal (teen + kevin), created by the admin — teen may not manage it
    const shared = JSON.parse((await createGoalAs(kevin, { participantIds: [teenId, kevinId] })).body).goal.id
    expect((await call('PATCH', `/api/goals/${shared}`, teenToken, { title: 'nope' })).statusCode).toBe(403)
    expect((await call('DELETE', `/api/goals/${shared}`, teenToken)).statusCode).toBe(403)

    // a no-participant family goal is likewise off-limits to the teen
    const family = JSON.parse((await createGoalAs(kevin)).body).goal.id
    expect((await call('PATCH', `/api/goals/${family}`, teenToken, { title: 'nope' })).statusCode).toBe(403)
    expect((await call('DELETE', `/api/goals/${family}`, teenToken)).statusCode).toBe(403)
  })

  it('a missing goal 404s for the teen before any 403', async () => {
    const ghost = '00000000-0000-0000-0000-000000000000'
    expect((await call('PATCH', `/api/goals/${ghost}`, teenToken, { title: 'x' })).statusCode).toBe(404)
    expect((await call('DELETE', `/api/goals/${ghost}`, teenToken)).statusCode).toBe(404)
  })

  it('goal-list management is gated: teen 403, admin OK', async () => {
    const list = JSON.parse((await call('POST', '/api/goal-lists', kevin, { name: 'Family' })).body).list
    expect((await call('PATCH', `/api/goal-lists/${list.id}`, teenToken, { name: 'Mine' })).statusCode).toBe(403)
    expect((await call('DELETE', `/api/goal-lists/${list.id}`, teenToken)).statusCode).toBe(403)
    expect((await call('PATCH', `/api/goal-lists/${list.id}`, kevin, { name: 'Renamed' })).statusCode).toBe(200)
    expect((await call('DELETE', `/api/goal-lists/${list.id}`, kevin)).statusCode).toBe(204)
  })

  it('(e) an admin can create, log for others, and edit/delete any goal', async () => {
    const created = await createGoalAs(kevin, { participantIds: [teenId, kevinId] })
    expect(created.statusCode).toBe(201)
    const goalId = JSON.parse(created.body).goal.id
    // log attributed to the teen
    expect((await call('POST', `/api/goals/${goalId}/log`, kevin, { amount: 2, personId: teenId })).statusCode).toBe(201)
    expect((await call('PATCH', `/api/goals/${goalId}`, kevin, { title: 'Admin edit' })).statusCode).toBe(200)
    expect((await call('DELETE', `/api/goals/${goalId}`, kevin)).statusCode).toBe(204)
  })

  it('granting teen goal.manage via /api/permissions lets them manage shared goals', async () => {
    const put = await call('PUT', '/api/permissions', kevin, { permissions: { teen: { 'goal.manage': true } } })
    expect(put.statusCode).toBe(200)
    expect(JSON.parse(put.body).permissions.teen['goal.manage']).toBe(true)

    const shared = JSON.parse((await createGoalAs(kevin, { participantIds: [teenId, kevinId] })).body).goal.id
    expect((await call('POST', `/api/goals/${shared}/log`, teenToken, { amount: 1, personId: kevinId })).statusCode).toBe(201)
    expect((await call('PATCH', `/api/goals/${shared}`, teenToken, { title: 'teen edit' })).statusCode).toBe(200)

    // reset so later assumptions about defaults hold
    await call('PUT', '/api/permissions', kevin, { permissions: { teen: { 'goal.manage': false } } })
  })
})
