// Rewards domain — catalog + redemption approval + balances, against a real PG.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { Client } from 'pg'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import { runMigrations } from '../src/migrate'
import { lockLedgerSubject } from '../src/platform/ledger-lock'

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

const kevin = mint('dev|kevin')
let householdId = ''
let kevinId = ''
let foreignPersonId = ''
const foreignCurrencyKey = 'outsider-coins'

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
  foreignPersonId = await withClient(async (c) => {
    const household = await c.query<{ id: string }>(
      `insert into households (name, timezone) values ('Other rewards','UTC') returning id`
    )
    const person = await c.query<{ id: string }>(
      `insert into persons (household_id, name, member_type) values ($1,'Outsider','adult') returning id`,
      [household.rows[0].id]
    )
    await c.query(
      `insert into currencies (household_id, key, label, spendable, is_default)
       values ($1,$2,'Outsider Coins',true,true)`,
      [household.rows[0].id, foreignCurrencyKey]
    )
    return person.rows[0].id
  })
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

async function createApprovedRedemption(title: string, cost = 1, personId = kevinId, token = kevin) {
  await grantStars(personId, cost)
  const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
    title, cost, requiresApproval: false,
  })).body).reward
  const response = await call('POST', `/api/rewards/${reward.id}/redeem`, token, { personId })
  expect(response.statusCode).toBe(201)
  return JSON.parse(response.body).redemption as { id: string; ledgerId: string; cost: number }
}

// Hold the shared person-row lock until every competing HTTP transaction is
// visibly waiting for it. This makes the concurrency assertions deterministic:
// without the production lock, the barrier times out instead of occasionally
// passing because one request happened to finish before the other started.
async function waitForLockWaiters(observer: Client, expected: number, patterns: string[]): Promise<void> {
  const deadline = Date.now() + 5_000
  while (true) {
    const { rows } = await observer.query<{ count: string }>(
      `select count(*)::text as count from pg_stat_activity
        where datname=current_database()
          and pid <> pg_backend_pid()
          and wait_event_type='Lock'
          and query ilike all($1::text[])`,
      [patterns]
    )
    if (Number(rows[0]?.count ?? 0) >= expected) return
    if (Date.now() >= deadline) throw new Error('concurrent ledger operations did not reach the expected database lock')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function runBehindLedgerLock<T>(personId: string, start: () => Promise<T>[]): Promise<T[]> {
  const blocker = new Client({ connectionString: url })
  const observer = new Client({ connectionString: url })
  await Promise.all([blocker.connect(), observer.connect()])
  await blocker.query('begin')
  await blocker.query(`select id from persons where household_id=$1 and id=$2 for update`, [householdId, personId])
  const pending = start()
  let barrierError: unknown
  try {
    await waitForLockWaiters(observer, pending.length, ['%select id from persons%', '%for%update%'])
  } catch (err) {
    barrierError = err
  } finally {
    await blocker.query('commit')
    await Promise.all([blocker.end(), observer.end()])
  }
  const results = await Promise.all(pending)
  if (barrierError) throw barrierError
  return results
}

// Hold the same household-scoped advisory key used by correction/refund requests
// until every competing transaction is visibly queued behind it. This proves the
// test actually overlaps at the serialization point instead of merely firing two
// promises that might run one after the other on a busy machine.
async function runBehindCorrectionKeyLock<T>(idempotencyKey: string, start: () => Promise<T>[]): Promise<T[]> {
  const blocker = new Client({ connectionString: url })
  const observer = new Client({ connectionString: url })
  await Promise.all([blocker.connect(), observer.connect()])
  await blocker.query('begin')
  await blocker.query(
    `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
    [`reward-correction:${householdId}:${idempotencyKey.toLowerCase()}`]
  )
  const pending = start()
  let barrierError: unknown
  try {
    await waitForLockWaiters(observer, pending.length, ['%pg_advisory_xact_lock%'])
  } catch (err) {
    barrierError = err
  } finally {
    await blocker.query('commit')
    await Promise.all([blocker.end(), observer.end()])
  }
  const results = await Promise.all(pending)
  if (barrierError) throw barrierError
  return results
}

async function runBehindLedgerEntryLock<T>(entryId: string, start: () => Promise<T>[]): Promise<T[]> {
  const blocker = new Client({ connectionString: url })
  const observer = new Client({ connectionString: url })
  await Promise.all([blocker.connect(), observer.connect()])
  await blocker.query('begin')
  await blocker.query(
    `select id from ledger_entries where household_id=$1 and id=$2 for update`,
    [householdId, entryId]
  )
  const pending = start()
  let barrierError: unknown
  try {
    await waitForLockWaiters(observer, pending.length, ['%from ledger_entries%', '%for update%'])
  } catch (err) {
    barrierError = err
  } finally {
    await blocker.query('commit')
    await Promise.all([blocker.end(), observer.end()])
  }
  const results = await Promise.all(pending)
  if (barrierError) throw barrierError
  return results
}

async function runAfterConcurrentCurrencyDisable<T>(currencyId: string, start: () => Promise<T>): Promise<T> {
  const blocker = new Client({ connectionString: url })
  const observer = new Client({ connectionString: url })
  await Promise.all([blocker.connect(), observer.connect()])
  await blocker.query('begin')
  await blocker.query(`update currencies set spendable=false where household_id=$1 and id=$2`, [householdId, currencyId])
  const pending = start()
  let barrierError: unknown
  try {
    await waitForLockWaiters(observer, 1, ['%from currencies%', '%for share%'])
  } catch (err) {
    barrierError = err
  } finally {
    await blocker.query('commit')
    await Promise.all([blocker.end(), observer.end()])
  }
  const result = await pending
  if (barrierError) throw barrierError
  return result
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
  it.each([true, false])('rejects a foreign-household redemption subject (approval=%s)', async (requiresApproval) => {
    const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: `Tenant boundary ${requiresApproval}`,
      cost: 1,
      requiresApproval,
    })).body).reward

    const res = await call('POST', `/api/rewards/${reward.id}/redeem`, kevin, {
      personId: foreignPersonId,
    })

    expect(res.statusCode).toBe(404)
    const writes = await withClient(async (c) => c.query(
      `select 1 from reward_redemptions where reward_id=$1 or person_id=$2`,
      [reward.id, foreignPersonId]
    ))
    expect(writes.rowCount).toBe(0)
  })

  it('rejects reward creation with a currency outside the active household catalog', async () => {
    const res = await call('POST', '/api/rewards', kevin, {
      title: 'Unknown currency reward',
      cost: 1,
      currency: foreignCurrencyKey,
    })

    expect(res.statusCode).toBe(404)
    const writes = await withClient((c) => c.query(
      `select 1 from rewards where household_id=$1 and title='Unknown currency reward'`,
      [householdId]
    ))
    expect(writes.rowCount).toBe(0)
  })

  it('rejects moving an existing reward onto another household’s currency', async () => {
    const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: 'Keep my currency local',
      cost: 1,
    })).body).reward

    const res = await call('PATCH', `/api/rewards/${reward.id}`, kevin, {
      currency: foreignCurrencyKey,
    })

    expect(res.statusCode).toBe(404)
    const stored = await withClient(async (c) => {
      const { rows } = await c.query<{ currency: string }>(
        `select currency from rewards where id=$1`,
        [reward.id]
      )
      return rows[0]
    })
    expect(stored.currency).toBe('stars')
  })

  it('does not expose a legacy redemption whose person belongs to another household', async () => {
    const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: 'Legacy list boundary',
      cost: 1,
      requiresApproval: true,
    })).body).reward
    const redemptionId = await withClient(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `insert into reward_redemptions
           (household_id, reward_id, person_id, title, cost, currency, status, requested_by)
         values ($1,$2,$3,'Legacy list boundary',1,'stars','pending',$4) returning id`,
        [householdId, reward.id, foreignPersonId, kevinId]
      )
      return rows[0].id
    })

    const listed = JSON.parse((await call('GET', '/api/redemptions?status=pending', kevin)).body).redemptions
    expect(listed.some((r: { id: string }) => r.id === redemptionId)).toBe(false)
  })

  it('can deny, but not approve, a pending redemption after its local person is deleted', async () => {
    const personId = await addMember('Archived redeemer', 'kid', false, 'dev|archived-redeemer')
    const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: 'Archived redeemer reward',
      cost: 1,
      requiresApproval: true,
    })).body).reward
    const redemption = JSON.parse((await call(
      'POST', `/api/rewards/${reward.id}/redeem`, kevin, { personId }
    )).body).redemption
    await withClient((c) => c.query(`update persons set deleted_at=now() where id=$1`, [personId]))

    const listed = JSON.parse((await call('GET', '/api/redemptions?status=pending', kevin)).body).redemptions
    expect(listed.some((r: { id: string }) => r.id === redemption.id)).toBe(true)
    expect((await call('POST', `/api/redemptions/${redemption.id}/approve`, kevin)).statusCode).toBe(404)
    const denied = await call('POST', `/api/redemptions/${redemption.id}/deny`, kevin)
    expect(denied.statusCode).toBe(200)
    expect(JSON.parse(denied.body).redemption.status).toBe('denied')
  })

  it('cannot decide a legacy redemption for a person in another household', async () => {
    const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: 'Legacy approval boundary',
      cost: 1,
      requiresApproval: true,
    })).body).reward
    const redemptionId = await withClient(async (c) => {
      // Model data that could have been written before the request boundary was
      // enforced. The forged active-household balance makes the old approval
      // path exploitable instead of merely returning "not enough stars".
      await c.query(
        `insert into ledger_entries (household_id, person_id, currency, amount, reason, created_by)
         values ($1,$2,'stars',5,'legacy_seed',$3)`,
        [householdId, foreignPersonId, kevinId]
      )
      const { rows } = await c.query<{ id: string }>(
        `insert into reward_redemptions
           (household_id, reward_id, person_id, title, cost, currency, status, requested_by)
         values ($1,$2,$3,'Legacy approval boundary',1,'stars','pending',$4) returning id`,
        [householdId, reward.id, foreignPersonId, kevinId]
      )
      return rows[0].id
    })

    expect((await call('POST', `/api/redemptions/${redemptionId}/approve`, kevin)).statusCode).toBe(404)
    expect((await call('POST', `/api/redemptions/${redemptionId}/deny`, kevin)).statusCode).toBe(404)
    const stored = await withClient(async (c) => {
      const redemption = await c.query<{ status: string }>(
        `select status from reward_redemptions where id=$1`,
        [redemptionId]
      )
      const debit = await c.query(
        `select 1 from ledger_entries
          where household_id=$1 and person_id=$2 and reason='reward_redeemed' and ref_id=$3`,
        [householdId, foreignPersonId, redemptionId]
      )
      return { status: redemption.rows[0].status, debitCount: debit.rowCount }
    })
    expect(stored).toEqual({ status: 'pending', debitCount: 0 })
  })

  it('cannot approve a redemption after its currency becomes non-spendable', async () => {
    const currency = JSON.parse((await call('POST', '/api/currencies', kevin, {
      label: 'Tickets',
      spendable: true,
    })).body).currency
    const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: 'Ticket prize',
      cost: 2,
      currency: currency.key,
      requiresApproval: true,
    })).body).reward
    await withClient((c) => c.query(
      `insert into ledger_entries (household_id, person_id, currency, amount, reason, created_by)
       values ($1,$2,$3,5,'legacy_seed',$2)`,
      [householdId, kevinId, currency.key]
    ))
    const redemption = JSON.parse((await call(
      'POST', `/api/rewards/${reward.id}/redeem`, kevin, { personId: kevinId }
    )).body).redemption
    expect((await call('PATCH', `/api/currencies/${currency.id}`, kevin, { spendable: false })).statusCode).toBe(200)

    expect((await call('POST', `/api/redemptions/${redemption.id}/approve`, kevin)).statusCode).toBe(409)
    const stored = await withClient(async (c) => {
      const row = await c.query<{ status: string }>(`select status from reward_redemptions where id=$1`, [redemption.id])
      const debit = await c.query(`select 1 from ledger_entries where ref_id=$1 and reason='reward_redeemed'`, [redemption.id])
      return { status: row.rows[0].status, debitCount: debit.rowCount }
    })
    expect(stored).toEqual({ status: 'pending', debitCount: 0 })
  })

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

  it('a reward round-trips its category (create → read → PATCH → clear)', async () => {
    // Create with a category — it comes back on create and on list.
    const created = JSON.parse((await call('POST', '/api/rewards', kevin, { title: 'Cone', emoji: '🍦', cost: 2, category: 'treats' })).body).reward
    expect(created.category).toBe('treats')
    const listed = JSON.parse((await call('GET', '/api/rewards', kevin)).body).rewards.find((x: { id: string }) => x.id === created.id)
    expect(listed.category).toBe('treats')
    // PATCH swaps the category…
    const swapped = JSON.parse((await call('PATCH', `/api/rewards/${created.id}`, kevin, { category: 'screen' })).body).reward
    expect(swapped.category).toBe('screen')
    // …and an empty/blank category clears it back to null.
    const cleared = JSON.parse((await call('PATCH', `/api/rewards/${created.id}`, kevin, { category: '' })).body).reward
    expect(cleared.category).toBeNull()
    // Uncategorised rewards default to null.
    const plain = JSON.parse((await call('POST', '/api/rewards', kevin, { title: 'Plain', cost: 1 })).body).reward
    expect(plain.category).toBeNull()
  })
})

describe('reward redemption concurrency', () => {
  it('keeps subject serialization compatible with concurrent ledger foreign-key checks', async () => {
    const personId = await addMember('Compatible lock', 'kid', false, 'dev|compatible-lock')
    const locker = await (await import('../src/platform/db')).getPool().connect()
    const writer = new Client({ connectionString: url })
    await writer.connect()
    await writer.query(`set lock_timeout='1s'`)
    await locker.query('begin')
    await lockLedgerSubject(locker, householdId, personId)
    let insertError: unknown
    try {
      await writer.query(
        `insert into ledger_entries (household_id, person_id, currency, amount, reason, created_by)
         values ($1,$2,'stars',1,'lock_compatibility',$3)`,
        [householdId, personId, kevinId]
      )
    } catch (err) {
      insertError = err
    } finally {
      await locker.query('rollback')
      locker.release()
      await writer.end()
    }

    expect(insertError).toBeUndefined()
  })

  it('rechecks and locks the currency during an auto-approved redemption', async () => {
    const personId = await addMember('Concurrent currency auto', 'kid', false, 'dev|concurrent-currency-auto')
    const currency = JSON.parse((await call('POST', '/api/currencies', kevin, {
      label: 'Auto race tokens',
      spendable: true,
    })).body).currency
    await withClient((c) => c.query(
      `insert into ledger_entries (household_id, person_id, currency, amount, reason, created_by)
       values ($1,$2,$3,10,'currency_race_seed',$4)`,
      [householdId, personId, currency.key, kevinId]
    ))
    const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: 'Concurrent currency instant reward',
      cost: 8,
      currency: currency.key,
      requiresApproval: false,
    })).body).reward

    const result = await runAfterConcurrentCurrencyDisable(currency.id, () =>
      call('POST', `/api/rewards/${reward.id}/redeem`, kevin, { personId })
    )

    expect(result.statusCode).toBe(409)
    expect(JSON.parse(result.body).message).toBe('reward currency is no longer available')
    const writes = await withClient((c) => c.query(
      `select 1 from ledger_entries where household_id=$1 and person_id=$2 and reason='reward_redeemed'`,
      [householdId, personId]
    ))
    expect(writes.rowCount).toBe(0)
  })

  it('locks the currency while approving a pending redemption', async () => {
    const personId = await addMember('Concurrent currency approval', 'kid', false, 'dev|concurrent-currency-approval')
    const currency = JSON.parse((await call('POST', '/api/currencies', kevin, {
      label: 'Approval race tokens',
      spendable: true,
    })).body).currency
    await withClient((c) => c.query(
      `insert into ledger_entries (household_id, person_id, currency, amount, reason, created_by)
       values ($1,$2,$3,10,'currency_race_seed',$4)`,
      [householdId, personId, currency.key, kevinId]
    ))
    const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: 'Concurrent currency gated reward',
      cost: 8,
      currency: currency.key,
      requiresApproval: true,
    })).body).reward
    const redemption = JSON.parse((await call(
      'POST', `/api/rewards/${reward.id}/redeem`, kevin, { personId }
    )).body).redemption

    const result = await runAfterConcurrentCurrencyDisable(currency.id, () =>
      call('POST', `/api/redemptions/${redemption.id}/approve`, kevin)
    )

    expect(result.statusCode).toBe(409)
    const stored = await withClient((c) => c.query<{ status: string }>(
      `select status from reward_redemptions where id=$1`,
      [redemption.id]
    ))
    expect(stored.rows[0].status).toBe('pending')
  })

  it('serializes auto-approved redemptions so parallel requests cannot overspend', async () => {
    const personId = await addMember('Concurrent auto', 'kid', false, 'dev|concurrent-auto')
    await grantStars(personId, 10)
    const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: 'Concurrent instant reward',
      cost: 8,
      requiresApproval: false,
    })).body).reward

    const results = await runBehindLedgerLock(personId, () => [
      call('POST', `/api/rewards/${reward.id}/redeem`, kevin, { personId }),
      call('POST', `/api/rewards/${reward.id}/redeem`, kevin, { personId }),
    ])

    expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409])
    expect(await starsOf(personId)).toBe(2)
    const approved = await withClient((c) => c.query(
      `select id from reward_redemptions
        where household_id=$1 and person_id=$2 and reward_id=$3 and status='approved'`,
      [householdId, personId, reward.id]
    ))
    expect(approved.rowCount).toBe(1)
  })

  it('serializes approvals for different pending requests against the same balance', async () => {
    const personId = await addMember('Concurrent approval', 'kid', false, 'dev|concurrent-approval')
    await grantStars(personId, 10)
    const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: 'Concurrent gated reward',
      cost: 8,
      requiresApproval: true,
    })).body).reward
    const first = JSON.parse((await call('POST', `/api/rewards/${reward.id}/redeem`, kevin, { personId })).body).redemption
    const second = JSON.parse((await call('POST', `/api/rewards/${reward.id}/redeem`, kevin, { personId })).body).redemption

    const results = await runBehindLedgerLock(personId, () => [
      call('POST', `/api/redemptions/${first.id}/approve`, kevin),
      call('POST', `/api/redemptions/${second.id}/approve`, kevin),
    ])

    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409])
    expect(await starsOf(personId)).toBe(2)
    const statuses = await withClient((c) => c.query<{ status: string }>(
      `select status from reward_redemptions where id = any($1::uuid[]) order by status`,
      [[first.id, second.id]]
    ))
    expect(statuses.rows.map((row) => row.status)).toEqual(['approved', 'pending'])
  })

  it('uses the same balance lock for a reward and a currency conversion', async () => {
    const personId = await addMember('Concurrent ledger', 'kid', false, 'dev|concurrent-ledger')
    await grantStars(personId, 10)
    const currency = JSON.parse((await call('POST', '/api/currencies', kevin, {
      label: 'Race points',
      symbol: 'R',
    })).body).currency
    const conversion = JSON.parse((await call('POST', '/api/conversions', kevin, {
      fromCurrency: 'stars',
      toCurrency: currency.key,
      fromAmount: 8,
      toAmount: 1,
    })).body).conversion
    const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: 'Concurrent cross-path reward',
      cost: 8,
      requiresApproval: false,
    })).body).reward

    const results = await runBehindLedgerLock(personId, () => [
      call('POST', `/api/rewards/${reward.id}/redeem`, kevin, { personId }),
      call('POST', `/api/conversions/${conversion.id}/apply`, kevin, { personId, times: 1 }),
    ])

    expect(results.filter((result) => result.statusCode < 300)).toHaveLength(1)
    expect(results.filter((result) => result.statusCode === 409)).toHaveLength(1)
    expect(await starsOf(personId)).toBe(2)
    const debits = await withClient((c) => c.query(
      `select 1 from ledger_entries where household_id=$1 and person_id=$2 and currency='stars' and amount < 0`,
      [householdId, personId]
    ))
    expect(debits.rowCount).toBe(1)
  })
})

describe('append-only reward corrections and reversals', () => {
  it('reverses an award and writes a corrected replacement without editing the original', async () => {
    const before = await starsOf(kevinId)
    const award = await call('POST', `/api/persons/${kevinId}/award`, kevin, {
      amount: 10,
      note: 'Original award',
    })
    expect(award.statusCode).toBe(201)
    const originalId = JSON.parse(award.body).id as string

    const corrected = await call('POST', `/api/ledger-entries/${originalId}/correct`, kevin, {
      reason: 'Awarded four too many',
      replacementAmount: 6,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    })
    expect(corrected.statusCode).toBe(201)
    const correction = JSON.parse(corrected.body).correction
    expect(correction).toMatchObject({
      originalId,
      balance: before + 6,
      replayed: false,
    })

    const rows = await withClient((c) => c.query<{
      id: string; amount: number; reason: string; reverses_entry_id: string | null; correction_of_id: string | null; correction_reason: string | null
    }>(
      `select id, amount, reason, reverses_entry_id, correction_of_id, correction_reason
         from ledger_entries
        where id=$1 or reverses_entry_id=$1 or correction_of_id=$1
        order by created_at`,
      [originalId]
    ))
    expect(rows.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: originalId, amount: 10, reason: 'spot_award', reverses_entry_id: null, correction_of_id: null }),
      expect.objectContaining({ amount: -10, reason: 'ledger_reversal', reverses_entry_id: originalId, correction_reason: 'Awarded four too many' }),
      expect.objectContaining({ amount: 6, reason: 'ledger_correction', correction_of_id: originalId, correction_reason: 'Awarded four too many' }),
    ]))

    const overview = JSON.parse((await call('GET', `/api/persons/${kevinId}/overview`, kevin)).body)
    expect(overview.recentLedger.find((entry: { id: string }) => entry.id === originalId)).toMatchObject({
      reversedById: correction.reversalId,
      reversible: false,
    })
    expect(overview.recentLedger.find((entry: { id: string }) => entry.id === correction.reversalId)).toMatchObject({
      reason: 'ledger_reversal',
      correctionReason: 'Awarded four too many',
    })
    expect(overview.recentLedger.find((entry: { id: string }) => entry.id === correction.replacementId)).toMatchObject({
      reason: 'ledger_correction',
      correctionOfId: originalId,
      correctionReason: 'Awarded four too many',
    })
  })

  it('replays the same correction idempotently and blocks a second reversal', async () => {
    const award = JSON.parse((await call('POST', `/api/persons/${kevinId}/award`, kevin, { amount: 3 })).body)
    const body = {
      reason: 'Duplicate request test',
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
    }
    expect((await call('POST', `/api/ledger-entries/${award.id}/correct`, kevin, body)).statusCode).toBe(201)
    const replay = await call('POST', `/api/ledger-entries/${award.id}/correct`, kevin, body)
    expect(replay.statusCode).toBe(200)
    expect(JSON.parse(replay.body).correction.replayed).toBe(true)
    const changedReason = await call('POST', `/api/ledger-entries/${award.id}/correct`, kevin, {
      ...body,
      reason: 'Same key but a different audit reason',
    })
    expect(changedReason.statusCode).toBe(409)
    expect(JSON.parse(changedReason.body).message).toContain('different correction details')
    const changedAmount = await call('POST', `/api/ledger-entries/${award.id}/correct`, kevin, {
      ...body,
      replacementAmount: 2,
    })
    expect(changedAmount.statusCode).toBe(409)
    expect(JSON.parse(changedAmount.body).message).toContain('different correction details')
    expect((await call('POST', `/api/ledger-entries/${award.id}/correct`, kevin, {
      reason: 'Try a second reversal',
      idempotencyKey: '33333333-3333-4333-8333-333333333333',
    })).statusCode).toBe(409)
    const reversals = await withClient((c) => c.query(
      `select id from ledger_entries where household_id=$1 and reverses_entry_id=$2`,
      [householdId, award.id]
    ))
    expect(reversals.rowCount).toBe(1)
  })

  it('normalizes UUID casing when replaying a correction request', async () => {
    const award = JSON.parse((await call('POST', `/api/persons/${kevinId}/award`, kevin, { amount: 4 })).body)
    const key = 'abcdefab-cdef-4abc-8def-abcdefabcdef'
    const body = { reason: 'UUID casing retry', idempotencyKey: key }

    expect((await call('POST', `/api/ledger-entries/${award.id}/correct`, kevin, body)).statusCode).toBe(201)
    const replay = await call('POST', `/api/ledger-entries/${award.id.toUpperCase()}/correct`, kevin, {
      ...body,
      idempotencyKey: key.toUpperCase(),
    })

    expect(replay.statusCode).toBe(200)
    expect(JSON.parse(replay.body).correction.replayed).toBe(true)
  })

  it('serializes different correction keys targeting the same ledger entry', async () => {
    const award = JSON.parse((await call('POST', `/api/persons/${kevinId}/award`, kevin, { amount: 8 })).body)
    const corrections = await runBehindLedgerEntryLock(award.id, () => [
      call('POST', `/api/ledger-entries/${award.id}/correct`, kevin, {
        reason: 'First overlapping correction',
        replacementAmount: 6,
        idempotencyKey: '91919191-9191-4191-8191-919191919191',
      }),
      call('POST', `/api/ledger-entries/${award.id}/correct`, kevin, {
        reason: 'Second overlapping correction',
        replacementAmount: 7,
        idempotencyKey: '92929292-9292-4292-8292-929292929292',
      }),
    ])

    expect(corrections.map((result) => result.statusCode).sort()).toEqual([201, 409])
    expect(corrections.find((result) => result.statusCode === 409)?.body).toContain('already been corrected')
  })

  it('serializes concurrent retries and rejects concurrent key reuse for another entry', async () => {
    const firstAward = JSON.parse((await call('POST', `/api/persons/${kevinId}/award`, kevin, { amount: 9 })).body)
    const retryBody = {
      reason: 'Concurrent retry test',
      replacementAmount: 7,
      idempotencyKey: '99999999-9999-4999-8999-999999999999',
    }
    const retries = await runBehindCorrectionKeyLock(retryBody.idempotencyKey, () => [
      call('POST', `/api/ledger-entries/${firstAward.id}/correct`, kevin, retryBody),
      call('POST', `/api/ledger-entries/${firstAward.id}/correct`, kevin, retryBody),
    ])
    expect(retries.map((r) => r.statusCode).sort()).toEqual([200, 201])
    expect(retries.map((r) => JSON.parse(r.body).correction.replayed).sort()).toEqual([false, true])

    const secondAward = JSON.parse((await call('POST', `/api/persons/${kevinId}/award`, kevin, { amount: 5 })).body)
    const thirdAward = JSON.parse((await call('POST', `/api/persons/${kevinId}/award`, kevin, { amount: 6 })).body)
    const sharedKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const collisions = await runBehindCorrectionKeyLock(sharedKey, () => [
      call('POST', `/api/ledger-entries/${secondAward.id}/correct`, kevin, {
        reason: 'First use of shared key', idempotencyKey: sharedKey,
      }),
      call('POST', `/api/ledger-entries/${thirdAward.id}/correct`, kevin, {
        reason: 'Second use of shared key', idempotencyKey: sharedKey,
      }),
    ])
    expect(collisions.map((r) => r.statusCode).sort()).toEqual([201, 409])
    expect(collisions.find((r) => r.statusCode === 409)?.body).toContain('another correction')

    const sharedKeyRows = await withClient((c) => c.query(
      `select id from ledger_entries where household_id=$1 and idempotency_key=$2`,
      [householdId, sharedKey]
    ))
    expect(sharedKeyRows.rowCount).toBe(1)
  })

  it('rejects values that cannot be stored or reversed as PostgreSQL integers', async () => {
    const award = JSON.parse((await call('POST', `/api/persons/${kevinId}/award`, kevin, { amount: 2 })).body)
    const oversized = await call('POST', `/api/ledger-entries/${award.id}/correct`, kevin, {
      reason: 'Amount is outside the ledger range',
      replacementAmount: 2_147_483_648,
      idempotencyKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    })
    expect(oversized.statusCode).toBe(400)
    expect(JSON.parse(oversized.body).message).toContain('32-bit signed integer')

    const minimumPersonId = await addMember('Minimum integer ledger', 'kid', false, 'dev|min-ledger')
    const minimumEntry = await withClient(async (c) => {
      const row = await c.query<{ id: string }>(
        `insert into ledger_entries (household_id, person_id, currency, amount, reason, created_by)
         values ($1,$2,'stars',$3,'spot_award',$4) returning id`,
        [householdId, minimumPersonId, -2_147_483_648, kevinId]
      )
      return row.rows[0].id
    })
    const unrepresentableReversal = await call('POST', `/api/ledger-entries/${minimumEntry}/correct`, kevin, {
      reason: 'Cannot negate the minimum integer',
      idempotencyKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    })
    expect(unrepresentableReversal.statusCode).toBe(409)
    expect(JSON.parse(unrepresentableReversal.body).message).toContain('cannot be reversed')
    const reversals = await withClient((c) => c.query(
      `select id from ledger_entries where household_id=$1 and reverses_entry_id=$2`,
      [householdId, minimumEntry]
    ))
    expect(reversals.rowCount).toBe(0)
  })

  it('enforces tenant and reward.correct capability boundaries', async () => {
    const foreignEntry = await withClient(async (c) => {
      const row = await c.query<{ id: string }>(
        `insert into ledger_entries (household_id, person_id, currency, amount, reason)
         select household_id, id, 'stars', 5, 'spot_award' from persons where id=$1 returning id`,
        [foreignPersonId]
      )
      return row.rows[0].id
    })
    expect((await call('POST', `/api/ledger-entries/${foreignEntry}/correct`, kevin, {
      reason: 'Cross tenant attempt',
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
    })).statusCode).toBe(404)

    const foreignRedemption = await withClient(async (c) => {
      const household = await c.query<{ household_id: string }>(
        `select household_id from persons where id=$1`,
        [foreignPersonId]
      )
      const reward = await c.query<{ id: string }>(
        `insert into rewards (household_id, title, cost) values ($1,'Foreign reward',1) returning id`,
        [household.rows[0].household_id]
      )
      const row = await c.query<{ id: string }>(
        `insert into reward_redemptions
           (household_id, reward_id, person_id, title, cost, status, requested_by)
         values ($1,$2,$3,'Foreign reward',1,'pending',$3) returning id`,
        [household.rows[0].household_id, reward.rows[0].id, foreignPersonId]
      )
      return row.rows[0].id
    })
    expect((await call('POST', `/api/redemptions/${foreignRedemption}/cancel`, kevin)).statusCode).toBe(404)
    expect((await call('POST', `/api/redemptions/${foreignRedemption}/refund`, kevin, {
      reason: 'Cross tenant refund attempt',
      idempotencyKey: '45454545-4545-4545-8545-454545454545',
    })).statusCode).toBe(404)

    const kidId = await addMember('No corrections', 'kid', false, 'dev|no-corrections')
    const kid = mint('dev|no-corrections')
    const ownEntry = JSON.parse((await call('POST', `/api/persons/${kidId}/award`, kevin, { amount: 2 })).body).id
    expect((await call('POST', `/api/ledger-entries/${ownEntry}/correct`, kid, {
      reason: 'Not permitted',
      idempotencyKey: '55555555-5555-4555-8555-555555555555',
    })).statusCode).toBe(403)

    const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: 'No-cap refund', cost: 1, requiresApproval: false,
    })).body).reward
    await grantStars(kidId, 1)
    const redemption = JSON.parse((await call('POST', `/api/rewards/${reward.id}/redeem`, kid, {
      personId: kidId,
    })).body).redemption
    expect((await call('POST', `/api/redemptions/${redemption.id}/refund`, kid, {
      reason: 'Not permitted to refund',
      idempotencyKey: '56565656-5656-4656-8656-565656565656',
    })).statusCode).toBe(403)
  })

  it('does not allow a one-sided correction of a paired currency conversion', async () => {
    const conversionEntry = await withClient(async (c) => {
      const row = await c.query<{ id: string }>(
        `insert into ledger_entries
           (household_id, person_id, currency, amount, reason, ref_type, created_by)
         values ($1,$2,'stars',-2,'conversion','currency_conversion',$2) returning id`,
        [householdId, kevinId]
      )
      return row.rows[0].id
    })
    const before = await starsOf(kevinId)
    const response = await call('POST', `/api/ledger-entries/${conversionEntry}/correct`, kevin, {
      reason: 'Would break the paired conversion',
      idempotencyKey: '88888888-8888-4888-8888-888888888888',
    })
    expect(response.statusCode).toBe(409)
    expect(JSON.parse(response.body).message).toContain('original feature')
    expect(await starsOf(kevinId)).toBe(before)
  })

  it('cancels pending requests without touching the balance', async () => {
    const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: 'Pending cancellation', cost: 1, requiresApproval: true,
    })).body).reward
    const before = await starsOf(kevinId)
    const redemption = JSON.parse((await call('POST', `/api/rewards/${reward.id}/redeem`, kevin, {
      personId: kevinId,
    })).body).redemption
    expect(redemption.requestedBy).toBe(kevinId)

    const canceled = await call('POST', `/api/redemptions/${redemption.id}/cancel`, kevin)
    expect(canceled.statusCode).toBe(200)
    expect(JSON.parse(canceled.body).redemption.status).toBe('canceled')
    expect(await starsOf(kevinId)).toBe(before)
    expect((await call('POST', `/api/redemptions/${redemption.id}/refund`, kevin, {
      reason: 'Pending is not settled',
      idempotencyKey: '66666666-6666-4666-8666-666666666666',
    })).statusCode).toBe(409)
  })

  it('authorizes cancellation by requester, not merely by redemption subject', async () => {
    const subjectId = await addMember('Cancellation subject', 'kid', false, 'dev|cancel-subject')
    const subjectToken = mint('dev|cancel-subject')
    const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: 'Requester-aware cancellation', cost: 1, requiresApproval: true,
    })).body).reward

    const requestedForSubject = JSON.parse((await call('POST', `/api/rewards/${reward.id}/redeem`, kevin, {
      personId: subjectId,
    })).body).redemption
    expect(requestedForSubject).toMatchObject({ personId: subjectId, requestedBy: kevinId, status: 'pending' })
    const overview = JSON.parse((await call('GET', `/api/persons/${subjectId}/overview`, kevin)).body)
    expect(overview.redemptions.find((r: { id: string }) => r.id === requestedForSubject.id)?.requestedBy).toBe(kevinId)
    expect((await call('POST', `/api/redemptions/${requestedForSubject.id}/cancel`, subjectToken)).statusCode).toBe(403)
    expect((await call('POST', `/api/redemptions/${requestedForSubject.id}/cancel`, kevin)).statusCode).toBe(200)

    const selfRequested = JSON.parse((await call('POST', `/api/rewards/${reward.id}/redeem`, subjectToken, {
      personId: subjectId,
    })).body).redemption
    expect(selfRequested.requestedBy).toBe(subjectId)
    expect((await call('POST', `/api/redemptions/${selfRequested.id}/cancel`, subjectToken)).statusCode).toBe(200)
  })

  it('does not acquire a second pool connection while authorizing a cancellation', async () => {
    const approverId = await addMember('Cancellation approver', 'adult', false, 'dev|cancel-approver')
    const approver = mint('dev|cancel-approver')
    const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: 'Pool-safe cancellation', cost: 1, requiresApproval: true,
    })).body).reward
    const redemption = JSON.parse((await call('POST', `/api/rewards/${reward.id}/redeem`, kevin, {
      personId: approverId,
    })).body).redemption
    const pool = (await import('../src/platform/db')).getPool()
    const held = await Promise.all(Array.from(
      { length: (pool.options.max ?? 10) - 1 },
      () => pool.connect()
    ))
    let settled = false
    const pending = call('POST', `/api/redemptions/${redemption.id}/cancel`, approver)
      .then((result) => { settled = true; return result })
    const deadline = Date.now() + 2_000
    while (!settled && pool.waitingCount === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const waitedForNestedConnection = pool.waitingCount > 0
    held.forEach((client) => client.release())
    const result = await pending

    expect(waitedForNestedConnection).toBe(false)
    expect(result.statusCode).toBe(200)
  })

  it('keeps historical cancellation and refund actions available when the rewards shop is off', async () => {
    const pendingReward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: 'Cancel after shop disabled', cost: 1, requiresApproval: true,
    })).body).reward
    const pending = JSON.parse((await call('POST', `/api/rewards/${pendingReward.id}/redeem`, kevin, {
      personId: kevinId,
    })).body).redemption
    const approvedReward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: 'Refund after shop disabled', cost: 1, requiresApproval: false,
    })).body).reward
    await grantStars(kevinId, 1)
    const approved = JSON.parse((await call('POST', `/api/rewards/${approvedReward.id}/redeem`, kevin, {
      personId: kevinId,
    })).body).redemption

    await withClient((c) => c.query(
      `update households set settings = coalesce(settings,'{}'::jsonb)
         || jsonb_build_object('chores', jsonb_build_object('rewards', false)) where id=$1`,
      [householdId]
    ))
    let canceled: RunResult
    let refunded: RunResult
    try {
      canceled = await call('POST', `/api/redemptions/${pending.id}/cancel`, kevin)
      refunded = await call('POST', `/api/redemptions/${approved.id}/refund`, kevin, {
        reason: 'Shop was disabled after redemption',
        idempotencyKey: '10101010-1010-4010-8010-101010101010',
      })
    } finally {
      await withClient((c) => c.query(
        `update households set settings = coalesce(settings,'{}'::jsonb)
           || jsonb_build_object('chores', jsonb_build_object('rewards', true)) where id=$1`,
        [householdId]
      ))
    }

    expect(canceled.statusCode).toBe(200)
    expect(refunded.statusCode).toBe(200)
  })

  it('returns 400 instead of throwing when correction request fields are not strings', async () => {
    const award = JSON.parse((await call('POST', `/api/persons/${kevinId}/award`, kevin, {
      amount: 2,
    })).body)
    const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: 'Malformed refund request', cost: 1, requiresApproval: false,
    })).body).reward
    await grantStars(kevinId, 1)
    const redemption = JSON.parse((await call('POST', `/api/rewards/${reward.id}/redeem`, kevin, {
      personId: kevinId,
    })).body).redemption

    const requests = await Promise.all([
      call('POST', `/api/ledger-entries/${award.id}/correct`, kevin, {
        reason: 123,
        idempotencyKey: '12121212-1212-4212-8212-121212121212',
      }),
      call('POST', `/api/ledger-entries/${award.id}/correct`, kevin, {
        reason: 'Valid correction reason',
        idempotencyKey: 123,
      }),
      call('POST', `/api/redemptions/${redemption.id}/refund`, kevin, {
        reason: 123,
        idempotencyKey: '13131313-1313-4313-8313-131313131313',
      }),
      call('POST', `/api/redemptions/${redemption.id}/refund`, kevin, {
        reason: 'Valid refund reason',
        idempotencyKey: 123,
      }),
      call('POST', `/api/ledger-entries/${award.id}/correct`, kevin, 7),
      call('POST', `/api/redemptions/${redemption.id}/refund`, kevin, 7),
      call('POST', `/api/ledger-entries/${award.id}/correct`, kevin, {
        reason: 'Invalid\u0000database text',
        idempotencyKey: '14141414-1414-4414-8414-141414141414',
      }),
      call('POST', `/api/redemptions/${redemption.id}/refund`, kevin, {
        reason: 'Invalid\u0000database text',
        idempotencyKey: '15151515-1515-4515-8515-151515151515',
      }),
    ])

    expect(requests.map((request) => request.statusCode)).toEqual([400, 400, 400, 400, 400, 400, 400, 400])
  })

  it('refuses to refund a ledger row whose semantics do not match the redemption', async () => {
    const otherPersonId = await addMember('Refund link mismatch', 'kid', false, 'dev|refund-link-mismatch')
    const corruptions = [
      { name: 'reason', sql: `update ledger_entries set reason='spot_award' where id=$1` },
      { name: 'reference type', sql: `update ledger_entries set ref_type='chore_instance' where id=$1` },
      { name: 'reference id', sql: `update ledger_entries set ref_id=gen_random_uuid() where id=$1` },
      { name: 'person', sql: `update ledger_entries set person_id=$2 where id=$1` },
      { name: 'currency', sql: `update ledger_entries set currency='mismatch-coins' where id=$1` },
      { name: 'amount', sql: `update ledger_entries set amount=amount - 1 where id=$1` },
    ]

    for (const [index, corruption] of corruptions.entries()) {
      const redemption = await createApprovedRedemption(`Mismatched refund ${index}`, 3)
      const params = corruption.sql.includes('$2')
        ? [redemption.ledgerId, otherPersonId]
        : [redemption.ledgerId]
      await withClient((c) => c.query(corruption.sql, params))

      const response = await call('POST', `/api/redemptions/${redemption.id}/refund`, kevin, {
        reason: `Reject mismatched ${corruption.name}`,
        idempotencyKey: randomUUID(),
      })

      expect(response.statusCode, corruption.name).toBe(409)
      expect(JSON.parse(response.body).message).toContain('does not match')
      const stored = await withClient((c) => c.query<{ status: string; refund_ledger_id: string | null; reversals: number }>(
        `select r.status, r.refund_ledger_id,
                (select count(*)::int from ledger_entries le where le.reverses_entry_id=r.ledger_id) as reversals
           from reward_redemptions r
          where r.household_id=$1 and r.id=$2`,
        [householdId, redemption.id]
      ))
      expect(stored.rows[0]).toMatchObject({ status: 'approved', refund_ledger_id: null, reversals: 0 })
    }
  })

  it('preserves the original approval actor and time when recording a refund', async () => {
    const childId = await addMember('Refund audit child', 'kid', false, 'dev|refund-audit-child')
    const child = mint('dev|refund-audit-child')
    const correctorId = await addMember('Refund audit corrector', 'adult', false, 'dev|refund-audit-corrector')
    const corrector = mint('dev|refund-audit-corrector')
    await grantStars(childId, 2)
    const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: 'Approval audit reward', cost: 2, requiresApproval: true,
    })).body).reward
    const redemption = JSON.parse((await call('POST', `/api/rewards/${reward.id}/redeem`, child, {
      personId: childId,
    })).body).redemption
    expect((await call('POST', `/api/redemptions/${redemption.id}/approve`, kevin)).statusCode).toBe(200)
    const before = await withClient((c) => c.query<{ decided_by: string; decided_at: Date }>(
      `select decided_by, decided_at from reward_redemptions where household_id=$1 and id=$2`,
      [householdId, redemption.id]
    ))

    const refunded = await call('POST', `/api/redemptions/${redemption.id}/refund`, corrector, {
      reason: 'Preserve the approval audit record',
      idempotencyKey: randomUUID(),
    })

    expect(refunded.statusCode).toBe(200)
    const after = await withClient((c) => c.query<{
      decided_by: string; decided_at: Date; refunded_by: string
    }>(
      `select r.decided_by, r.decided_at, le.created_by as refunded_by
         from reward_redemptions r
         join ledger_entries le
           on le.household_id=r.household_id and le.id=r.refund_ledger_id
        where r.household_id=$1 and r.id=$2`,
      [householdId, redemption.id]
    ))
    expect(after.rows[0].decided_by).toBe(before.rows[0].decided_by)
    expect(after.rows[0].decided_at).toEqual(before.rows[0].decided_at)
    expect(after.rows[0].refunded_by).toBe(correctorId)
  })

  it('rejects a refund replay when the redemption no longer links to that reversal', async () => {
    const redemption = await createApprovedRedemption('Refund replay linkage', 2)
    const body = {
      reason: 'Replay must match the recorded refund',
      idempotencyKey: randomUUID(),
    }
    expect((await call('POST', `/api/redemptions/${redemption.id}/refund`, kevin, body)).statusCode).toBe(200)
    await withClient((c) => c.query(
      `update reward_redemptions set refund_ledger_id=null where household_id=$1 and id=$2`,
      [householdId, redemption.id]
    ))

    const replay = await call('POST', `/api/redemptions/${redemption.id}/refund`, kevin, body)

    expect(replay.statusCode).toBe(409)
    expect(JSON.parse(replay.body).message).toContain('recorded refund')
  })

  it('rejects a refund replay when the original debit no longer matches the redemption', async () => {
    const redemption = await createApprovedRedemption('Refund replay debit', 2)
    const body = {
      reason: 'Replay must validate the original debit',
      idempotencyKey: randomUUID(),
    }
    expect((await call('POST', `/api/redemptions/${redemption.id}/refund`, kevin, body)).statusCode).toBe(200)
    await withClient((c) => c.query(
      `update ledger_entries set reason='spot_award' where household_id=$1 and id=$2`,
      [householdId, redemption.ledgerId]
    ))

    const replay = await call('POST', `/api/redemptions/${redemption.id}/refund`, kevin, body)

    expect(replay.statusCode).toBe(409)
    expect(JSON.parse(replay.body).message).toContain('does not match')
  })

  it('keeps overview detail and reversal joins inside the active household', async () => {
    const localTarget = JSON.parse((await call('POST', `/api/persons/${kevinId}/award`, kevin, {
      amount: 7,
    })).body).id as string
    const deletedReversalTarget = JSON.parse((await call('POST', `/api/persons/${kevinId}/award`, kevin, {
      amount: 5,
    })).body).id as string
    const seeded = await withClient(async (c) => {
      const foreign = await c.query<{ household_id: string }>(
        `select household_id from persons where id=$1`,
        [foreignPersonId]
      )
      const foreignHouseholdId = foreign.rows[0].household_id
      const reward = await c.query<{ id: string }>(
        `insert into rewards (household_id, title, cost) values ($1,'Private foreign reward',1) returning id`,
        [foreignHouseholdId]
      )
      const redemption = await c.query<{ id: string }>(
        `insert into reward_redemptions
           (household_id, reward_id, person_id, title, cost, status, requested_by)
         values ($1,$2,$3,'Private foreign redemption',1,'approved',$3) returning id`,
        [foreignHouseholdId, reward.rows[0].id, foreignPersonId]
      )
      const chore = await c.query<{ id: string }>(
        `insert into chores (household_id, title, person_id) values ($1,'Private foreign chore',$2) returning id`,
        [foreignHouseholdId, foreignPersonId]
      )
      const instance = await c.query<{ id: string }>(
        `insert into chore_instances (household_id, chore_id, person_id, due_on)
         values ($1,$2,$3,current_date) returning id`,
        [foreignHouseholdId, chore.rows[0].id, foreignPersonId]
      )
      await c.query(
        `insert into ledger_entries
           (household_id, person_id, currency, amount, reason, reverses_entry_id, created_by)
         values ($1,$2,'stars',-7,'ledger_reversal',$3,$2)`,
        [foreignHouseholdId, foreignPersonId, localTarget]
      )
      const deletedReversal = await c.query<{ id: string }>(
        `insert into ledger_entries
           (household_id, person_id, currency, amount, reason, reverses_entry_id, created_by, deleted_at)
         values ($1,$2,'stars',-5,'ledger_reversal',$3,$2,now()) returning id`,
        [householdId, kevinId, deletedReversalTarget]
      )
      const detailRows = await c.query<{ id: string; ref_type: string }>(
        `insert into ledger_entries
           (household_id, person_id, currency, amount, reason, ref_type, ref_id, created_by)
         values
           ($1,$2,'stars',1,'spot_award','reward_redemption',$3,$2),
           ($1,$2,'stars',1,'spot_award','chore_instance',$4,$2)
         returning id, ref_type`,
        [householdId, kevinId, redemption.rows[0].id, instance.rows[0].id]
      )
      return {
        deletedReversalId: deletedReversal.rows[0].id,
        rewardDetailId: detailRows.rows.find((row) => row.ref_type === 'reward_redemption')!.id,
        choreDetailId: detailRows.rows.find((row) => row.ref_type === 'chore_instance')!.id,
      }
    })

    const overview = JSON.parse((await call('GET', `/api/persons/${kevinId}/overview`, kevin)).body)
    const entry = (id: string) => overview.recentLedger.find((row: { id: string }) => row.id === id)
    expect(entry(localTarget)).toMatchObject({ reversedById: null, reversible: true })
    expect(entry(deletedReversalTarget)).toMatchObject({
      reversedById: seeded.deletedReversalId,
      reversible: false,
    })
    expect(entry(seeded.rewardDetailId)).toMatchObject({ detail: null, redemptionId: null })
    expect(entry(seeded.choreDetailId)).toMatchObject({ detail: null })
  })

  it('refunds an approved redemption once and restores the balance', async () => {
    const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: 'Refundable reward', cost: 4, requiresApproval: false,
    })).body).reward
    await grantStars(kevinId, 4)
    const beforeRedeem = await starsOf(kevinId)
    const redemption = JSON.parse((await call('POST', `/api/rewards/${reward.id}/redeem`, kevin, {
      personId: kevinId,
    })).body).redemption
    expect(await starsOf(kevinId)).toBe(beforeRedeem - 4)

    const body = {
      reason: 'Reward could not be delivered',
      idempotencyKey: '77777777-7777-4777-8777-777777777777',
    }
    const refunded = await call('POST', `/api/redemptions/${redemption.id}/refund`, kevin, body)
    expect(refunded.statusCode).toBe(200)
    const refundResult = JSON.parse(refunded.body)
    expect(refundResult.redemption.status).toBe('refunded')
    expect(await starsOf(kevinId)).toBe(beforeRedeem)

    const overview = JSON.parse((await call('GET', `/api/persons/${kevinId}/overview`, kevin)).body)
    expect(overview.redemptions.find((entry: { id: string }) => entry.id === redemption.id)).toMatchObject({
      status: 'refunded',
      ledgerId: redemption.ledgerId,
      refundLedgerId: refundResult.correction.reversalId,
    })
    expect(overview.recentLedger.find((entry: { id: string }) => entry.id === redemption.ledgerId)).toMatchObject({
      reversedById: refundResult.correction.reversalId,
      reversible: false,
      redemptionId: redemption.id,
    })
    expect(overview.recentLedger.find((entry: { id: string }) => entry.id === refundResult.correction.reversalId)).toMatchObject({
      reason: 'ledger_reversal',
      correctionReason: 'Reward could not be delivered',
      redemptionId: redemption.id,
    })

    const replay = await call('POST', `/api/redemptions/${redemption.id}/refund`, kevin, body)
    expect(replay.statusCode).toBe(200)
    expect(JSON.parse(replay.body).correction.replayed).toBe(true)
    expect(await starsOf(kevinId)).toBe(beforeRedeem)

    const changedReason = await call('POST', `/api/redemptions/${redemption.id}/refund`, kevin, {
      ...body,
      reason: 'Same key but a different refund reason',
    })
    expect(changedReason.statusCode).toBe(409)
    expect(JSON.parse(changedReason.body).message).toContain('different correction details')

    const differentRequest = await call('POST', `/api/redemptions/${redemption.id}/refund`, kevin, {
      reason: 'A new request is not a retry',
      idempotencyKey: 'f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0',
    })
    expect(differentRequest.statusCode).toBe(409)
    expect(JSON.parse(differentRequest.body).message).toContain('already been refunded')
  })

  it('serializes a refund key reused concurrently for different redemptions', async () => {
    const redemptions: Array<{ id: string }> = []
    for (const title of ['First refund collision', 'Second refund collision']) {
      const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
        title, cost: 1, requiresApproval: false,
      })).body).reward
      await grantStars(kevinId, 1)
      const redeemed = await call('POST', `/api/rewards/${reward.id}/redeem`, kevin, {
        personId: kevinId,
      })
      expect(redeemed.statusCode).toBe(201)
      redemptions.push(JSON.parse(redeemed.body).redemption)
    }
    const idempotencyKey = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const refunds = await runBehindCorrectionKeyLock(idempotencyKey, () => redemptions.map((redemption) =>
      call('POST', `/api/redemptions/${redemption.id}/refund`, kevin, {
        reason: 'Concurrent refund key collision', idempotencyKey,
      })
    ))
    expect(refunds.map((r) => r.statusCode).sort()).toEqual([200, 409])
    expect(refunds.find((r) => r.statusCode === 409)?.body).toContain('another correction')
    const keyRows = await withClient((c) => c.query(
      `select id from ledger_entries where household_id=$1 and idempotency_key=$2`,
      [householdId, idempotencyKey]
    ))
    expect(keyRows.rowCount).toBe(1)
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

  it('a member may redeem for self but needs reward.manage to redeem for someone else', async () => {
    const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: 'Actor-scoped reward',
      cost: 1,
      requiresApproval: true,
    })).body).reward

    expect((await call('POST', `/api/rewards/${reward.id}/redeem`, kidToken, { personId: kidId })).statusCode).toBe(201)
    expect((await call('POST', `/api/rewards/${reward.id}/redeem`, kidToken, { personId: adultId })).statusCode).toBe(403)
    expect((await call('POST', `/api/rewards/${reward.id}/redeem`, adultToken, { personId: kidId })).statusCode).toBe(201)
  })

  it('treats an uppercase UUID spelling as the same self redemption subject', async () => {
    const reward = JSON.parse((await call('POST', '/api/rewards', kevin, {
      title: 'Canonical self identity',
      cost: 1,
      requiresApproval: true,
    })).body).reward

    expect((await call('POST', `/api/rewards/${reward.id}/redeem`, kidToken, {
      personId: kidId.toUpperCase(),
    })).statusCode).toBe(201)
  })

  it('exposes capabilities on /api/household', async () => {
    const kid = JSON.parse((await call('GET', '/api/household', kidToken)).body).person
    expect(kid.capabilities).toEqual([])
    const adult = JSON.parse((await call('GET', '/api/household', adultToken)).body).person
    expect(adult.capabilities).toContain('reward.approve')
  })
})

// Ad-hoc "spot-award" stars — a parent hands out stars on the spot, not tied to
// any chore. A single positive ledger entry (reason 'spot_award'); no balance
// guard (it only ever adds). Gated by the NEW reward.grant capability.
describe('spot-award stars', () => {
  let adultId = '', kidId = '', teenId = '', adultToken = '', kidToken = '', teenToken = ''

  beforeAll(async () => {
    adultId = await addMember('SpotAdult', 'adult', false, 'dev|spot-adult')
    kidId = await addMember('SpotKid', 'kid', false, 'dev|spot-kid')
    teenId = await addMember('SpotTeen', 'teen', false, 'dev|spot-teen')
    adultToken = mint('dev|spot-adult'); kidToken = mint('dev|spot-kid'); teenToken = mint('dev|spot-teen')
  })

  it('awarding N stars increases the balance by N (admin)', async () => {
    const before = await starsOf(kidId)
    const res = await call('POST', `/api/persons/${kidId}/award`, kevin, { amount: 5 })
    expect(res.statusCode).toBe(201)
    expect(await starsOf(kidId)).toBe(before + 5)
  })

  it('a non-admin adult (reward.grant by default) can award', async () => {
    const before = await starsOf(kidId)
    expect((await call('POST', `/api/persons/${kidId}/award`, adultToken, { amount: 3 })).statusCode).toBe(201)
    expect(await starsOf(kidId)).toBe(before + 3)
  })

  it('a kid or teen (no reward.grant) is blocked (403)', async () => {
    expect((await call('POST', `/api/persons/${kidId}/award`, kidToken, { amount: 2 })).statusCode).toBe(403)
    expect((await call('POST', `/api/persons/${kidId}/award`, teenToken, { amount: 2 })).statusCode).toBe(403)
  })

  it('cannot award a person from another household', async () => {
    const res = await call('POST', `/api/persons/${foreignPersonId}/award`, kevin, { amount: 2 })
    expect(res.statusCode).toBe(404)
    const writes = await withClient((c) => c.query(
      `select 1 from ledger_entries where household_id=$1 and person_id=$2 and reason='spot_award'`,
      [householdId, foreignPersonId]
    ))
    expect(writes.rowCount).toBe(0)
  })

  it('can award an active earn-only currency but not another household’s currency', async () => {
    const currency = JSON.parse((await call('POST', '/api/currencies', kevin, {
      label: 'Practice Points',
      spendable: false,
    })).body).currency

    expect((await call('POST', `/api/persons/${kidId}/award`, kevin, {
      amount: 2,
      currency: currency.key,
    })).statusCode).toBe(201)
    expect((await call('POST', `/api/persons/${kidId}/award`, kevin, {
      amount: 2,
      currency: foreignCurrencyKey,
    })).statusCode).toBe(404)

    const amounts = await withClient(async (c) => {
      const local = await c.query<{ total: string }>(
        `select coalesce(sum(amount),0) as total from ledger_entries
          where household_id=$1 and person_id=$2 and currency=$3 and reason='spot_award'`,
        [householdId, kidId, currency.key]
      )
      const foreign = await c.query(
        `select 1 from ledger_entries
          where household_id=$1 and person_id=$2 and currency=$3 and reason='spot_award'`,
        [householdId, kidId, foreignCurrencyKey]
      )
      return { local: Number(local.rows[0].total), foreignCount: foreign.rowCount }
    })
    expect(amounts).toEqual({ local: 2, foreignCount: 0 })
  })

  it('stores the note on the ledger entry', async () => {
    const res = await call('POST', `/api/persons/${kidId}/award`, kevin, { amount: 1, note: 'so helpful today' })
    expect(res.statusCode).toBe(201)
    const note = await withClient(async (c) => {
      const { rows } = await c.query<{ note: string | null; reason: string }>(
        `select note, reason from ledger_entries where household_id=$1 and person_id=$2 and reason='spot_award' order by created_at desc limit 1`,
        [householdId, kidId]
      )
      return rows[0]
    })
    expect(note.note).toBe('so helpful today')
    expect(note.reason).toBe('spot_award')
  })

  it('advances the saving-toward jar (balance-derived)', async () => {
    // Pin a reward this kid is saving toward, then spot-award and watch progress move.
    const r = JSON.parse((await call('POST', '/api/rewards', kevin, { title: 'Spot toy', cost: 100 })).body).reward
    await withClient((c) => c.query(`update persons set saving_toward_reward_id=$1 where id=$2`, [r.id, teenId]))
    const ov0 = JSON.parse((await call('GET', `/api/persons/${teenId}/overview`, kevin)).body)
    const have0 = ov0.savingToward?.have ?? 0
    expect((await call('POST', `/api/persons/${teenId}/award`, kevin, { amount: 10 })).statusCode).toBe(201)
    const ov1 = JSON.parse((await call('GET', `/api/persons/${teenId}/overview`, kevin)).body)
    expect(ov1.savingToward.have).toBe(have0 + 10)
    expect(ov1.savingToward.pct).toBeGreaterThan(ov0.savingToward?.pct ?? 0)
  })

  it('works with the rewards SHOP toggle OFF (gated by chores, not the shop)', async () => {
    // Turn the rewards shop sub-toggle off; spot-award must still work.
    await withClient((c) => c.query(
      `update households set settings = coalesce(settings,'{}'::jsonb) || jsonb_build_object('chores', jsonb_build_object('rewards', false)) where id=$1`,
      [householdId]
    ))
    // Shop route is blocked…
    expect((await call('GET', '/api/rewards', kevin)).statusCode).toBe(403)
    // …but spot-award still lands. (Read the balance from the ledger directly —
    // /api/balances is itself shop-gated, so it can't be used here.)
    const ledgerStars = () => withClient(async (c) => {
      const { rows } = await c.query<{ b: string | null }>(
        `select coalesce(sum(amount),0) as b from ledger_entries where household_id=$1 and person_id=$2 and currency='stars' and deleted_at is null`,
        [householdId, kidId]
      )
      return Number(rows[0]?.b ?? 0)
    })
    const before = await ledgerStars()
    expect((await call('POST', `/api/persons/${kidId}/award`, kevin, { amount: 4 })).statusCode).toBe(201)
    expect(await ledgerStars()).toBe(before + 4)
    // restore
    await withClient((c) => c.query(
      `update households set settings = coalesce(settings,'{}'::jsonb) || jsonb_build_object('chores', jsonb_build_object('rewards', true)) where id=$1`,
      [householdId]
    ))
  })
})
