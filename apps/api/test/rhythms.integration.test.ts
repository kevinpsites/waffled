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
// `every` lands in a Postgres `interval` and is then fed to `generate_series` to tile the
// period grid. A zero step raises "step size cannot equal zero" INSIDE the list query, and
// the route only converts InvalidReferenceError to a 400 — so a single bad row 500s the
// whole household's register and Today card, for every member, until someone repairs it by
// hand. Refusing the value at the door is the only place this is cheap.
describe('a cadence the period grid cannot be built from', () => {
  it('refuses a zero-length cadence rather than letting it 500 the whole register', async () => {
    const res = await call('POST', '/api/rhythms', kevin, {
      title: 'Poison pill', satisfiedBy: 'scheduling', every: '0 seconds', startsOn: '2026-01-01',
    })
    expect(res.statusCode).toBe(400)

    // ...and the list still answers, which is the thing actually being protected.
    const list = await call('GET', '/api/rhythms', kevin)
    expect(list.statusCode).toBe(200)
  })

  it('refuses a cadence that is not an interval at all, with a 400 rather than a 500', async () => {
    const res = await call('POST', '/api/rhythms', kevin, {
      title: 'Nonsense', satisfiedBy: 'scheduling', every: 'whenever', startsOn: '2026-01-01',
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuses a first due date that is not a date, the way the edit path already does', async () => {
    const res = await call('POST', '/api/rhythms', kevin, {
      title: 'Bad date', satisfiedBy: 'completion', every: '3 months', nextDueAt: 'garbage',
    })
    expect(res.statusCode).toBe(400)
  })
})

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

  // The horizon is the only bound the query actually uses, so demanding `from` as well
  // was requiring a value we then threw away. Still validated when sent, so a caller
  // passing a window gets told when it's malformed rather than silently ignored.
  it('accepts the horizon on its own', async () => {
    const res = await call('GET', '/api/rhythms/attention?to=2026-09-27', kevin)
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(JSON.parse(res.body).items)).toBe(true)
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

// A register you can only add to isn't a register. Without these, a typo in a title is
// permanent and an unwanted rhythm nags forever — and the management screen was already
// rendering a "Paused" badge that nothing could ever set, which is the dead-control smell
// this repo has been caught by before.
describe('editing and retiring a rhythm', () => {
  let id = ''

  beforeAll(async () => {
    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Waterr filter', satisfiedBy: 'completion', every: '6 months',
      nextDueAt: '2026-12-01T00:00:00Z',
    })
    id = JSON.parse(made.body).rhythm.id
  })

  it('edits the plain descriptive fields', async () => {
    const res = await call('PATCH', `/api/rhythms/${id}`, kevin, {
      title: 'Water filter', emoji: '💧', notes: 'under the sink',
    })
    expect(res.statusCode).toBe(200)
    const r = JSON.parse(res.body).rhythm
    expect(r.title).toBe('Water filter')
    expect(r.emoji).toBe('💧')
    expect(r.notes).toBe('under the sink')
  })

  it('leaves untouched fields alone', async () => {
    const res = await call('PATCH', `/api/rhythms/${id}`, kevin, { notes: 'in the garage' })
    const r = JSON.parse(res.body).rhythm
    expect(r.title).toBe('Water filter')
    expect(r.every).toBe('6 mons')
  })

  it('re-clamps the lead time when the cadence shortens under it', async () => {
    // The clamp is applied on write, so a rhythm edited from six months down to weekly
    // would otherwise keep a 14-day runway it can never close and start nagging forever.
    const res = await call('PATCH', `/api/rhythms/${id}`, kevin, { every: '7 days' })
    expect(JSON.parse(res.body).rhythm.leadTime).toBe('3 days 12:00:00')
  })

  it('pauses a rhythm so it stops asking without losing its history', async () => {
    expect((await call('PATCH', `/api/rhythms/${id}`, kevin, { isActive: false })).statusCode).toBe(200)
    const res = await call('GET', '/api/rhythms/attention?from=2027-01-01&to=2027-12-31', kevin)
    const ids = JSON.parse(res.body).items.map((i: { rhythm: { id: string } }) => i.rhythm.id)
    expect(ids).not.toContain(id)
    // Still listed, so it can be switched back on.
    const listed = JSON.parse((await call('GET', '/api/rhythms', kevin)).body).rhythms
    expect(listed.find((r: { id: string }) => r.id === id)?.isActive).toBe(false)
  })

  it('deletes a rhythm out of the register entirely', async () => {
    expect((await call('DELETE', `/api/rhythms/${id}`, kevin)).statusCode).toBe(204)
    const listed = JSON.parse((await call('GET', '/api/rhythms', kevin)).body).rhythms
    expect(listed.map((r: { id: string }) => r.id)).not.toContain(id)
  })

  it('404s on a rhythm belonging to somebody else', async () => {
    const foreign = await withClient(async (c) => {
      const h = await c.query<{ id: string }>(`insert into households (name, timezone) values ('Other edit','UTC') returning id`)
      const r = await c.query<{ id: string }>(
        `insert into rhythms (household_id, title, satisfied_by, every, next_due_at)
         values ($1,'Theirs','completion','3 months', now()) returning id`,
        [h.rows[0].id]
      )
      return r.rows[0].id
    })
    expect((await call('PATCH', `/api/rhythms/${foreign}`, kevin, { title: 'Mine now' })).statusCode).toBe(404)
    expect((await call('DELETE', `/api/rhythms/${foreign}`, kevin)).statusCode).toBe(404)
  })
})

// The management screen lists every rhythm, including ones months away from their runway.
// /attention deliberately answers only "what needs attention by <horizon>", so without
// period state on the list the screen can't say whether a quarterly rhythm 60 days out is
// handled — and the client can't work it out either, since stepping true calendar months
// from an interval like "3 mons" is exactly the arithmetic the server already owns.
describe('the list carries current-period state', () => {
  it('reports the period a scheduling rhythm is in, and whether it is handled', async () => {
    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Self-care day', satisfiedBy: 'scheduling', every: '3 months', startsOn: '2026-07-01',
    })
    const id = JSON.parse(made.body).rhythm.id

    const before = JSON.parse((await call('GET', '/api/rhythms', kevin)).body).rhythms
      .find((r: { id: string }) => r.id === id)
    expect(before.currentPeriodStart).toBe('2026-07-01')
    expect(before.currentPeriodEnd).toBe('2026-10-01')
    expect(before.satisfied).toBe(false)

    await call('POST', `/api/rhythms/${id}/schedule`, kevin, {
      startsAt: '2026-09-12T18:00:00Z', endsAt: '2026-09-12T21:00:00Z',
    })
    const after = JSON.parse((await call('GET', '/api/rhythms', kevin)).body).rhythms
      .find((r: { id: string }) => r.id === id)
    expect(after.satisfied).toBe(true)
  })

  it('reports a completion rhythm as handled until it comes due', async () => {
    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Smoke alarms', satisfiedBy: 'completion', every: '1 year',
      nextDueAt: '2027-06-01T00:00:00Z',
    })
    const id = JSON.parse(made.body).rhythm.id
    const listed = JSON.parse((await call('GET', '/api/rhythms', kevin)).body).rhythms
      .find((r: { id: string }) => r.id === id)
    expect(listed.satisfied).toBe(true)
    // A period grid is meaningless for the completion shape — its clock restarts from
    // whenever you actually did it, so there are no fixed boundaries to report.
    expect(listed.currentPeriodStart).toBeNull()
  })
})

// Tapping "I did this today" twice in one day is one event, not two.
//
// Found in the demo database: four completion rows for a single air-filter change, three
// of them inside 1.5 seconds. Every tap reached the server and succeeded — the button just
// had no way to say so, because "Last done Aug 19 · Next due Nov 19" recomputes to the
// byte-identical string when you complete the same rhythm again on the same day. So it
// read as broken and got tapped again, and the register quietly filled with history that
// never happened. The clients now acknowledge the tap; this is the other half.
describe('completing the same rhythm twice in a day', () => {
  let brushId = ''

  beforeAll(async () => {
    await call('PATCH', '/api/household/modules', kevin, { rhythms: true })
    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Toothbrush heads', satisfiedBy: 'completion', every: '3 months',
      nextDueAt: '2026-09-01T00:00:00Z',
    })
    brushId = JSON.parse(made.body).rhythm.id
  })

  it('records one completion, not one per tap', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await call('POST', `/api/rhythms/${brushId}/complete`, kevin, {})).statusCode).toBe(200)
    }
    const res = await call('GET', `/api/rhythms/${brushId}/completions`, kevin)
    expect(JSON.parse(res.body).completions).toHaveLength(1)
  })

  it('still re-anchors the clock, so a repeat tap is not an error either', async () => {
    const res = await call('GET', '/api/rhythms', kevin)
    const mine = JSON.parse(res.body).rhythms.find((r: { id: string }) => r.id === brushId)
    // Anchored to the completion, not stacked: three taps must not push it nine months out.
    const months = (new Date(mine.nextDueAt).getTime() - new Date(mine.lastCompletedAt).getTime()) / 86400000
    expect(months).toBeGreaterThan(85)
    expect(months).toBeLessThan(95)
  })

  // The dedupe is per DAY, not "collapse everything" — a genuinely separate completion
  // that happened on another date is real history and has to survive.
  it('keeps a completion logged for a different day', async () => {
    expect((await call('POST', `/api/rhythms/${brushId}/complete`, kevin, {
      completedAt: '2026-05-04T15:00:00Z',
    })).statusCode).toBe(200)
    const res = await call('GET', `/api/rhythms/${brushId}/completions`, kevin)
    expect(JSON.parse(res.body).completions).toHaveLength(2)
  })
})

// "Put it on the calendar automatically" has to actually put it on the calendar.
//
// Creation used to insert the rhythm row and stop there, so the very first thing an
// auto-scheduled rhythm did was turn up in the register offering "Put it back on the
// calendar" — for something that had never been on it. The toggle promised a booking,
// nothing booked, and the only way to honour it was to press a button whose label denied
// the rhythm was new.
describe('an auto-scheduled rhythm lands on the calendar at creation', () => {
  let autoId = ''

  // Enabled here rather than leaning on the gating block above, so this suite still runs
  // when someone filters down to it with -t.
  beforeAll(async () => {
    await call('PATCH', '/api/household/modules', kevin, { rhythms: true })
  })

  it('books the series as part of creating it', async () => {
    const res = await call('POST', '/api/rhythms', kevin, {
      title: 'Trash night',
      satisfiedBy: 'scheduling',
      every: '1 week',
      startsOn: '2027-03-01',
      autoSchedule: true,
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
    })
    expect(res.statusCode).toBe(201)
    autoId = JSON.parse(res.body).rhythm.id

    const events = await withClient((c) =>
      c.query<{ rrule: string }>(
        `select rrule from events where rhythm_id = $1 and deleted_at is null`,
        [autoId]
      )
    )
    expect(events.rowCount).toBe(1)
    // The rhythm's own rule — never a restatement that could disagree with the cadence.
    expect(events.rows[0].rrule).toBe('FREQ=WEEKLY;BYDAY=MO')
  })

  it('starts the series on the anchor date in the household timezone', async () => {
    // The household is America/Chicago. Deriving the instant anywhere but the server is
    // how a booking lands in the wrong period, so Postgres owns the conversion.
    const events = await withClient((c) =>
      c.query<{ local: string }>(
        `select to_char(starts_at at time zone 'America/Chicago', 'YYYY-MM-DD HH24:MI') as local
           from events where rhythm_id = $1 and deleted_at is null`,
        [autoId]
      )
    )
    expect(events.rows[0].local).toBe('2027-03-01 18:00')
  })

  // `satisfied` is deliberately NOT asserted here. It comes from listRhythms, which tiles
  // the period grid from starts_on to now() — so for an anchor this far out there is no
  // current period at all and the flag is false whatever the calendar holds. That is a
  // separate question about how a not-yet-started rhythm reports itself; the guard that
  // this fix worked is /attention, which is horizon-driven and therefore deterministic.
  it('never asks to be put "back" on the calendar it was just put on', async () => {
    // Deliberately INSIDE the nudge runway. A weekly cadence clamps the lead time to half
    // a cycle, so the period 2027-03-01 → 03-08 only starts nudging on the 4th; asking on
    // the 3rd would come back quiet whether or not the booking existed, and prove nothing.
    const res = await call('GET', '/api/rhythms/attention?from=2027-03-01&to=2027-03-07', kevin)
    const ids = JSON.parse(res.body).items.map((i: { rhythm: { id: string } }) => i.rhythm.id)
    expect(ids).not.toContain(autoId)
  })

  // Booking a period on a rhythm whose series is STILL ALIVE used to hand `createEvent`
  // the rhythm's rrule again, with no dedupe — so pressing the register's button after a
  // single instance had been cancelled left two live weekly series and doubled every
  // future occurrence, permanently. The period is what is empty; the series is not.
  it('books a one-off when the series is alive, rather than a second series', async () => {
    const created = await call('POST', '/api/rhythms', kevin, {
      title: 'Temple visit',
      satisfiedBy: 'scheduling',
      every: '1 week',
      startsOn: '2027-03-01',
      autoSchedule: true,
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
    })
    const id = JSON.parse(created.body).rhythm.id

    const res = await call('POST', `/api/rhythms/${id}/schedule`, kevin, {
      startsAt: '2027-03-08T18:00:00Z',
    })
    expect(res.statusCode).toBe(201)
    // The new event repeats never — it fills one empty period and leaves the series be.
    expect(JSON.parse(res.body).event.rrule).toBeNull()

    const series = await withClient((c) =>
      c.query(
        `select 1 from events where rhythm_id = $1 and deleted_at is null and rrule is not null`,
        [id]
      )
    )
    expect(series.rowCount).toBe(1)
  })

  // The case the button was actually built for, which must keep working: nothing recurring
  // is left, so what is missing IS the series and booking one back is the whole point.
  it('re-books the series when none is left alive', async () => {
    const created = await call('POST', '/api/rhythms', kevin, {
      title: 'Deep clean',
      satisfiedBy: 'scheduling',
      every: '1 week',
      startsOn: '2027-03-01',
      autoSchedule: true,
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
    })
    const id = JSON.parse(created.body).rhythm.id
    await withClient((c) =>
      c.query(`update events set deleted_at = now() where rhythm_id = $1`, [id])
    )

    const res = await call('POST', `/api/rhythms/${id}/schedule`, kevin, {
      startsAt: '2027-03-08T18:00:00Z',
    })
    expect(JSON.parse(res.body).event.rrule).toBe('FREQ=WEEKLY;BYDAY=MO')
  })

  // The row cannot word itself without this: "the series needs putting back" and "this one
  // was cancelled" are different sentences with different buttons, and only the server
  // knows whether anything recurring is still alive.
  it('tells the list whether a recurring series still exists', async () => {
    const created = await call('POST', '/api/rhythms', kevin, {
      title: 'Bin day',
      satisfiedBy: 'scheduling',
      every: '1 week',
      startsOn: '2027-03-01',
      autoSchedule: true,
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
    })
    const id = JSON.parse(created.body).rhythm.id
    const find = async () => {
      const list = JSON.parse((await call('GET', '/api/rhythms', kevin)).body).rhythms
      return list.find((r: { id: string }) => r.id === id)
    }
    expect((await find()).hasSeries).toBe(true)

    await withClient((c) =>
      c.query(`update events set deleted_at = now() where rhythm_id = $1`, [id])
    )
    expect((await find()).hasSeries).toBe(false)
  })

  // The anchor date and the repeat rule are separate answers to separate questions, and
  // nothing made them agree: the series was booked at `starts_on` whatever the rule said.
  // Anchor a weekly rhythm on a Wednesday, pick Monday with the day chips, and the first
  // event landed on the Wednesday — contradicting the day the editor had just been used
  // to choose. (The original test for this missed it by accident: 2027-03-01 happens to
  // BE a Monday, so anchor and rule agreed for the wrong reason.)
  it('starts the series on the first day the rule actually allows', async () => {
    const res = await call('POST', '/api/rhythms', kevin, {
      title: 'Bins out',
      satisfiedBy: 'scheduling',
      every: '1 week',
      startsOn: '2027-03-03',            // a Wednesday
      autoSchedule: true,
      rrule: 'FREQ=WEEKLY;BYDAY=MO',     // …but Mondays
    })
    expect(res.statusCode).toBe(201)
    const id = JSON.parse(res.body).rhythm.id

    const events = await withClient((c) =>
      c.query<{ local: string }>(
        `select to_char(starts_at at time zone 'America/Chicago', 'YYYY-MM-DD HH24:MI') as local
           from events where rhythm_id = $1 and deleted_at is null`,
        [id]
      )
    )
    // The following Monday, not the Wednesday it was anchored on.
    expect(events.rows[0].local).toBe('2027-03-08 18:00')
  })

  // The other half of the toggle: OFF means *when* is an open decision every period, so
  // booking one is the user's call and creation must not make it for them.
  it('books nothing when the rhythm is not auto-scheduled', async () => {
    const res = await call('POST', '/api/rhythms', kevin, {
      title: 'Temple visit',
      satisfiedBy: 'scheduling',
      every: '3 months',
      startsOn: '2027-03-01',
      autoSchedule: false,
    })
    expect(res.statusCode).toBe(201)
    const manualId = JSON.parse(res.body).rhythm.id
    const events = await withClient((c) =>
      c.query(`select 1 from events where rhythm_id = $1 and deleted_at is null`, [manualId])
    )
    expect(events.rowCount).toBe(0)
  })
})

// "Push it out a week" — the one edit the register offers that moves the clock.
//
// `next_due_at` was deliberately absent from the PATCH allowlist, on the grounds that
// re-anchoring a live rhythm re-interprets its history. That reasoning holds for the
// PERIOD anchor of a scheduling rhythm — skips are keyed on period_start — but not for a
// completion rhythm, which has no grid at all: moving its due date changes when it next
// asks and nothing else. Marking it done still re-anchors from the completion, so a push
// is one period's reprieve rather than a permanent shift.
describe('pushing a completion rhythm out', () => {
  let gutterId = ''

  beforeAll(async () => {
    await call('PATCH', '/api/household/modules', kevin, { rhythms: true })
    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Gutters', satisfiedBy: 'completion', every: '1 year',
      nextDueAt: '2026-09-01T09:00:00Z',
    })
    gutterId = JSON.parse(made.body).rhythm.id
  })

  it('moves the due date without touching when it was last done', async () => {
    const res = await call('PATCH', `/api/rhythms/${gutterId}`, kevin, {
      nextDueAt: '2026-09-08T09:00:00Z',
    })
    expect(res.statusCode).toBe(200)
    const r = JSON.parse(res.body).rhythm
    expect(new Date(r.nextDueAt).toISOString()).toBe('2026-09-08T09:00:00.000Z')
    // A push is not a completion. Claiming it was done would restart the clock from today
    // and quietly erase the fact that it is still outstanding.
    expect(r.lastCompletedAt).toBeNull()
  })

  it('refuses a value that is not an instant', async () => {
    expect((await call('PATCH', `/api/rhythms/${gutterId}`, kevin, { nextDueAt: 'next tuesday' })).statusCode).toBe(400)
  })

  // The shape CHECK requires next_due_at to be null for a scheduling rhythm, so without
  // this guard the write fails as a 500 from a constraint rather than as an explanation.
  it('refuses to give a scheduling rhythm a due date at all', async () => {
    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Dentist', satisfiedBy: 'scheduling', every: '6 months', startsOn: '2026-01-01',
    })
    const id = JSON.parse(made.body).rhythm.id
    const res = await call('PATCH', `/api/rhythms/${id}`, kevin, { nextDueAt: '2026-09-08T09:00:00Z' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toMatch(/scheduling/i)
  })
})

// A settled row says "Booked" and can't say when.
//
// `satisfied` is a boolean computed from three separate sources — a skip, a one-off event,
// or an occurrence of a recurring master — so the register knows the period is handled but
// not what time it is handled AT, which is the one thing you'd want off a settled row.
describe('when a booked period is actually booked', () => {
  let templeId = ''

  beforeAll(async () => {
    await call('PATCH', '/api/household/modules', kevin, { rhythms: true })
    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Massage', satisfiedBy: 'scheduling', every: '1 month', startsOn: '2026-08-01',
    })
    templeId = JSON.parse(made.body).rhythm.id
  })

  async function row() {
    const res = await call('GET', '/api/rhythms', kevin)
    return JSON.parse(res.body).rhythms.find((r: { id: string }) => r.id === templeId)
  }

  it('reports no booking before anything is on the calendar', async () => {
    const r = await row()
    expect(r.satisfied).toBe(false)
    expect(r.bookedAt).toBeNull()
  })

  it('carries the time and all-day flag of the event that settles it', async () => {
    const start = await withClient(async (c) => {
      const { rows } = await c.query<{ s: Date }>(
        `select (date_trunc('month', now()) + interval '9 days 14 hours') as s`
      )
      return rows[0]!.s.toISOString()
    })
    const ev = await call('POST', `/api/rhythms/${templeId}/schedule`, kevin, { startsAt: start, allDay: false })
    expect(ev.statusCode).toBe(201)

    const r = await row()
    expect(r.satisfied).toBe(true)
    expect(new Date(r.bookedAt).toISOString()).toBe(start)
    expect(r.bookedAllDay).toBe(false)
  })

  // A skip settles a period and has no time. The register has to be able to tell the two
  // apart, or "Booked" gets printed over a period nobody is going to do anything in.
  it('settles a skipped period with no time at all', async () => {
    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Deep clean', satisfiedBy: 'scheduling', every: '3 months', startsOn: '2026-07-01',
    })
    const id = JSON.parse(made.body).rhythm.id
    const before = await call('GET', '/api/rhythms', kevin)
    const period = JSON.parse(before.body).rhythms.find((r: { id: string }) => r.id === id).currentPeriodStart
    expect((await call('POST', `/api/rhythms/${id}/skip`, kevin, { periodStart: period })).statusCode).toBe(200)

    const res = await call('GET', '/api/rhythms', kevin)
    const r = JSON.parse(res.body).rhythms.find((x: { id: string }) => x.id === id)
    expect(r.satisfied).toBe(true)
    expect(r.bookedAt).toBeNull()
  })
})

// The history is unbounded, and one of its readers wants a statistic over all of it.
describe('completion history is paged, and its average is not', () => {
  let hoovId = ''

  beforeAll(async () => {
    await call('PATCH', '/api/household/modules', kevin, { rhythms: true })
    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Hoover', satisfiedBy: 'completion', every: '1 week',
      nextDueAt: '2026-09-01T09:00:00Z',
    })
    hoovId = JSON.parse(made.body).rhythm.id
    // Six completions, a fortnight apart — so the REAL interval is 14 days against a
    // nominal cadence of 7, which is exactly the gap the history panel exists to show.
    for (let i = 5; i >= 0; i--) {
      await call('POST', `/api/rhythms/${hoovId}/complete`, kevin, {
        completedAt: new Date(Date.UTC(2026, 0, 1 + i * 14, 12)).toISOString(),
      })
    }
  })

  it('caps what it returns, newest first, and says there is more', async () => {
    const res = await call('GET', `/api/rhythms/${hoovId}/completions?limit=2`, kevin)
    const body = JSON.parse(res.body)
    expect(body.completions).toHaveLength(2)
    expect(new Date(body.completions[0].completedAt).getTime())
      .toBeGreaterThan(new Date(body.completions[1].completedAt).getTime())
    expect(body.total).toBe(6)
  })

  // The average has to be taken over every completion, not over the page — a "real
  // average" computed from the most recent 20 rows is a recent average wearing the wrong
  // label, and that mislabelling is invisible until someone has years of history.
  it('averages the true interval over all of them, not over the page', async () => {
    const res = await call('GET', `/api/rhythms/${hoovId}/completions?limit=2`, kevin)
    const body = JSON.parse(res.body)
    expect(body.averageIntervalDays).toBeCloseTo(14, 1)
  })

  it('has no average to report from a single completion', async () => {
    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Once', satisfiedBy: 'completion', every: '1 year', nextDueAt: '2027-01-01T09:00:00Z',
    })
    const id = JSON.parse(made.body).rhythm.id
    await call('POST', `/api/rhythms/${id}/complete`, kevin, {})
    const body = JSON.parse((await call('GET', `/api/rhythms/${id}/completions`, kevin)).body)
    expect(body.total).toBe(1)
    // One date is not an interval. Reporting 0 would read as "you do this every day".
    expect(body.averageIntervalDays).toBeNull()
  })

  it('clamps a silly limit rather than trusting it', async () => {
    const res = await call('GET', `/api/rhythms/${hoovId}/completions?limit=99999`, kevin)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).completions.length).toBeLessThanOrEqual(200)
  })
})
