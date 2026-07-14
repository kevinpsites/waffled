// Chores domain — migration + api. Shares one Postgres testcontainer + app.
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
let kevinId = ''
let householdId = ''

function mint(sub: string): string {
  return jwt.sign({}, SECRET, {
    algorithm: 'HS256',
    subject: sub,
    issuer: 'waffled-local',
    audience: 'waffled-api',
    expiresIn: '1h',
  })
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
    {
      httpMethod: method,
      path: rawPath,
      headers,
      queryStringParameters,
      body: body !== undefined ? JSON.stringify(body) : null,
      isBase64Encoded: false,
    },
    {}
  ) as Promise<RunResult>
}

const kevin = mint('dev|kevin')

// The test household is America/Chicago; chores now use the household-local day.
const TZ = 'America/Chicago'
function todayInTz(tz: string): string {
  const m: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())) m[p.type] = p.value
  return `${m.year}-${m.month}-${m.day}`
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool

  // First-run onboarding creates the first household + owner admin; self-serve
  // POST /api/households is now admin-gated. mint('dev|kevin') still resolves via
  // the identity seeded for the owner below.
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

describe('chores schema', () => {
  it('creates chores, chore_instances, ledger_entries + the balances view', async () => {
    const tables = await withClient((c) =>
      c.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema='public' and table_name = any($1)`,
        [['chores', 'chore_instances', 'ledger_entries']]
      )
    )
    expect(tables.rows.map((r) => r.table_name).sort()).toEqual([
      'chore_instances',
      'chores',
      'ledger_entries',
    ])
    const view = await withClient((c) =>
      c.query(`select table_name from information_schema.views where table_name='v_person_balances'`)
    )
    expect(view.rowCount).toBe(1)
  })

  it('enforces one instance per chore per day and derives star balances', async () => {
    await withClient(async (c) => {
      const h = await c.query<{ id: string }>(
        `insert into households (name, timezone) values ('C','UTC') returning id`
      )
      const hid = h.rows[0].id
      const p = await c.query<{ id: string }>(
        `insert into persons (household_id, name, member_type) values ($1,'Kid','kid') returning id`,
        [hid]
      )
      const pid = p.rows[0].id
      const ch = await c.query<{ id: string }>(
        `insert into chores (household_id, title, person_id, reward_currency, reward_amount)
         values ($1,'Dishes',$2,'stars',5) returning id`,
        [hid, pid]
      )
      const cid = ch.rows[0].id

      await c.query(
        `insert into chore_instances (household_id, chore_id, person_id, due_on) values ($1,$2,$3,'2026-06-08')`,
        [hid, cid, pid]
      )
      await expect(
        c.query(
          `insert into chore_instances (household_id, chore_id, person_id, due_on) values ($1,$2,$3,'2026-06-08')`,
          [hid, cid, pid]
        )
      ).rejects.toThrow()

      await c.query(
        `insert into ledger_entries (household_id, person_id, currency, amount, reason) values
         ($1,$2,'stars',5,'chore_completed'), ($1,$2,'stars',3,'bonus')`,
        [hid, pid]
      )
      const bal = await c.query<{ balance: string }>(
        `select balance from v_person_balances where person_id=$1 and currency='stars'`,
        [pid]
      )
      expect(Number(bal.rows[0].balance)).toBe(8)
    })
  })
})

describe('chores today api', () => {
  it('403s for a caller with no household', async () => {
    expect((await call('GET', '/api/chores/today', mint('dev|nobody'))).statusCode).toBe(403)
  })

  it('requires a title to create a chore (400)', async () => {
    expect((await call('POST', '/api/chores', kevin, { personId: kevinId })).statusCode).toBe(400)
  })

  it('creates a chore and surfaces it in today (per-person done/total + stars)', async () => {
    const add = await call('POST', '/api/chores', kevin, {
      title: 'Dishes',
      personId: kevinId,
      rewardAmount: 5,
    })
    expect(add.statusCode).toBe(201)

    const res = await call('GET', '/api/chores/today', kevin)
    expect(res.statusCode).toBe(200)
    const me = JSON.parse(res.body).people.find((p: { id: string }) => p.id === kevinId)
    expect(me).toMatchObject({ total: 1, done: 0, stars: 0 })
  })

  it('surfaces up-for-grabs chores without assigning them to a person summary', async () => {
    const before = JSON.parse((await call('GET', '/api/chores/today', kevin)).body)
    const beforeTotal = before.people.find((p: { id: string }) => p.id === kevinId).total

    const add = await call('POST', '/api/chores', kevin, {
      title: 'Anyone can sweep',
      personId: null,
    })
    expect(add.statusCode).toBe(201)

    const after = JSON.parse((await call('GET', '/api/chores/today', kevin)).body)
    expect(after.upForGrabs).toBe(before.upForGrabs + 1)
    expect(after.people.find((p: { id: string }) => p.id === kevinId).total).toBe(beforeTotal)
  })
})

describe('chore completion', () => {
  let instanceId = ''

  async function meStats() {
    const body = JSON.parse((await call('GET', '/api/chores/today', kevin)).body)
    return body.people.find((p: { id: string }) => p.id === kevinId) as { done: number; stars: number }
  }

  beforeAll(async () => {
    await call('POST', '/api/chores', kevin, { title: 'Trash', personId: kevinId, rewardAmount: 5 })
    const list = JSON.parse((await call('GET', '/api/chore-instances/today', kevin)).body)
    instanceId = list.instances.find((i: { choreTitle: string }) => i.choreTitle === 'Trash').id
  })

  it('completes an instance: marks it done and awards stars', async () => {
    const before = await meStats()
    const done = await call('POST', `/api/chore-instances/${instanceId}/complete`, kevin)
    expect(done.statusCode).toBe(200)
    expect(JSON.parse(done.body).instance.status).toBe('done')
    const after = await meStats()
    expect(after.done - before.done).toBe(1)
    expect(after.stars - before.stars).toBe(5)
  })

  it('is idempotent — completing again does not double-award', async () => {
    const before = await meStats()
    await call('POST', `/api/chore-instances/${instanceId}/complete`, kevin)
    const after = await meStats()
    expect(after.stars).toBe(before.stars)
  })

  it('uncompletes: back to pending and stars revoked', async () => {
    const before = await meStats()
    const res = await call('POST', `/api/chore-instances/${instanceId}/uncomplete`, kevin)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).instance.status).toBe('pending')
    const after = await meStats()
    expect(after.done - before.done).toBe(-1)
    expect(after.stars - before.stars).toBe(-5)
  })

  it('404s for an unknown instance', async () => {
    expect(
      (await call('POST', '/api/chore-instances/00000000-0000-0000-0000-000000000000/complete', kevin))
        .statusCode
    ).toBe(404)
  })
})

describe('chore management (edit/delete)', () => {
  let choreId = ''

  async function instances() {
    return JSON.parse((await call('GET', '/api/chore-instances/today', kevin)).body).instances as Array<{
      choreId: string
      choreTitle: string
    }>
  }
  async function kevinTotal() {
    return JSON.parse((await call('GET', '/api/chores/today', kevin)).body).people.find(
      (p: { id: string }) => p.id === kevinId
    ).total as number
  }

  beforeAll(async () => {
    await call('POST', '/api/chores', kevin, { title: 'Walk dog', personId: kevinId, rewardAmount: 3 })
    choreId = (await instances()).find((i) => i.choreTitle === 'Walk dog')!.choreId
  })

  it('edits a chore, reflected in the instance list', async () => {
    const res = await call('PATCH', `/api/chores/${choreId}`, kevin, { title: 'Walk the dog', rewardAmount: 5 })
    expect(res.statusCode).toBe(200)
    const list = await instances()
    expect(list.some((i) => i.choreTitle === 'Walk the dog')).toBe(true)
    expect(list.some((i) => i.choreTitle === 'Walk dog')).toBe(false)
  })

  it('propagates requiresApproval to today’s pending instance (gates completion)', async () => {
    type Inst = { id: string; choreId: string; choreTitle: string; requiresApproval: boolean; status: string }
    const raw = async () =>
      JSON.parse((await call('GET', '/api/chore-instances/today', kevin)).body).instances as Inst[]

    await call('POST', '/api/chores', kevin, { title: 'Feed fish', personId: kevinId, rewardAmount: 2 })
    const before = (await raw()).find((i) => i.choreTitle === 'Feed fish')!
    expect(before.requiresApproval).toBe(false)

    const patched = await call('PATCH', `/api/chores/${before.choreId}`, kevin, { requiresApproval: true })
    expect(patched.statusCode).toBe(200)

    // the existing instance — not just future ones — now requires approval
    const after = (await raw()).find((i) => i.choreTitle === 'Feed fish')!
    expect(after.requiresApproval).toBe(true)

    // and completing it parks in 'awaiting' instead of 'done'
    const done = await call('POST', `/api/chore-instances/${after.id}/complete`, kevin)
    expect(JSON.parse(done.body).instance.status).toBe('awaiting')
  })

  it('400 on empty patch, 404 on unknown', async () => {
    expect((await call('PATCH', `/api/chores/${choreId}`, kevin, {})).statusCode).toBe(400)
    expect(
      (await call('PATCH', '/api/chores/00000000-0000-0000-0000-000000000000', kevin, { title: 'x' }))
        .statusCode
    ).toBe(404)
  })

  it('deletes a chore — gone from instances and the rings total', async () => {
    const before = await kevinTotal()
    expect((await call('DELETE', `/api/chores/${choreId}`, kevin)).statusCode).toBe(204)
    expect((await instances()).some((i) => i.choreId === choreId)).toBe(false)
    expect(await kevinTotal()).toBe(before - 1)
    expect((await call('DELETE', `/api/chores/${choreId}`, kevin)).statusCode).toBe(404)
  })
})

describe('weekly schedules + up-for-grabs claim', () => {
  const CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
  // The server's "today" is the household-local day, so derive the weekday the same way.
  const dueOn = todayInTz(TZ)
  const today = CODES[new Date(`${dueOn}T00:00:00`).getDay()]
  const other = today === 'MO' ? 'TU' : 'MO'

  async function instances() {
    return JSON.parse((await call('GET', '/api/chore-instances/today', kevin)).body).instances as Array<{
      id: string
      choreId: string
      choreTitle: string
      personId: string | null
    }>
  }

  it('materializes a WEEKLY chore only on a matching weekday', async () => {
    await call('POST', '/api/chores', kevin, { title: 'WK Today', personId: kevinId, rrule: `FREQ=WEEKLY;BYDAY=${today}` })
    await call('POST', '/api/chores', kevin, { title: 'WK Other', personId: kevinId, rrule: `FREQ=WEEKLY;BYDAY=${other}` })
    const titles = (await instances()).map((i) => i.choreTitle)
    expect(titles).toContain('WK Today')
    expect(titles).not.toContain('WK Other')
  })

  it('claims an up-for-grabs instance and rejects a second claim (409)', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Grabby', personId: null, rrule: 'FREQ=DAILY', rewardAmount: 3 })
    const inst = (await instances()).find((i) => i.choreTitle === 'Grabby')!
    expect(inst.personId).toBeNull()

    const claim = await call('POST', `/api/chore-instances/${inst.id}/claim`, kevin, { personId: kevinId })
    expect(claim.statusCode).toBe(200)
    expect(JSON.parse(claim.body).instance.personId).toBe(kevinId)

    // second claim is rejected — someone already grabbed it
    expect((await call('POST', `/api/chore-instances/${inst.id}/claim`, kevin, { personId: kevinId })).statusCode).toBe(409)
  })

  it('editing a chore’s assignee moves its pending instance (incl. back to up-for-grabs)', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Reassign me', personId: kevinId, rrule: 'FREQ=DAILY' })
    const choreId = (await instances()).find((i) => i.choreTitle === 'Reassign me')!
    expect(choreId.personId).toBe(kevinId)

    // edit → up for grabs: the pending instance follows to person_id null
    expect((await call('PATCH', `/api/chores/${choreId.choreId}`, kevin, { personId: null })).statusCode).toBe(200)
    expect((await instances()).find((i) => i.choreTitle === 'Reassign me')!.personId).toBeNull()

    // edit → a person: the pending instance follows to them
    expect((await call('PATCH', `/api/chores/${choreId.choreId}`, kevin, { personId: kevinId })).statusCode).toBe(200)
    expect((await instances()).find((i) => i.choreTitle === 'Reassign me')!.personId).toBe(kevinId)
  })
})

describe('assign capability gating', () => {
  let wally = ''
  let wallyTok = ''
  beforeAll(async () => {
    wally = await addMember('Wally', 'kid', false, 'dev|wally-assign')
    wallyTok = mint('dev|wally-assign')
  })
  async function instances() {
    return JSON.parse((await call('GET', '/api/chore-instances/today', kevin)).body).instances as Array<{
      id: string; choreTitle: string; personId: string | null
    }>
  }

  it('a kid may release/self-claim via assign but not assign to another person', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Assignable', personId: null, rrule: 'FREQ=DAILY' })
    const inst = (await instances()).find((i) => i.choreTitle === 'Assignable')!

    // → another person: needs chore.manage, which a kid lacks → 403
    expect((await call('POST', `/api/chore-instances/${inst.id}/assign`, wallyTok, { personId: kevinId })).statusCode).toBe(403)
    // → self (just claiming) is allowed
    expect((await call('POST', `/api/chore-instances/${inst.id}/assign`, wallyTok, { personId: wally })).statusCode).toBe(200)
    // → up-for-grabs (releasing) is allowed
    expect((await call('POST', `/api/chore-instances/${inst.id}/assign`, wallyTok, { personId: null })).statusCode).toBe(200)
    // an admin/manager can assign to another person
    expect((await call('POST', `/api/chore-instances/${inst.id}/assign`, kevin, { personId: kevinId })).statusCode).toBe(200)
  })
})

describe('parent-approval chores', () => {
  async function instances() {
    return JSON.parse((await call('GET', '/api/chore-instances/today', kevin)).body).instances as Array<{
      id: string; choreTitle: string; status: string; streak: number; requiresApproval: boolean
    }>
  }
  async function kevinStars() {
    return JSON.parse((await call('GET', '/api/balances', kevin)).body).people.find(
      (p: { personId: string }) => p.personId === kevinId
    ).stars as number
  }

  it('completing an approval-gated chore parks it in awaiting with no stars; approve awards', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Mow', personId: kevinId, rewardAmount: 6, requiresApproval: true })
    const inst = (await instances()).find((i) => i.choreTitle === 'Mow')!
    expect(inst.requiresApproval).toBe(true)

    const before = await kevinStars()
    const done = await call('POST', `/api/chore-instances/${inst.id}/complete`, kevin)
    expect(JSON.parse(done.body).instance.status).toBe('awaiting')
    expect(await kevinStars()).toBe(before) // no stars yet

    const appr = await call('POST', `/api/chore-instances/${inst.id}/approve`, kevin)
    expect(appr.statusCode).toBe(200)
    expect(JSON.parse(appr.body).instance.status).toBe('done')
    expect(await kevinStars()).toBe(before + 6)
  })

  it('rejecting an awaiting chore sends it back to pending', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Rake', personId: kevinId, rewardAmount: 2, requiresApproval: true })
    const inst = (await instances()).find((i) => i.choreTitle === 'Rake')!
    await call('POST', `/api/chore-instances/${inst.id}/complete`, kevin)
    const rej = await call('POST', `/api/chore-instances/${inst.id}/reject`, kevin)
    expect(rej.statusCode).toBe(200)
    expect(JSON.parse(rej.body).instance.status).toBe('pending')
    // rejecting a non-awaiting instance 409s
    expect((await call('POST', `/api/chore-instances/${inst.id}/reject`, kevin)).statusCode).toBe(409)
  })

  it('reports a streak for a chore done today', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Streaky', personId: kevinId, rewardAmount: 1 })
    const inst = (await instances()).find((i) => i.choreTitle === 'Streaky')!
    await call('POST', `/api/chore-instances/${inst.id}/complete`, kevin)
    const after = (await instances()).find((i) => i.choreTitle === 'Streaky')!
    expect(after.streak).toBe(1)
  })
})

describe('photo-proof chores', () => {
  type Inst = {
    id: string; choreId: string; choreTitle: string; status: string
    requiresPhoto: boolean; requiresApproval: boolean; proofUrl: string | null
  }
  async function instances(): Promise<Inst[]> {
    return JSON.parse((await call('GET', '/api/chore-instances/today', kevin)).body).instances
  }

  it('rejects proof keys outside the current household', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Unsafe proof', personId: kevinId, rewardAmount: 1, requiresPhoto: true })
    const inst = (await instances()).find((i) => i.choreTitle === 'Unsafe proof')!
    const res = await call('POST', `/api/chore-instances/${inst.id}/complete`, kevin, {
      storageKey: `${householdId}/../../etc/passwd`,
      contentType: 'image/jpeg',
    })
    expect(res.statusCode).toBe(400)
    expect((await instances()).find((i) => i.choreTitle === 'Unsafe proof')!.status).toBe('pending')
  })

  it('requires a photo to complete: 422 without one, succeeds with a storage key', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Tidy room', personId: kevinId, rewardAmount: 4, requiresPhoto: true })
    const inst = (await instances()).find((i) => i.choreTitle === 'Tidy room')!
    expect(inst.requiresPhoto).toBe(true)

    // no photo → 422, still pending
    expect((await call('POST', `/api/chore-instances/${inst.id}/complete`, kevin)).statusCode).toBe(422)
    expect((await instances()).find((i) => i.choreTitle === 'Tidy room')!.status).toBe('pending')

    // with a proof key → done, proofUrl resolves to /media/<key>
    const done = await call('POST', `/api/chore-instances/${inst.id}/complete`, kevin, {
      storageKey: `${householdId}/${'a'.repeat(32)}.jpg`,
      contentType: 'image/jpeg',
    })
    expect(done.statusCode).toBe(200)
    expect(JSON.parse(done.body).instance.status).toBe('done')
    const after = (await instances()).find((i) => i.choreTitle === 'Tidy room')!
    expect(after.proofUrl).toMatch(/\/media\/.*a{32}\.jpg$/)
  })

  it('combines with approval: proof shows in the awaiting queue; reject clears it', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Wash car', personId: kevinId, rewardAmount: 8, requiresApproval: true, requiresPhoto: true })
    const inst = (await instances()).find((i) => i.choreTitle === 'Wash car')!
    const done = await call('POST', `/api/chore-instances/${inst.id}/complete`, kevin, {
      storageKey: `${householdId}/${'b'.repeat(32)}.webp`,
      contentType: 'image/webp',
    })
    expect(JSON.parse(done.body).instance.status).toBe('awaiting')

    const queue = JSON.parse((await call('GET', '/api/chore-instances/awaiting', kevin)).body).instances as Inst[]
    expect(queue.find((i) => i.choreTitle === 'Wash car')!.proofUrl).toMatch(/b{32}\.webp$/)

    expect((await call('POST', `/api/chore-instances/${inst.id}/reject`, kevin)).statusCode).toBe(200)
    const back = (await instances()).find((i) => i.choreTitle === 'Wash car')!
    expect(back.status).toBe('pending')
    expect(back.proofUrl).toBeNull()
  })

  it('propagates requiresPhoto via PATCH to today’s pending instance', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Sweep', personId: kevinId, rewardAmount: 1 })
    const before = (await instances()).find((i) => i.choreTitle === 'Sweep')!
    expect(before.requiresPhoto).toBe(false)

    expect((await call('PATCH', `/api/chores/${before.choreId}`, kevin, { requiresPhoto: true })).statusCode).toBe(200)
    const after = (await instances()).find((i) => i.choreTitle === 'Sweep')!
    expect(after.requiresPhoto).toBe(true)
    // and completing it now needs a photo
    expect((await call('POST', `/api/chore-instances/${after.id}/complete`, kevin)).statusCode).toBe(422)
  })
})

describe('photo-proof retention', () => {
  type Inst = { id: string; choreId: string; choreTitle: string; status: string; proofUrl: string | null; hadProof: boolean }
  async function instances(): Promise<Inst[]> {
    return JSON.parse((await call('GET', '/api/chore-instances/today', kevin)).body).instances
  }
  // Complete a fresh requires-photo chore with a proof key; returns the instance id.
  async function completedWithProof(title: string): Promise<string> {
    await call('POST', '/api/chores', kevin, { title, personId: kevinId, rewardAmount: 1, requiresPhoto: true })
    const inst = (await instances()).find((i) => i.choreTitle === title)!
    await call('POST', `/api/chore-instances/${inst.id}/complete`, kevin, { storageKey: `${householdId}/${Buffer.from(title).toString('hex').padEnd(32, '0').slice(0, 32)}.jpg`, contentType: 'image/jpeg' })
    return inst.id
  }

  it('exposes settings (default 3 days), and admins can change them', async () => {
    expect(JSON.parse((await call('GET', '/api/chores/settings', kevin)).body).proofTtlDays).toBe(3)
    expect((await call('PUT', '/api/chores/settings', kevin, { proofTtlDays: -1 })).statusCode).toBe(400)
    const put = await call('PUT', '/api/chores/settings', kevin, { proofTtlDays: 7 })
    expect(put.statusCode).toBe(200)
    expect(JSON.parse(put.body).proofTtlDays).toBe(7)
    expect(JSON.parse((await call('GET', '/api/chores/settings', kevin)).body).proofTtlDays).toBe(7)
    // put it back to the default for the sweep test below
    await call('PUT', '/api/chores/settings', kevin, { proofTtlDays: 3 })
  })

  it('records hadProof on completion and resolves a proofUrl', async () => {
    await completedWithProof('Vacuum')
    const i = (await instances()).find((x) => x.choreTitle === 'Vacuum')!
    expect(i.status).toBe('done')
    expect(i.hadProof).toBe(true)
    expect(i.proofUrl).toMatch(/[0-9a-f]{32}\.jpg$/)
  })

  it('the sweep deletes aged proofs (keeping hadProof) but spares fresh + awaiting ones', async () => {
    const agedId = await completedWithProof('Old proof')   // will be backdated past the TTL
    await completedWithProof('Fresh proof')                // stays (completed just now)
    // an awaiting (not settled) photo chore must never be swept, however old
    await call('POST', '/api/chores', kevin, { title: 'Pending proof', personId: kevinId, rewardAmount: 1, requiresPhoto: true, requiresApproval: true })
    const pend = (await instances()).find((i) => i.choreTitle === 'Pending proof')!
    await call('POST', `/api/chore-instances/${pend.id}/complete`, kevin, { storageKey: `${householdId}/${'c'.repeat(32)}.jpg`, contentType: 'image/jpeg' })

    // backdate the aged one + the awaiting one well past the 3-day window
    await withClient((c) =>
      c.query(`update chore_instances set completed_at = now() - interval '5 days' where id = any($1)`, [[agedId, pend.id]])
    )

    const { cleanupExpiredProofs } = await import('../src/modules/chores/chore-proof-cleanup.service')
    const res = await cleanupExpiredProofs()
    expect(res.deletedBlobs).toBeGreaterThanOrEqual(1)

    const after = await instances()
    const aged = after.find((i) => i.choreTitle === 'Old proof')!
    expect(aged.proofUrl).toBeNull()   // blob + key gone
    expect(aged.hadProof).toBe(true)   // …but we still remember a photo was attached
    expect(after.find((i) => i.choreTitle === 'Fresh proof')!.proofUrl).toMatch(/[0-9a-f]{32}\.jpg$/)
    // awaiting one keeps its proof despite being backdated
    expect(after.find((i) => i.choreTitle === 'Pending proof')!.proofUrl).toMatch(/c{32}\.jpg$/)
  })
})

describe('stored proof photos (review/manage)', () => {
  type Inst = { id: string; choreTitle: string; status: string; proofUrl: string | null }
  type Proof = { instanceId: string; choreTitle: string; personName: string | null; proofUrl: string | null; completedAt: string | null }
  async function instances(): Promise<Inst[]> {
    return JSON.parse((await call('GET', '/api/chore-instances/today', kevin)).body).instances
  }
  async function listProofs(): Promise<Proof[]> {
    return JSON.parse((await call('GET', '/api/chore-proofs', kevin)).body).proofs
  }
  async function completeWithProof(title: string): Promise<string> {
    await call('POST', '/api/chores', kevin, { title, personId: kevinId, rewardAmount: 1, requiresPhoto: true })
    const inst = (await instances()).find((i) => i.choreTitle === title)!
    await call('POST', `/api/chore-instances/${inst.id}/complete`, kevin, { storageKey: `${householdId}/${Buffer.from(title).toString('hex').padEnd(32, '0').slice(0, 32)}.jpg`, contentType: 'image/jpeg' })
    return inst.id
  }

  it('lists settled proofs, deletes one (keeping hadProof), and clears the rest', async () => {
    const aId = await completeWithProof('Proof A')
    await completeWithProof('Proof B')

    let proofs = await listProofs()
    const a = proofs.find((p) => p.choreTitle === 'Proof A')!
    expect(a.instanceId).toBe(aId)
    expect(a.proofUrl).toMatch(/[0-9a-f]{32}\.jpg$/)
    expect(proofs.some((p) => p.choreTitle === 'Proof B')).toBe(true)

    // delete one
    expect((await call('DELETE', `/api/chore-proofs/${aId}`, kevin)).statusCode).toBe(204)
    proofs = await listProofs()
    expect(proofs.some((p) => p.instanceId === aId)).toBe(false)
    // its instance still records that a photo was attached
    const aInst = JSON.parse((await call('GET', '/api/chore-instances/today', kevin)).body).instances.find((i: { id: string; hadProof: boolean }) => i.id === aId)
    expect(aInst.hadProof).toBe(true)
    expect(aInst.proofUrl).toBeNull()

    // delete unknown → 404
    expect((await call('DELETE', '/api/chore-proofs/00000000-0000-0000-0000-000000000000', kevin)).statusCode).toBe(404)

    // clear all → none left
    const cleared = await call('DELETE', '/api/chore-proofs', kevin)
    expect(cleared.statusCode).toBe(200)
    expect(JSON.parse(cleared.body).cleared).toBeGreaterThanOrEqual(1)
    expect((await listProofs()).length).toBe(0)
  })
})

describe('chores look-ahead (date param)', () => {
  // The local date of the next strictly-future weekday with the given JS dow.
  function nextDow(dow: number): string {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    const delta = ((dow - d.getDay()) + 7) % 7 || 7
    d.setDate(d.getDate() + delta)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  it('materializes and lists a future weekly occurrence on its weekday', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Recycling', personId: kevinId, rewardAmount: 2, rrule: 'FREQ=WEEKLY;BYDAY=MO' })
    const monday = nextDow(1)
    const res = await call('GET', `/api/chore-instances/today?date=${monday}`, kevin)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.date).toBe(monday)
    expect(body.instances.some((i: { choreTitle: string }) => i.choreTitle === 'Recycling')).toBe(true)
  })

  it('does not show a Monday-only chore on a non-Monday', async () => {
    const tuesday = nextDow(2)
    const body = JSON.parse((await call('GET', `/api/chore-instances/today?date=${tuesday}`, kevin)).body)
    expect(body.instances.some((i: { choreTitle: string }) => i.choreTitle === 'Recycling')).toBe(false)
  })

  it('clamps an out-of-range date back to today', async () => {
    const today = todayInTz(TZ)
    expect(JSON.parse((await call('GET', '/api/chore-instances/today?date=2999-01-01', kevin)).body).date).toBe(today)
    expect(JSON.parse((await call('GET', '/api/chore-instances/today?date=garbage', kevin)).body).date).toBe(today)
  })
})

describe('chore capability gating (non-admin members)', () => {
  let adultSub = '', kidSub = '', adultToken = '', kidToken = '', adultId = '', kidId = ''

  beforeAll(async () => {
    adultId = await addMember('Adult2', 'adult', false, 'dev|adult2')
    kidId = await addMember('KidJr', 'kid', false, 'dev|kidjr')
    adultSub = 'dev|adult2'; kidSub = 'dev|kidjr'
    adultToken = mint(adultSub); kidToken = mint(kidSub)
  })

  it('a non-admin adult holds the default capabilities; a kid holds none', async () => {
    const adult = JSON.parse((await call('GET', '/api/household', adultToken)).body).person
    expect(adult.capabilities.sort()).toEqual(['chore.approve', 'chore.manage', 'goal.manage', 'reward.approve', 'reward.grant', 'reward.manage'])
    const kid = JSON.parse((await call('GET', '/api/household', kidToken)).body).person
    expect(kid.capabilities).toEqual([])
  })

  it('a non-admin adult CAN create a chore for someone else and approve one', async () => {
    // create for the kid (not self) → needs chore.manage, which the adult has
    const add = await call('POST', '/api/chores', adultToken, { title: 'Adult-set', personId: kidId, rewardAmount: 1, requiresApproval: true })
    expect(add.statusCode).toBe(201)
    const list = JSON.parse((await call('GET', '/api/chore-instances/today', adultToken)).body).instances as Array<{ id: string; choreTitle: string }>
    const inst = list.find((i) => i.choreTitle === 'Adult-set')!
    await call('POST', `/api/chore-instances/${inst.id}/complete`, kidToken)
    expect((await call('POST', `/api/chore-instances/${inst.id}/approve`, adultToken)).statusCode).toBe(200)
  })

  it('a kid CAN create an up-for-grabs chore and one for themselves', async () => {
    expect((await call('POST', '/api/chores', kidToken, { title: 'Grab-kid', personId: null })).statusCode).toBe(201)
    expect((await call('POST', '/api/chores', kidToken, { title: 'Self-kid', personId: kidId })).statusCode).toBe(201)
  })

  it('a kid CANNOT create a chore for someone else (403)', async () => {
    expect((await call('POST', '/api/chores', kidToken, { title: 'For-adult', personId: adultId })).statusCode).toBe(403)
  })

  it('a kid CANNOT approve a chore (403)', async () => {
    await call('POST', '/api/chores', adultToken, { title: 'Approve-me', personId: kidId, rewardAmount: 1, requiresApproval: true })
    const list = JSON.parse((await call('GET', '/api/chore-instances/today', kidToken)).body).instances as Array<{ id: string; choreTitle: string }>
    const inst = list.find((i) => i.choreTitle === 'Approve-me')!
    await call('POST', `/api/chore-instances/${inst.id}/complete`, kidToken)
    expect((await call('POST', `/api/chore-instances/${inst.id}/approve`, kidToken)).statusCode).toBe(403)
  })

  it('granting teen/kid chore.approve via /api/permissions lets them approve', async () => {
    // admin grants the kid role chore.approve
    const put = await call('PUT', '/api/permissions', kevin, { permissions: { kid: { 'chore.approve': true } } })
    expect(put.statusCode).toBe(200)
    expect(JSON.parse(put.body).permissions.kid['chore.approve']).toBe(true)

    await call('POST', '/api/chores', adultToken, { title: 'Now-approvable', personId: kidId, rewardAmount: 1, requiresApproval: true })
    const list = JSON.parse((await call('GET', '/api/chore-instances/today', kidToken)).body).instances as Array<{ id: string; choreTitle: string }>
    const inst = list.find((i) => i.choreTitle === 'Now-approvable')!
    await call('POST', `/api/chore-instances/${inst.id}/complete`, kidToken)
    expect((await call('POST', `/api/chore-instances/${inst.id}/approve`, kidToken)).statusCode).toBe(200)

    // reset so later assumptions about defaults hold
    await call('PUT', '/api/permissions', kevin, { permissions: { kid: { 'chore.approve': false } } })
  })

  it('non-admins cannot read or write the permissions matrix (403)', async () => {
    expect((await call('GET', '/api/permissions', kidToken)).statusCode).toBe(403)
    expect((await call('PUT', '/api/permissions', adultToken, { permissions: {} })).statusCode).toBe(403)
  })
})

describe('one-off chores + rollover (carry-forward)', () => {
  const today = todayInTz(TZ)
  function shift(d: string, days: number): string {
    const dt = new Date(`${d}T00:00:00Z`)
    dt.setUTCDate(dt.getUTCDate() + days)
    return dt.toISOString().slice(0, 10)
  }

  type Inst = { id: string; choreId: string; choreTitle: string; dueOn: string; status: string; rrule: string | null }
  async function instances(): Promise<Inst[]> {
    return JSON.parse((await call('GET', '/api/chore-instances/today', kevin)).body).instances as Inst[]
  }
  async function meTotal(): Promise<{ total: number; done: number }> {
    const body = JSON.parse((await call('GET', '/api/chores/today', kevin)).body)
    const me = body.people.find((p: { id: string }) => p.id === kevinId)
    return { total: me.total, done: me.done }
  }
  async function choreRrule(choreId: string): Promise<string | null> {
    return withClient(async (c) => {
      const r = await c.query<{ rrule: string | null }>(`select rrule from chores where id=$1`, [choreId])
      return r.rows[0].rrule
    })
  }

  it('a chore with no rrule persists rrule=NULL and gets exactly one instance today', async () => {
    const add = await call('POST', '/api/chores', kevin, { title: 'OneOff Today', personId: kevinId, rewardAmount: 4 })
    expect(add.statusCode).toBe(201)
    const list = await instances()
    const mine = list.filter((i) => i.choreTitle === 'OneOff Today')
    expect(mine).toHaveLength(1)
    expect(mine[0].dueOn).toBe(today)
    expect(mine[0].rrule).toBeNull()
    expect(await choreRrule(mine[0].choreId)).toBeNull()
  })

  it('a future-dated one-off shows from today (creation) onward, keeping its future due_on', async () => {
    const future = shift(today, 3)
    const add = await call('POST', '/api/chores', kevin, { title: 'OneOff Future', personId: kevinId, dueOn: future })
    expect(add.statusCode).toBe(201)
    // visible on today's list right away — a task you added today is on your list today…
    const mine = (await instances()).filter((i) => i.choreTitle === 'OneOff Future')
    expect(mine).toHaveLength(1)
    expect(mine[0].dueOn).toBe(future) // …but its due date is preserved so the UI can say "due in 3 days"
    expect(mine[0].status).toBe('pending')
    // it counts toward today's totals (list ↔ rings stay consistent)
    expect((await meTotal()).total).toBeGreaterThanOrEqual(1)
    // still present when the due day itself is requested
    const ahead = JSON.parse((await call('GET', `/api/chore-instances/today?date=${future}`, kevin)).body).instances as Inst[]
    expect(ahead.filter((i) => i.choreTitle === 'OneOff Future')).toHaveLength(1)
    // but NOT on a date before it was created (no time-traveling onto past lists)
    const past = shift(today, -5)
    const back = JSON.parse((await call('GET', `/api/chore-instances/today?date=${past}`, kevin)).body).instances as Inst[]
    expect(back.some((i) => i.choreTitle === 'OneOff Future')).toBe(false)
  })

  it('carries a pending one-off forward (keeps original due_on) and counts it in the summary', async () => {
    const add = await call('POST', '/api/chores', kevin, { title: 'Carry Me', personId: kevinId, rewardAmount: 2 })
    expect(add.statusCode).toBe(201)
    const choreId = (await instances()).find((i) => i.choreTitle === 'Carry Me')!.choreId
    const past = shift(today, -2)
    await withClient((c) => c.query(`update chore_instances set due_on=$2 where chore_id=$1`, [choreId, past]))

    const before = await meTotal()
    const list = await instances()
    const carried = list.find((i) => i.choreTitle === 'Carry Me')
    expect(carried).toBeTruthy()
    expect(carried!.dueOn).toBe(past) // original date preserved → "overdue · since …"
    expect(carried!.status).toBe('pending')
    // and it counts toward today's totals
    expect(before.total).toBeGreaterThanOrEqual(1)
  })

  it('a done one-off in the past is NOT carried forward', async () => {
    const add = await call('POST', '/api/chores', kevin, { title: 'Done OneOff', personId: kevinId, rewardAmount: 1 })
    expect(add.statusCode).toBe(201)
    const inst = (await instances()).find((i) => i.choreTitle === 'Done OneOff')!
    const past = shift(today, -3)
    await withClient((c) => c.query(`update chore_instances set due_on=$2 where id=$1`, [inst.id, past]))
    // complete it (on its past date)
    expect((await call('POST', `/api/chore-instances/${inst.id}/complete`, kevin)).statusCode).toBe(200)
    expect((await instances()).some((i) => i.choreTitle === 'Done OneOff')).toBe(false)
  })

  it('a recurring chore’s missed past instance is NOT carried forward', async () => {
    const add = await call('POST', '/api/chores', kevin, { title: 'Recurring Miss', personId: kevinId, rrule: 'FREQ=DAILY' })
    expect(add.statusCode).toBe(201)
    const choreId = (await instances()).find((i) => i.choreTitle === 'Recurring Miss')!.choreId
    const past = shift(today, -2)
    // back-date today's materialized instance so it's a "missed" past one, leaving none on `today`
    await withClient((c) => c.query(`update chore_instances set due_on=$2 where chore_id=$1`, [choreId, past]))
    // ensureTodayInstances re-materializes a fresh one for today; the past one must not be carried.
    const list = await instances()
    const rows = list.filter((i) => i.choreTitle === 'Recurring Miss')
    expect(rows).toHaveLength(1)
    expect(rows[0].dueOn).toBe(today)
  })

  it('rollover=false on a one-off suppresses carry-forward', async () => {
    const add = await call('POST', '/api/chores', kevin, { title: 'NoRoll', personId: kevinId, rollover: false })
    expect(add.statusCode).toBe(201)
    const inst = (await instances()).find((i) => i.choreTitle === 'NoRoll')!
    const past = shift(today, -2)
    await withClient((c) => c.query(`update chore_instances set due_on=$2 where id=$1`, [inst.id, past]))
    expect((await instances()).some((i) => i.choreTitle === 'NoRoll')).toBe(false)
  })
})
