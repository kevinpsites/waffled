// Rhythms domain — migration + api. Shares one Postgres testcontainer + app.
// See docs/product/rhythms-plan.md. Two shapes:
//   satisfied_by='completion' — you did it; next_due_at = completed_at + every
//   satisfied_by='scheduling' — an event exists for the period; we never ask if it happened
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
  kevinId = JSON.parse(setup.body).person.id
  householdId = JSON.parse(setup.body).household.id
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

describe('rhythms schema', () => {
  it('creates rhythms, rhythm_completions, rhythm_skips', async () => {
    const res = await withClient((c) =>
      c.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_schema='public' and table_name = any($1)`,
        [['rhythms', 'rhythm_completions', 'rhythm_skips']]
      )
    )
    expect(res.rows.map((r) => r.table_name).sort()).toEqual(['rhythm_completions', 'rhythm_skips', 'rhythms'])
  })

  it('adds events.rhythm_id so a calendar entry can point back at its rhythm', async () => {
    const res = await withClient((c) =>
      c.query(
        `select column_name from information_schema.columns
          where table_schema='public' and table_name='events' and column_name='rhythm_id'`
      )
    )
    expect(res.rowCount).toBe(1)
  })

  // The shape constraint is what keeps the two kinds from bleeding into each other:
  // a completion rhythm with an rrule, or a scheduling rhythm with no anchor, is
  // nonsense the period math cannot recover from.
  it('rejects a completion rhythm that carries scheduling-only columns', async () => {
    await expect(
      withClient((c) =>
        c.query(
          `insert into rhythms (household_id, title, satisfied_by, every, next_due_at, rrule)
           values ($1,'Bad filter','completion','3 months', now(), 'FREQ=MONTHLY')`,
          [householdId]
        )
      )
    ).rejects.toThrow()
  })

  it('rejects a scheduling rhythm with no period anchor', async () => {
    await expect(
      withClient((c) =>
        c.query(
          `insert into rhythms (household_id, title, satisfied_by, every)
           values ($1,'Bad temple','scheduling','3 months')`,
          [householdId]
        )
      )
    ).rejects.toThrow()
  })

  it('rejects auto_schedule without an rrule to build the event from', async () => {
    await expect(
      withClient((c) =>
        c.query(
          `insert into rhythms (household_id, title, satisfied_by, every, starts_on, auto_schedule)
           values ($1,'Bad trash','scheduling','1 week', current_date, true)`,
          [householdId]
        )
      )
    ).rejects.toThrow()
  })
})

describe('rhythms module gating', () => {
  it('403s every route until the household enables the module', async () => {
    const res = await call('GET', '/api/rhythms', kevin)
    expect(res.statusCode).toBe(403)
  })

  it('opens up once enabled', async () => {
    expect((await call('PATCH', '/api/household/modules', kevin, { rhythms: true })).statusCode).toBe(200)
    const res = await call('GET', '/api/rhythms', kevin)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).rhythms).toEqual([])
  })
})

describe('completion-shape rhythms', () => {
  let filterId = ''

  it('creates one with a seeded first due date', async () => {
    const res = await call('POST', '/api/rhythms', kevin, {
      title: 'Air filter',
      emoji: '🌬️',
      satisfiedBy: 'completion',
      every: '3 months',
      nextDueAt: '2026-09-01T00:00:00Z',
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body).rhythm
    filterId = body.id
    expect(body.satisfiedBy).toBe('completion')
    expect(body.lastCompletedAt).toBeNull()
  })

  // The load-bearing behaviour: the clock restarts from when you ACTUALLY did it,
  // so doing it late shifts the next one rather than silently stacking up.
  it('re-anchors next_due_at to the completion time, not the old due date', async () => {
    const res = await call('POST', `/api/rhythms/${filterId}/complete`, kevin, {
      completedAt: '2026-09-15T12:00:00Z',
      notes: 'ordered a 3-pack',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body).rhythm
    expect(body.lastCompletedAt).toBe('2026-09-15T12:00:00.000Z')
    // 2026-09-15 + 3 months, NOT 2026-09-01 + 3 months.
    expect(body.nextDueAt).toBe('2026-12-15T12:00:00.000Z')
  })

  it('keeps the completion in a history you can read back', async () => {
    const res = await call('GET', `/api/rhythms/${filterId}/completions`, kevin)
    expect(res.statusCode).toBe(200)
    const rows = JSON.parse(res.body).completions
    expect(rows).toHaveLength(1)
    expect(rows[0].notes).toBe('ordered a 3-pack')
    expect(rows[0].personId).toBe(kevinId)
  })
})

// Weekly trash is the shortest real cadence we have, and it's where a fixed lead time
// falls apart: a 14-day runway on a 7-day cycle means `next_due_at - lead_time` is always
// in the past, so the item never goes quiet — it just sits on Today forever, thirty
// seconds after you took the trash out included. A rhythm that is always shouting is
// indistinguishable from one you've stopped reading.
describe('a short cadence does not out-run its lead time', () => {
  let trashId = ''

  it('clamps the runway to half the cycle so a weekly item can go quiet', async () => {
    const res = await call('POST', '/api/rhythms', kevin, {
      title: 'Take the trash out',
      emoji: '🗑️',
      satisfiedBy: 'completion',
      every: '7 days',
      nextDueAt: '2026-09-04T00:00:00Z',
      // no leadTime given — the 14-day default is longer than the whole cycle
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body).rhythm
    trashId = body.id
    // Echoed back as what will actually happen, not as the unusable default.
    expect(body.leadTime).toBe('3 days 12:00:00')
  })

  it('stays off the list in the first half of the week', async () => {
    // Due the 4th, so the runway opens midday on Aug 31. Ask on the 29th.
    const res = await call('GET', '/api/rhythms/attention?from=2026-08-29&to=2026-08-29', kevin)
    expect(res.statusCode).toBe(200)
    const items = JSON.parse(res.body).items
    expect(items.map((i: { rhythm: { id: string } }) => i.rhythm.id)).not.toContain(trashId)
  })

  it('appears once the runway opens', async () => {
    const res = await call('GET', '/api/rhythms/attention?from=2026-09-02&to=2026-09-02', kevin)
    expect(res.statusCode).toBe(200)
    const items = JSON.parse(res.body).items
    expect(items.map((i: { rhythm: { id: string } }) => i.rhythm.id)).toContain(trashId)
  })

  it('leaves a long cadence its full requested runway', async () => {
    // The clamp is a ceiling, not a rewrite: 14 days is well under half of 3 months.
    const res = await call('POST', '/api/rhythms', kevin, {
      title: 'Oil change',
      satisfiedBy: 'completion',
      every: '6 months',
      nextDueAt: '2027-01-01T00:00:00Z',
    })
    expect(JSON.parse(res.body).rhythm.leadTime).toBe('14 days')
  })
})

describe('scheduling-shape rhythms', () => {
  let templeId = ''

  it('creates one anchored to a period grid', async () => {
    const res = await call('POST', '/api/rhythms', kevin, {
      title: 'Temple visit',
      satisfiedBy: 'scheduling',
      every: '3 months',
      startsOn: '2026-07-01',
      personId: kevinId,
      leadTime: '14 days',
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body).rhythm
    templeId = body.id
    expect(body.startsOn).toBe('2026-07-01')
    // Never tracked for this shape — asking "did you go?" is what makes it a goal.
    expect(body.lastCompletedAt).toBeNull()
  })

  it('surfaces as unscheduled inside the booking runway', async () => {
    // Period is 2026-07-01..2026-10-01; with a 14-day runway it should surface from 09-17.
    const res = await call('GET', '/api/rhythms/attention?from=2026-09-20&to=2026-09-27', kevin)
    expect(res.statusCode).toBe(200)
    const items = JSON.parse(res.body).items
    const temple = items.find((i: { rhythm: { id: string } }) => i.rhythm.id === templeId)
    expect(temple).toBeDefined()
    expect(temple.kind).toBe('unscheduled')
    expect(temple.periodStart).toBe('2026-07-01')
    expect(temple.periodEnd).toBe('2026-10-01')
  })

  it('stays quiet before the runway opens', async () => {
    const res = await call('GET', '/api/rhythms/attention?from=2026-07-05&to=2026-07-12', kevin)
    const items = JSON.parse(res.body).items
    expect(items.find((i: { rhythm: { id: string } }) => i.rhythm.id === templeId)).toBeUndefined()
  })

  // Satisfaction is DERIVED from events, not dual-written — so booking a time is an
  // ordinary event write that happens to carry rhythm_id.
  it('goes quiet once an event in the period points at it', async () => {
    const ev = await call('POST', '/api/events', kevin, {
      title: 'Temple',
      startsAt: '2026-09-26T09:00:00',
      endsAt: '2026-09-26T11:00:00',
      rhythmId: templeId,
    })
    expect(ev.statusCode).toBe(201)
    expect(JSON.parse(ev.body).event.rhythmId).toBe(templeId)

    const res = await call('GET', '/api/rhythms/attention?from=2026-09-20&to=2026-09-27', kevin)
    const items = JSON.parse(res.body).items
    expect(items.find((i: { rhythm: { id: string } }) => i.rhythm.id === templeId)).toBeUndefined()
  })

  it('skipping a period silences it without inventing an event', async () => {
    const skipped = await call('POST', '/api/rhythms', kevin, {
      title: 'Self-care day',
      satisfiedBy: 'scheduling',
      every: '3 months',
      startsOn: '2026-07-01',
      leadTime: '14 days',
    })
    const id = JSON.parse(skipped.body).rhythm.id

    const before = await call('GET', '/api/rhythms/attention?from=2026-09-20&to=2026-09-27', kevin)
    expect(JSON.parse(before.body).items.some((i: { rhythm: { id: string } }) => i.rhythm.id === id)).toBe(true)

    const skip = await call('POST', `/api/rhythms/${id}/skip`, kevin, { periodStart: '2026-07-01' })
    expect(skip.statusCode).toBe(200)

    const after = await call('GET', '/api/rhythms/attention?from=2026-09-20&to=2026-09-27', kevin)
    expect(JSON.parse(after.body).items.some((i: { rhythm: { id: string } }) => i.rhythm.id === id)).toBe(false)
  })
})

// /api/rhythms/attention and /api/rhythms/:id/completions share a prefix, and lambda-api
// matches in registration order. If a later worker adds GET /api/rhythms/:id ahead of it,
// the planner endpoint would silently start resolving 'attention' as an id — so pin it.
describe('route precedence', () => {
  it('resolves /api/rhythms/attention as the endpoint, not as an :id', async () => {
    const res = await call('GET', '/api/rhythms/attention?from=2026-09-20&to=2026-09-27', kevin)
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(JSON.parse(res.body).items)).toBe(true)
  })

  it('still rejects a malformed window with 400 rather than falling through', async () => {
    const res = await call('GET', '/api/rhythms/attention?from=nope&to=2026-09-27', kevin)
    expect(res.statusCode).toBe(400)
  })
})

describe('tenant isolation', () => {
  it('never leaks another household rhythms', async () => {
    const other = await withClient(async (c) => {
      const h = await c.query<{ id: string }>(`insert into households (name, timezone) values ('Other','UTC') returning id`)
      await c.query(
        `insert into rhythms (household_id, title, satisfied_by, every, next_due_at)
         values ($1,'Foreign filter','completion','3 months', now())`,
        [h.rows[0].id]
      )
      return h.rows[0].id
    })
    expect(other).toBeTruthy()
    const res = await call('GET', '/api/rhythms', kevin)
    const titles = JSON.parse(res.body).rhythms.map((r: { title: string }) => r.title)
    expect(titles).not.toContain('Foreign filter')
  })
})
