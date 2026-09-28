import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'
const token = (sub: string) => jwt.sign({}, SECRET, {
  algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h',
})
const admin = token('dev|reward-role-admin')
const caregiver = token('dev|reward-role-caregiver')
const guest = token('dev|reward-role-guest')
let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let query: typeof import('../src/platform/db').query
let closePool: () => Promise<void>
let householdId: string
let childId: string
let caregiverId: string
let guestId: string
let awardId: string
let rewardId: string
let approvedId: string

function call(method: string, path: string, auth: string | undefined, body?: unknown) {
  return app.run({
    httpMethod: method, path, queryStringParameters: {}, isBase64Encoded: false,
    headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  }, {}) as Promise<{ statusCode: number; body: string }>
}

async function addMember(role: string, sub: string): Promise<string> {
  const { rows: [person] } = await query<{ id: string }>(
    'insert into persons (household_id, name, member_type) values ($1,$2,$3) returning id',
    [householdId, role, role]
  )
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified)
     values ($1,$2,'password',$3,true)`, [householdId, person.id, sub]
  )
  return person.id
}

async function ledgerSnapshot() {
  return (await query('select id, person_id, amount, reason from ledger_entries where household_id=$1 order by id',
    [householdId])).rows
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  await runMigrations(pg.getConnectionUri())
  process.env.DATABASE_URL = pg.getConnectionUri()
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  const db = await import('../src/platform/db')
  query = db.query
  closePool = db.closePool
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Reward role boundaries', timezone: 'UTC' },
    admin: { name: 'Admin', email: 'reward-roles@example.test', password: 'test-password-123' },
  })
  expect(setup.statusCode).toBe(201)
  const owner = JSON.parse(setup.body)
  householdId = owner.household.id
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified)
     values ($1,$2,'password','dev|reward-role-admin',true)`, [householdId, owner.person.id]
  )
  childId = await addMember('kid', 'dev|reward-role-child')
  caregiverId = await addMember('caregiver', 'dev|reward-role-caregiver')
  guestId = await addMember('guest', 'dev|reward-role-guest')
  expect((await call('GET', '/api/currencies', admin)).statusCode).toBe(200)
  for (const personId of [childId, caregiverId, guestId]) {
    const award = await call('POST', `/api/persons/${personId}/award`, admin, { amount: 30, currency: 'stars' })
    expect(award.statusCode, award.body).toBe(201)
    if (personId === childId) awardId = JSON.parse(award.body).id
  }
  const reward = await call('POST', '/api/rewards', admin, {
    title: 'Shared family treat', cost: 5, currency: 'stars', requiresApproval: true,
  })
  expect(reward.statusCode).toBe(201)
  rewardId = JSON.parse(reward.body).reward.id
  const pending = await call('POST', `/api/rewards/${rewardId}/redeem`, admin, { personId: childId })
  expect(pending.statusCode).toBe(201)
  approvedId = JSON.parse(pending.body).redemption.id
  expect((await call('POST', `/api/redemptions/${approvedId}/approve`, admin)).statusCode).toBe(200)
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('caregiver and guest boundaries on the merged reward stack', () => {
  it('lets a default caregiver request and approve for a child', async () => {
    const request = await call('POST', `/api/rewards/${rewardId}/redeem`, caregiver, { personId: childId })
    expect(request.statusCode).toBe(201)
    const redemption = JSON.parse(request.body).redemption
    expect(redemption.status).toBe('pending')
    expect((await call('POST', `/api/redemptions/${redemption.id}/approve`, caregiver)).statusCode).toBe(200)
  })

  it('still rejects a caregiver approving their own balance', async () => {
    const request = await call('POST', `/api/rewards/${rewardId}/redeem`, caregiver, { personId: caregiverId })
    expect(request.statusCode).toBe(201)
    const before = await ledgerSnapshot()
    expect((await call('POST', `/api/redemptions/${JSON.parse(request.body).redemption.id}/approve`, caregiver)).statusCode).toBe(409)
    expect(await ledgerSnapshot()).toEqual(before)
  })

  it('does not give default caregivers grant, correction or refund authority', async () => {
    const before = await ledgerSnapshot()
    const actions = [
      [`/api/persons/${childId}/award`, { amount: 2, currency: 'stars' }],
      [`/api/ledger-entries/${awardId}/correct`, { reason: 'Correct award', replacementAmount: 28, idempotencyKey: randomUUID() }],
      [`/api/redemptions/${approvedId}/refund`, { reason: 'Refund treat', idempotencyKey: randomUUID() }],
    ] as const
    for (const [path, body] of actions) {
      expect((await call('POST', path, caregiver, body)).statusCode, path).toBe(403)
    }
    expect(await ledgerSnapshot()).toEqual(before)
  })

  it('keeps guests read-only even when stale settings grant reward capabilities', async () => {
    const { rows: [household] } = await query<{ settings: Record<string, unknown> }>(
      'select settings from households where id=$1', [householdId]
    )
    const settings = { ...household.settings, permissions: { guest: {
      'reward.grant': true, 'reward.correct': true, 'reward.approve': true, 'reward.manage': true,
    } } }
    await query('update households set settings=$2::jsonb where id=$1', [householdId, JSON.stringify(settings)])
    try {
      expect((await call('GET', '/api/balances', guest)).statusCode).toBe(200)
      const before = await ledgerSnapshot()
      const actions = [
        [`/api/persons/${childId}/award`, { amount: 2, currency: 'stars' }],
        [`/api/ledger-entries/${awardId}/correct`, { reason: 'Guest correction', replacementAmount: 28, idempotencyKey: randomUUID() }],
        [`/api/redemptions/${approvedId}/refund`, { reason: 'Guest refund', idempotencyKey: randomUUID() }],
        [`/api/rewards/${rewardId}/redeem`, { personId: guestId }],
        [`/api/rewards/${rewardId}/redeem`, { personId: childId }],
        [`/api/redemptions/${approvedId}/approve`, {}],
      ] as const
      for (const [path, body] of actions) {
        const denied = await call('POST', path, guest, body)
        expect(denied.statusCode, path).toBe(403)
        expect(JSON.parse(denied.body).message).toMatch(/read.only/i)
      }
      expect(await ledgerSnapshot()).toEqual(before)
    } finally {
      await query('update households set settings=$2::jsonb where id=$1', [householdId, JSON.stringify(household.settings)])
    }
  })
})
