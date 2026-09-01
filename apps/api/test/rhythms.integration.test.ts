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

  // The line is drawn around the SWITCH, not the feature. A module-gated feature has a
  // standing temptation to gate itself as well, which would make an optional feature an
  // admin one — a household turns rhythms on so the household can use them, not so the
  // owner can. Every route here is a plain tenantRoute and only the toggle is adminRoute,
  // and neither half had a test: this was a manual step on the walkthrough checklist,
  // which is the wrong place to answer a question the server can answer for itself.
  describe('a member who is not an admin', () => {
    let george = ''

    beforeAll(async () => {
      const id = await withClient(async (c) => {
        const p = await c.query<{ id: string }>(
          `insert into persons (household_id, name, member_type, is_admin)
           values ($1, 'George', 'adult', false) returning id`,
          [householdId]
        )
        const pid = p.rows[0]!.id
        await c.query(
          `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified)
           values ($1,$2,'password','dev|george',true)`,
          [householdId, pid]
        )
        return pid
      })
      expect(id).toBeTruthy()
      george = mint('dev|george')
    })

    it('can use rhythms fully — read, create, complete, skip, edit, retire', async () => {
      expect((await call('GET', '/api/rhythms', george)).statusCode).toBe(200)
      expect((await call('GET', '/api/rhythms/attention?from=2026-08-18&to=2026-08-18', george)).statusCode).toBe(200)

      const made = await call('POST', '/api/rhythms', george, {
        title: 'George bins', satisfiedBy: 'scheduling', every: '1 week', startsOn: '2026-01-01',
      })
      expect(made.statusCode).toBe(201)
      const id = JSON.parse(made.body).rhythm.id

      expect((await call('POST', `/api/rhythms/${id}/skip`, george, { periodStart: '2026-01-08' })).statusCode).toBeLessThan(300)
      expect((await call('POST', `/api/rhythms/${id}/schedule`, george, { startsAt: '2027-06-02T18:00:00Z' })).statusCode).toBe(201)
      expect((await call('PATCH', `/api/rhythms/${id}`, george, { title: 'George bins, renamed' })).statusCode).toBe(200)
      expect((await call('DELETE', `/api/rhythms/${id}`, george)).statusCode).toBeLessThan(300)

      const done = await call('POST', '/api/rhythms', george, {
        title: 'George filter', satisfiedBy: 'completion', every: '1 month',
        nextDueAt: '2027-01-01T00:00:00Z',
      })
      const doneId = JSON.parse(done.body).rhythm.id
      expect((await call('POST', `/api/rhythms/${doneId}/complete`, george, {})).statusCode).toBe(200)
      await call('DELETE', `/api/rhythms/${doneId}`, george)
    })

    it('still cannot turn the module off for everyone', async () => {
      const res = await call('PATCH', '/api/household/modules', george, { rhythms: false })
      expect(res.statusCode).toBe(403)
      // ...and the refusal changed nothing.
      expect((await call('GET', '/api/rhythms', kevin)).statusCode).toBe(200)
    })
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
    // Relative to now, not a fixed date: this was pinned to 2026-09-15, which quietly
    // became a FUTURE completion once the wall clock passed the fixture — and a future
    // completion is now refused, as it should be. A date the suite can never outrun.
    const doneAt = new Date(Date.now() - 10 * 86400000)
    doneAt.setUTCHours(12, 0, 0, 0)
    const res = await call('POST', `/api/rhythms/${filterId}/complete`, kevin, {
      completedAt: doneAt.toISOString(),
      notes: 'ordered a 3-pack',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body).rhythm
    expect(body.lastCompletedAt).toBe(doneAt.toISOString())
    // completion + 3 months, NOT the old due date + 3 months.
    const expected = new Date(doneAt)
    expected.setUTCMonth(expected.getUTCMonth() + 3)
    expect(body.nextDueAt).toBe(expected.toISOString())
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

  // "Positive" is not the property generate_series needs; "advances" is. Interval
  // comparison normalizes a month to 30 days, so '1 mon -29 days' compares as +1 day and
  // sails past any nominal test — but MONTH ARITHMETIC CLAMPS FIRST: Jan 31 + 1 mon is
  // Feb 28, and minus 29 days is Jan 30. The step lands a day EARLIER than it started, so
  // the series never reaches its end and never terminates.
  //
  // That is strictly worse than the zero-step case above. A zero step raises an error;
  // this one holds a pool connection open forever. The pool is 10 wide and this deployment
  // runs with statement_timeout = 0, so a handful of these takes the API down for every
  // household on the box — not just the one that owns the bad row.
  it('refuses a cadence that steps backwards off a month end', async () => {
    const res = await call('POST', '/api/rhythms', kevin, {
      title: 'Never ends', satisfiedBy: 'scheduling', every: '1 mon -29 days', startsOn: '2026-01-31',
    })
    expect(res.statusCode).toBe(400)

    // The register still answers — and answers PROMPTLY, which is the actual claim.
    const started = Date.now()
    const list = await call('GET', '/api/rhythms', kevin)
    expect(list.statusCode).toBe(200)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  // Periods are dated (period_start is a date, and rhythm_skips is keyed on it), so a
  // sub-day cycle collapses several periods onto one key and they stop being distinct.
  // A one-second cadence anchored a few years back is also ~10^8 rows per read.
  it('refuses a cadence shorter than a day', async () => {
    const res = await call('POST', '/api/rhythms', kevin, {
      title: 'Every twelve hours', satisfiedBy: 'scheduling', every: '12 hours', startsOn: '2026-01-01',
    })
    expect(res.statusCode).toBe(400)
  })

  // The guard has to let the real cadences through — a month-end anchor especially, since
  // that is the very case the backwards-step probe is built around. Cleans up after itself:
  // this household is shared with the rest of the file, and an extra row moves counts.
  it('still accepts the real cadences, including a month-end anchor', async () => {
    for (const [every, startsOn] of [['7 days', '2026-01-01'], ['1 mon', '2026-01-31'], ['3 mons', '2026-01-01']]) {
      const res = await call('POST', '/api/rhythms', kevin, {
        title: `Fine ${every}`, satisfiedBy: 'scheduling', every, startsOn,
      })
      expect(res.statusCode).toBe(201)
      const created = JSON.parse(res.body).rhythm
      expect((await call('DELETE', `/api/rhythms/${created.id}`, kevin)).statusCode).toBeLessThan(300)
    }
  })

  it('refuses a recurrence rule the calendar cannot expand', async () => {
    // Unvalidated, this COMMITS the event and then throws expanding it, leaving a master
    // behind that can never produce an occurrence. Both event write paths already check.
    const res = await call('POST', '/api/rhythms', kevin, {
      title: 'Banana', satisfiedBy: 'scheduling', every: '1 week',
      startsOn: '2026-01-01', autoSchedule: true, rrule: 'FREQ=BANANA',
    })
    expect(res.statusCode).toBe(400)
  })

  // A rhythm is perpetual — the cadence says how often, and the rule only says which day
  // inside each period. A rule that stops on its own contradicts that, and fails silently:
  // once the last occurrence passes, every later period looks empty while the master row
  // still carries an rrule, so the register keeps offering "book this one" and the series
  // is never put back. COUNT and UNTIL live inside the rule string, where no SQL predicate
  // can see them — so unlike a capped series, this one can only be caught at the door.
  // `every`, `nextDueAt` and `rrule` are all validated at the door on these same paths, so
  // the values that reach ::interval and ::date unchecked are the asymmetry — a 500 and a
  // stack trace where the field beside them gets a sentence and a 400.
  it('refuses an unparseable lead time with a 400 rather than a 500', async () => {
    const create = await call('POST', '/api/rhythms', kevin, {
      title: 'Bad runway', satisfiedBy: 'completion', every: '1 month',
      nextDueAt: '2027-01-01T00:00:00Z', leadTime: 'soon',
    })
    expect(create.statusCode).toBe(400)

    const ok = await call('POST', '/api/rhythms', kevin, {
      title: 'Good runway', satisfiedBy: 'completion', every: '1 month',
      nextDueAt: '2027-01-01T00:00:00Z',
    })
    const id = JSON.parse(ok.body).rhythm.id
    const patch = await call('PATCH', `/api/rhythms/${id}`, kevin, { leadTime: 'whenever' })
    expect(patch.statusCode).toBe(400)
    await call('DELETE', `/api/rhythms/${id}`, kevin)
  })

  // A negative runway inverts it: next_due_at - lead_time moves LATER than the due date,
  // so the rhythm first asks for attention days after it was already due.
  it('refuses a negative lead time, which would open the runway after the due date', async () => {
    const res = await call('POST', '/api/rhythms', kevin, {
      title: 'Backwards runway', satisfiedBy: 'completion', every: '1 month',
      nextDueAt: '2027-01-01T00:00:00Z', leadTime: '-5 days',
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuses an unparseable start date with a 400 rather than a 500', async () => {
    const res = await call('POST', '/api/rhythms', kevin, {
      title: 'Bad anchor', satisfiedBy: 'scheduling', every: '1 week', startsOn: 'not-a-date',
    })
    expect(res.statusCode).toBe(400)
  })

  // The shape regex passes anything with the right digits, so an impossible date sails
  // through the 400 check and then fails inside Postgres as "date/time field value out of
  // range" — the exact 500 the check exists to prevent.
  it('refuses an impossible date on the window and on skip', async () => {
    const attention = await call('GET', '/api/rhythms/attention?from=2026-01-01&to=2026-13-45', kevin)
    expect(attention.statusCode).toBe(400)

    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Skip target', satisfiedBy: 'scheduling', every: '1 week', startsOn: '2026-01-01',
    })
    const id = JSON.parse(made.body).rhythm.id
    const skip = await call('POST', `/api/rhythms/${id}/skip`, kevin, { periodStart: '2026-13-45' })
    expect(skip.statusCode).toBe(400)
    await call('DELETE', `/api/rhythms/${id}`, kevin)
  })

  // A write that reports success and does nothing is the worst shape there is. Skips are
  // keyed on period_start and every reader matches that against a boundary the SERVER
  // computed, so a date that is not a boundary inserts happily, returns ok, and silences
  // nothing — the row goes on asking. A client rendering a period whose boundary has since
  // moved is exactly how you get there.
  // Two taps on the same day fold into one history row — that is deliberate, so the
  // register can answer "when did we last change it?" without filling up with repeats
  // nobody performed. But the fold handed the row to whoever tapped LAST, so a second
  // person took the credit. `notes` on the same statement was already protected; the
  // person was not.
  it('keeps the first person on a completion two people log the same day', async () => {
    const elaine = await withClient(async (c) => {
      const p = await c.query<{ id: string }>(
        `insert into persons (household_id, name, member_type) values ($1, 'Elaine', 'adult') returning id`,
        [householdId]
      )
      const id = p.rows[0]!.id
      await c.query(
        `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified)
         values ($1,$2,'password','dev|elaine',true)`,
        [householdId, id]
      )
      return id
    })
    const elaineToken = mint('dev|elaine')

    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Shared filter', satisfiedBy: 'completion', every: '1 month',
      nextDueAt: '2027-01-01T00:00:00Z',
    })
    const id = JSON.parse(made.body).rhythm.id

    expect((await call('POST', `/api/rhythms/${id}/complete`, kevin, {})).statusCode).toBe(200)
    expect((await call('POST', `/api/rhythms/${id}/complete`, elaineToken, {})).statusCode).toBe(200)

    const rows = await withClient((c) =>
      c.query<{ person_id: string | null }>(
        `select person_id from rhythm_completions where rhythm_id = $1`, [id]
      )
    )
    // Folded to one row, and it still belongs to the person who actually did it.
    expect(rows.rowCount).toBe(1)
    expect(rows.rows[0]!.person_id).toBe(kevinId)
    expect(rows.rows[0]!.person_id).not.toBe(elaine)

    await call('DELETE', `/api/rhythms/${id}`, kevin)
  })

  // Satisfaction is derived per period, so any booking is legal — it settles whichever
  // period it lands in, which is what makes booking ahead work and is worth keeping. What
  // was missing was a way to say which period you MEANT: a booking that landed outside it
  // returned 201, put a real event on the calendar, and left the card asking, with nothing
  // anywhere explaining why. The server can't read that intent out of an instant, so the
  // caller states it and the server checks it.
  it('refuses a booking that falls outside the period the caller named', async () => {
    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Named period', satisfiedBy: 'scheduling', every: '1 week', startsOn: '2027-04-05',
    })
    const id = JSON.parse(made.body).rhythm.id

    // Period 2027-04-05 → 04-12. A booking two weeks out is in a different one.
    const wrong = await call('POST', `/api/rhythms/${id}/schedule`, kevin, {
      startsAt: '2027-04-20T18:00:00Z', periodStart: '2027-04-05',
    })
    expect(wrong.statusCode).toBe(400)

    const right = await call('POST', `/api/rhythms/${id}/schedule`, kevin, {
      startsAt: '2027-04-08T18:00:00Z', periodStart: '2027-04-05',
    })
    expect(right.statusCode).toBe(201)

    await call('DELETE', `/api/rhythms/${id}`, kevin)
  })

  // Optional, so a client that hasn't been taught to send it behaves exactly as before.
  it('still books without a named period, so an older client is unaffected', async () => {
    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Unnamed period', satisfiedBy: 'scheduling', every: '1 week', startsOn: '2027-04-05',
    })
    const id = JSON.parse(made.body).rhythm.id
    const res = await call('POST', `/api/rhythms/${id}/schedule`, kevin, {
      startsAt: '2027-04-20T18:00:00Z',
    })
    expect(res.statusCode).toBe(201)
    await call('DELETE', `/api/rhythms/${id}`, kevin)
  })

  it('refuses to skip a date that is not one of the rhythm periods', async () => {
    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Off-boundary skip', satisfiedBy: 'scheduling', every: '1 week', startsOn: '2026-01-01',
    })
    const id = JSON.parse(made.body).rhythm.id

    // 2026-01-01 tiles weekly: Jan 1, 8, 15... The 5th is inside a period, not the start.
    const off = await call('POST', `/api/rhythms/${id}/skip`, kevin, { periodStart: '2026-01-05' })
    expect(off.statusCode).toBe(400)

    const on = await call('POST', `/api/rhythms/${id}/skip`, kevin, { periodStart: '2026-01-08' })
    expect(on.statusCode).toBeLessThan(300)

    await call('DELETE', `/api/rhythms/${id}`, kevin)
  })

  it('refuses a recurrence rule that ends on its own', async () => {
    for (const rrule of ['FREQ=WEEKLY;COUNT=4', 'FREQ=WEEKLY;UNTIL=20270101T000000Z']) {
      const res = await call('POST', '/api/rhythms', kevin, {
        title: `Ends itself ${rrule}`, satisfiedBy: 'scheduling', every: '1 week',
        startsOn: '2026-01-01', autoSchedule: true, rrule,
      })
      expect(res.statusCode).toBe(400)
    }
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

  // `overdue` means LATE, and both clients treat it that way: it sorts the row to the top,
  // paints it red and turns dueLabel into "N days late". It was compared against the
  // window's far edge rather than against now — so the further ahead a caller looked, the
  // more things it was told were already late. The weekly planner asks a week out, which
  // means everything due this week came back late; on the Today card, whose window is one
  // day, the same comparison also called anything due later today late.
  it('does not call a rhythm late merely because the window reaches past its due date', async () => {
    const soon = new Date(Date.now() + 3 * 86_400_000)
    const horizon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Due in three days', satisfiedBy: 'completion', every: '1 month',
      nextDueAt: soon.toISOString(), leadTime: '14 days',
    })
    expect(made.statusCode).toBe(201)
    const id = JSON.parse(made.body).rhythm.id

    const res = await call('GET', `/api/rhythms/attention?from=${horizon}&to=${horizon}`, kevin)
    const item = JSON.parse(res.body).items.find((i: { rhythm: { id: string } }) => i.rhythm.id === id)
    expect(item).toBeDefined()
    expect(item.overdue).toBe(false)

    await call('DELETE', `/api/rhythms/${id}`, kevin)
  })

  it('does call a rhythm late once its due date has actually passed', async () => {
    const past = new Date(Date.now() - 2 * 86_400_000)
    const horizon = new Date().toISOString().slice(0, 10)
    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Two days late', satisfiedBy: 'completion', every: '1 month',
      nextDueAt: past.toISOString(), leadTime: '3 days',
    })
    const id = JSON.parse(made.body).rhythm.id

    const res = await call('GET', `/api/rhythms/attention?from=${horizon}&to=${horizon}`, kevin)
    const item = JSON.parse(res.body).items.find((i: { rhythm: { id: string } }) => i.rhythm.id === id)
    expect(item).toBeDefined()
    expect(item.overdue).toBe(true)

    await call('DELETE', `/api/rhythms/${id}`, kevin)
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
  // The clock restarts from when you actually did it, so a completion dated in the future
  // moves the next one past a day that has not happened and files history for a thing
  // nobody has done. The web form already refuses it (`max` on the date input) — but a
  // guard only the browser enforces is not a rule, and iOS and the API bypass it.
  it('refuses a completion dated in the future', async () => {
    const ahead = new Date(Date.now() + 9 * 86400000).toISOString()
    const res = await call('POST', `/api/rhythms/${brushId}/complete`, kevin, { completedAt: ahead })
    expect(res.statusCode).toBe(400)
  })

  it('still accepts one dated today, clock skew and all', async () => {
    const res = await call('POST', `/api/rhythms/${brushId}/complete`, kevin, {
      completedAt: new Date(Date.now() + 60_000).toISOString(),
    })
    expect(res.statusCode).toBe(200)
  })

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

  // Deleted is not the only way a series ends. "Delete this and all following" caps it with
  // recurrence_end_at and DELIBERATELY leaves the master row alive with its rrule set — so a
  // test for `rrule is not null` still says the series is there while no occurrence ever
  // comes again. Every later period then surfaces as unscheduled-with-a-series, the clients
  // offer "book this one" instead of "put it back", and scheduleRhythm's own liveness probe
  // is blind the same way, so it books a one-off and the series is never restored. The user
  // re-books by hand, forever.
  it('stops claiming a series that was capped by "delete this and all following"', async () => {
    const created = await call('POST', '/api/rhythms', kevin, {
      title: 'Capped bin day',
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

    const master = await withClient((c) =>
      c.query<{ id: string; starts_at: Date }>(
        `select id, starts_at from events where rhythm_id = $1 and rrule is not null and deleted_at is null`,
        [id]
      )
    )
    expect(master.rowCount).toBe(1)
    const seriesId = master.rows[0]!.id

    // Cap it from its very first occurrence: nothing recurring survives.
    const del = await call(
      'DELETE',
      `/api/events/${seriesId}?scope=following&occurrenceStart=${master.rows[0]!.starts_at.toISOString()}`,
      kevin
    )
    expect(del.statusCode).toBe(204)

    // The master row is still there with its rrule — that is the point of capping.
    const still = await withClient((c) =>
      c.query(`select 1 from events where id = $1 and deleted_at is null and rrule is not null`, [seriesId])
    )
    expect(still.rowCount).toBe(1)

    // ...but there is no series left to speak of, and the register must say so.
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
// A recurring master is a TEMPLATE, not an instance. Everywhere else in the codebase that
// unions `events` with `event_occurrences` filters the single-event half to `rrule is null`
// for exactly that reason; the rhythm queries did not. So the master's own `starts_at`
// counted as a booking for whichever period contains it — and cancelling that instance
// tombstones the OCCURRENCE while leaving the master untouched, so the period went on
// reporting itself as booked with nothing on the calendar to show for it.
describe('a cancelled instance of a self-booking series', () => {
  let autoId = ''
  let anchor = ''

  beforeAll(async () => {
    await call('PATCH', '/api/household/modules', kevin, { rhythms: true })
    // Anchored inside the CURRENT period, so the grid actually has one to report on.
    anchor = await withClient(async (c) => {
      const { rows } = await c.query<{ d: string }>(
        `select to_char((now() at time zone 'America/Chicago')::date, 'YYYY-MM-DD') as d`
      )
      return rows[0]!.d
    })
    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Trash night', satisfiedBy: 'scheduling', every: '1 week',
      startsOn: anchor, autoSchedule: true, rrule: 'FREQ=WEEKLY',
    })
    autoId = JSON.parse(made.body).rhythm.id
  })

  it('stops reporting the period as booked once that instance is cancelled', async () => {
    const before = JSON.parse((await call('GET', '/api/rhythms', kevin)).body).rhythms
      .find((r: { id: string }) => r.id === autoId)
    expect(before.satisfied).toBe(true)

    const master = await withClient((c) =>
      c.query<{ id: string; starts_at: Date }>(
        `select id, starts_at from events
          where rhythm_id = $1 and deleted_at is null and rrule is not null`,
        [autoId]
      )
    )
    expect(master.rowCount).toBe(1)

    const del = await call(
      'DELETE',
      `/api/events/${master.rows[0]!.id}?scope=this&occurrenceStart=${encodeURIComponent(master.rows[0]!.starts_at.toISOString())}`,
      kevin
    )
    expect(del.statusCode).toBe(204)

    // Nothing is on the calendar for this period any more. The series is still alive —
    // which is what `hasSeries` is for — but the period itself is empty and has to say so,
    // or the register never offers the one action that would fill it.
    const after = JSON.parse((await call('GET', '/api/rhythms', kevin)).body).rhythms
      .find((r: { id: string }) => r.id === autoId)
    expect(after.bookedAt).toBeNull()
    expect(after.satisfied).toBe(false)
    expect(after.hasSeries).toBe(true)
  })

  // /attention computes its OWN copy of the hasSeries expression, separate from the list
  // query's. Every existing assertion above reads the list, so the attention copy has
  // never been pinned — and it is the one the Today card reads to choose between "put the
  // series back" and "book this one". Get that wrong and the card offers to rebuild a
  // series that is alive, which is the regression this branch already had once: it built a
  // SECOND weekly series beside the first and doubled every future occurrence, for good.
  //
  // Both directions, because both are wrong in different ways.
  it('tells the Today card whether a series is alive, on the attention feed too', async () => {
    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Attention series', satisfiedBy: 'scheduling', every: '1 week',
      startsOn: '2027-05-03', autoSchedule: true, rrule: 'FREQ=WEEKLY;BYDAY=MO',
    })
    expect(made.statusCode).toBe(201)
    const id = JSON.parse(made.body).rhythm.id

    // Period 2027-05-03 → 05-10; the runway clamps to half a week, so it opens on the 6th.
    const item = async () =>
      JSON.parse((await call('GET', '/api/rhythms/attention?from=2027-05-07&to=2027-05-07', kevin)).body)
        .items.find((i: { rhythm: { id: string } }) => i.rhythm.id === id)

    const master = await withClient((c) =>
      c.query<{ id: string; starts_at: Date }>(
        `select id, starts_at from events where rhythm_id = $1 and rrule is not null and deleted_at is null`,
        [id]
      )
    )
    expect(master.rowCount).toBe(1)

    // The series booked itself at creation, so this period is settled and nothing is asked.
    expect(await item()).toBeUndefined()

    // Cancel just THIS occurrence: the period empties, the series lives on.
    const one = await call(
      'DELETE',
      `/api/events/${master.rows[0]!.id}?scope=this&occurrenceStart=${encodeURIComponent(master.rows[0]!.starts_at.toISOString())}`,
      kevin
    )
    expect(one.statusCode).toBe(204)
    const alive = await item()
    expect(alive).toBeDefined()
    expect(alive.kind).toBe('unscheduled')
    expect(alive.hasSeries).toBe(true)

    // Now cap it from its first occurrence: the master survives with its rrule, but there
    // is no occurrence left to come, so what is missing IS the series.
    const capped = await call(
      'DELETE',
      `/api/events/${master.rows[0]!.id}?scope=following&occurrenceStart=${encodeURIComponent(master.rows[0]!.starts_at.toISOString())}`,
      kevin
    )
    expect(capped.statusCode).toBe(204)
    const dead = await item()
    expect(dead).toBeDefined()
    expect(dead.hasSeries).toBe(false)

    await call('DELETE', `/api/rhythms/${id}`, kevin)
  })
})

// The runway clamps to half the cadence, so a scheduling rhythm only starts asking in the
// BACK half of its period — which makes the last day the ordinary day to book on, not an
// edge case. Both booking sheets default to 6pm, and the client's date picker is clamped to
// the period, so it OFFERS that day. It has to count.
describe('booking at 6pm on the last day of a period, west of UTC', () => {
  it('settles the period the booking is actually inside', async () => {
    await call('PATCH', '/api/household/modules', kevin, { rhythms: true })
    // Los Angeles is UTC-7 in August, so 18:00 local is 01:00Z the NEXT day. A period
    // boundary resolved anywhere but the household's own zone puts that just past the end
    // of the period the booking plainly belongs to.
    await withClient((c) => c.query(`update households set timezone = 'America/Los_Angeles'`))
    try {
      const made = await call('POST', '/api/rhythms', kevin, {
        title: 'Late booker', satisfiedBy: 'scheduling', every: '1 week',
        startsOn: '2026-08-06',
      })
      const id = JSON.parse(made.body).rhythm.id

      // Ask the server which period it thinks we are in, rather than deriving one here —
      // deriving it is the very mistake under test.
      const before = JSON.parse((await call('GET', '/api/rhythms', kevin)).body).rhythms
        .find((r: { id: string }) => r.id === id)
      expect(before.currentPeriodEnd).toBeTruthy()

      // 6pm on the period's LAST day, in the household's own timezone.
      const at6pm = await withClient(async (c) => {
        const { rows } = await c.query<{ t: Date }>(
          `select ((($1::date - 1) + time '18:00') at time zone 'America/Los_Angeles') as t`,
          [before.currentPeriodEnd]
        )
        return rows[0]!.t.toISOString()
      })

      expect((await call('POST', `/api/rhythms/${id}/schedule`, kevin, {
        startsAt: at6pm, allDay: false,
      })).statusCode).toBe(201)

      const after = JSON.parse((await call('GET', '/api/rhythms', kevin)).body).rhythms
        .find((r: { id: string }) => r.id === id)
      expect(after.bookedAt).toBe(at6pm)
      expect(after.satisfied).toBe(true)
    } finally {
      await withClient((c) => c.query(`update households set timezone = 'America/Chicago'`))
    }
  })
})

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
