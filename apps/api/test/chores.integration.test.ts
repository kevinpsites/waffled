// Chores domain — migration + api. Shares one Postgres testcontainer + app.
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
let kevinId = ''

function mint(sub: string): string {
  return jwt.sign({}, SECRET, {
    algorithm: 'HS256',
    subject: sub,
    issuer: 'nook-local',
    audience: 'nook-api',
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

  const h = await call('POST', '/api/households', kevin, {
    name: 'Sites',
    timezone: 'America/Chicago',
    person: { name: 'Kevin' },
  })
  kevinId = JSON.parse(h.body).person.id
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

  it('requires a photo to complete: 422 without one, succeeds with a storage key', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Tidy room', personId: kevinId, rewardAmount: 4, requiresPhoto: true })
    const inst = (await instances()).find((i) => i.choreTitle === 'Tidy room')!
    expect(inst.requiresPhoto).toBe(true)

    // no photo → 422, still pending
    expect((await call('POST', `/api/chore-instances/${inst.id}/complete`, kevin)).statusCode).toBe(422)
    expect((await instances()).find((i) => i.choreTitle === 'Tidy room')!.status).toBe('pending')

    // with a proof key → done, proofUrl resolves to /media/<key>
    const done = await call('POST', `/api/chore-instances/${inst.id}/complete`, kevin, {
      storageKey: `${kevinId}/abc.jpg`,
      contentType: 'image/jpeg',
    })
    expect(done.statusCode).toBe(200)
    expect(JSON.parse(done.body).instance.status).toBe('done')
    const after = (await instances()).find((i) => i.choreTitle === 'Tidy room')!
    expect(after.proofUrl).toMatch(/\/media\/.*abc\.jpg$/)
  })

  it('combines with approval: proof shows in the awaiting queue; reject clears it', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Wash car', personId: kevinId, rewardAmount: 8, requiresApproval: true, requiresPhoto: true })
    const inst = (await instances()).find((i) => i.choreTitle === 'Wash car')!
    const done = await call('POST', `/api/chore-instances/${inst.id}/complete`, kevin, {
      storageKey: `${kevinId}/car.webp`,
      contentType: 'image/webp',
    })
    expect(JSON.parse(done.body).instance.status).toBe('awaiting')

    const queue = JSON.parse((await call('GET', '/api/chore-instances/awaiting', kevin)).body).instances as Inst[]
    expect(queue.find((i) => i.choreTitle === 'Wash car')!.proofUrl).toMatch(/car\.webp$/)

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
    await call('POST', `/api/chore-instances/${inst.id}/complete`, kevin, { storageKey: `${kevinId}/${title}.jpg`, contentType: 'image/jpeg' })
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
    expect(i.proofUrl).toMatch(/Vacuum\.jpg$/)
  })

  it('the sweep deletes aged proofs (keeping hadProof) but spares fresh + awaiting ones', async () => {
    const agedId = await completedWithProof('Old proof')   // will be backdated past the TTL
    await completedWithProof('Fresh proof')                // stays (completed just now)
    // an awaiting (not settled) photo chore must never be swept, however old
    await call('POST', '/api/chores', kevin, { title: 'Pending proof', personId: kevinId, rewardAmount: 1, requiresPhoto: true, requiresApproval: true })
    const pend = (await instances()).find((i) => i.choreTitle === 'Pending proof')!
    await call('POST', `/api/chore-instances/${pend.id}/complete`, kevin, { storageKey: `${kevinId}/pend.jpg`, contentType: 'image/jpeg' })

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
    expect(after.find((i) => i.choreTitle === 'Fresh proof')!.proofUrl).toMatch(/Fresh proof\.jpg$/)
    // awaiting one keeps its proof despite being backdated
    expect(after.find((i) => i.choreTitle === 'Pending proof')!.proofUrl).toMatch(/pend\.jpg$/)
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
    await call('POST', `/api/chore-instances/${inst.id}/complete`, kevin, { storageKey: `${kevinId}/${title}.jpg`, contentType: 'image/jpeg' })
    return inst.id
  }

  it('lists settled proofs, deletes one (keeping hadProof), and clears the rest', async () => {
    const aId = await completeWithProof('Proof A')
    await completeWithProof('Proof B')

    let proofs = await listProofs()
    const a = proofs.find((p) => p.choreTitle === 'Proof A')!
    expect(a.instanceId).toBe(aId)
    expect(a.proofUrl).toMatch(/Proof A\.jpg$/)
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
