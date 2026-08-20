// The rhythm→event back-reference, across every path that writes an event.
//
// This is the piece with no error to catch. A scheduling-shape rhythm is satisfied by
// "an event in this period points at me" — derived, never materialised. So if any write
// path drops `rhythm_id`, nothing throws, nothing logs: the period simply goes back to
// nagging you to book something you already booked. `events` has three writers (REST,
// the PowerSync upload sink, and the Google pull), and the link has to survive all of them.
//
// See docs/product/rhythms-plan.md — "Why rhythms must generate real events".
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
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
let outsiderRhythmId = ''

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}
const kevin = mint('dev|kevin')

interface RunResult { statusCode: number; body: string }
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

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

async function rhythmIdOf(eventId: string): Promise<string | null> {
  return withClient(async (c) => {
    const { rows } = await c.query<{ rhythm_id: string | null }>(
      `select rhythm_id from events where id = $1`,
      [eventId]
    )
    return rows[0]?.rhythm_id ?? null
  })
}

// The rhythm every test in this file books against: a family outing on the third
// weekend of the month, which is the user's own use case for the scheduling shape.
let outingId = ''

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
  expect((await call('PATCH', '/api/household/modules', kevin, { rhythms: true })).statusCode).toBe(200)

  const made = await call('POST', '/api/rhythms', kevin, {
    title: 'Family outing',
    emoji: '🎡',
    satisfiedBy: 'scheduling',
    every: '1 month',
    startsOn: '2026-09-01',
  })
  expect(made.statusCode).toBe(201)
  outingId = JSON.parse(made.body).rhythm.id

  // A rhythm belonging to somebody else entirely, for the isolation checks.
  outsiderRhythmId = await withClient(async (c) => {
    const h = await c.query<{ id: string }>(`insert into households (name, timezone) values ('Other','UTC') returning id`)
    const r = await c.query<{ id: string }>(
      `insert into rhythms (household_id, title, satisfied_by, every, starts_on)
       values ($1,'Their outing','scheduling','1 month','2026-09-01') returning id`,
      [h.rows[0].id]
    )
    return r.rows[0].id
  })
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('a rhythm-linked event, written over REST', () => {
  let eventId = ''

  it('keeps the link it was created with', async () => {
    const res = await call('POST', '/api/events', kevin, {
      title: 'Zoo trip',
      startsAt: '2026-09-19T15:00:00Z',
      endsAt: '2026-09-19T18:00:00Z',
      rhythmId: outingId,
    })
    expect(res.statusCode).toBe(201)
    eventId = JSON.parse(res.body).event.id
    expect(await rhythmIdOf(eventId)).toBe(outingId)
  })

  it('reads the link back out on the event', async () => {
    const res = await call('GET', '/api/events?from=2026-09-01&to=2026-09-30', kevin)
    const ev = JSON.parse(res.body).events.find((e: { id: string }) => e.id === eventId)
    expect(ev.rhythmId).toBe(outingId)
  })

  it('keeps the link through an edit that never mentions it', async () => {
    // Moving the outing an hour later must not un-book the month.
    const res = await call('PATCH', `/api/events/${eventId}`, kevin, { startsAt: '2026-09-19T16:00:00Z' })
    expect(res.statusCode).toBe(200)
    expect(await rhythmIdOf(eventId)).toBe(outingId)
  })
})

// The link is a household-scoped reference like goal_id, and it was going in unchecked:
// the foreign key only proves the rhythm EXISTS, not that it's yours. Left open, one
// household could point an event at another household's rhythm and silently satisfy
// their period.
// 404 rather than 400, matching how every other cross-household reference answers here
// (person, goal, goal step, calendar): from this household's side the row genuinely does
// not exist, and saying so doesn't confirm that someone else's rhythm does.
describe('the link is household-scoped', () => {
  it('refuses an event pointed at another household rhythm', async () => {
    const res = await call('POST', '/api/events', kevin, {
      title: 'Not mine to satisfy',
      startsAt: '2026-09-19T15:00:00Z',
      endsAt: '2026-09-19T18:00:00Z',
      rhythmId: outsiderRhythmId,
    })
    expect(res.statusCode).toBe(404)
  })

  it('refuses to patch an event onto another household rhythm', async () => {
    const made = await call('POST', '/api/events', kevin, {
      title: 'Plain event', startsAt: '2026-09-20T15:00:00Z', endsAt: '2026-09-20T16:00:00Z',
    })
    const id = JSON.parse(made.body).event.id
    expect((await call('PATCH', `/api/events/${id}`, kevin, { rhythmId: outsiderRhythmId })).statusCode).toBe(404)
    expect(await rhythmIdOf(id)).toBeNull()
  })

  it('refuses a foreign rhythm arriving through the PowerSync sink', async () => {
    const res = await call('POST', '/api/powersync/crud', kevin, {
      ops: [{ op: 'PUT', table: 'events', id: randomUUID(), data: {
        title: 'Offline outing', starts_at: '2026-09-19T15:00:00Z', ends_at: '2026-09-19T18:00:00Z',
        all_day: 0, rhythm_id: outsiderRhythmId,
      } }],
    })
    expect(res.statusCode).toBe(404)
  })
})

// The PowerSync sink's events PUT writes the WHOLE row, so every column it overwrites
// from `excluded` is a column a client can blank by not knowing about it. The web bundle
// is baked into the caddy image and served through a service worker, so "a client running
// last week's schema" is a normal condition here, not a hypothetical.
describe('a rhythm-linked event, written through the PowerSync sink', () => {
  const eventId = randomUUID()

  it('accepts the link on an offline-authored event', async () => {
    const res = await call('POST', '/api/powersync/crud', kevin, {
      ops: [{ op: 'PUT', table: 'events', id: eventId, data: {
        title: 'Museum', starts_at: '2026-10-17T15:00:00Z', ends_at: '2026-10-17T18:00:00Z',
        all_day: 0, person_id: kevinId, rhythm_id: outingId,
      } }],
    })
    expect(res.statusCode).toBe(200)
    expect(await rhythmIdOf(eventId)).toBe(outingId)
  })

  it('survives a re-PUT from a client whose schema predates the column', async () => {
    // The whole failure mode in one assertion: an old kiosk renames the event and the
    // month quietly goes back to "needs scheduling".
    const res = await call('POST', '/api/powersync/crud', kevin, {
      ops: [{ op: 'PUT', table: 'events', id: eventId, data: {
        title: 'Museum (renamed)', starts_at: '2026-10-17T15:00:00Z', ends_at: '2026-10-17T18:00:00Z',
        all_day: 0, person_id: kevinId,
      } }],
    })
    expect(res.statusCode).toBe(200)
    expect(await rhythmIdOf(eventId)).toBe(outingId)
  })

  it('survives a PATCH that touches other columns', async () => {
    await call('POST', '/api/powersync/crud', kevin, {
      ops: [{ op: 'PATCH', table: 'events', id: eventId, data: { title: 'Museum (moved)' } }],
    })
    expect(await rhythmIdOf(eventId)).toBe(outingId)
  })

  it('still lets a client that knows the column unlink deliberately', async () => {
    // Preserving on PUT would otherwise make the link write-once. An explicit null in a
    // PATCH is the one unambiguous "I mean it" signal a client can send.
    await call('POST', '/api/powersync/crud', kevin, {
      ops: [{ op: 'PATCH', table: 'events', id: eventId, data: { rhythm_id: null } }],
    })
    expect(await rhythmIdOf(eventId)).toBeNull()
  })
})

// The satisfaction rule is derived, so these paths only matter through their effect on
// /rhythms/attention. This is the assertion the UI actually depends on.
describe('the effect on what needs attention', () => {
  it('a linked event books the month, and losing the link un-books it', async () => {
    const window = '/api/rhythms/attention?from=2026-11-01&to=2026-11-30'
    const idsNow = async () => {
      const res = await call('GET', window, kevin)
      return JSON.parse(res.body).items.map((i: { rhythm: { id: string } }) => i.rhythm.id)
    }
    expect(await idsNow()).toContain(outingId)

    const made = await call('POST', '/api/events', kevin, {
      title: 'November outing',
      startsAt: '2026-11-21T15:00:00Z',
      endsAt: '2026-11-21T18:00:00Z',
      rhythmId: outingId,
    })
    const id = JSON.parse(made.body).event.id
    expect(await idsNow()).not.toContain(outingId)

    // Deleting the booking has to hand the month back, or a cancelled outing silently
    // stays "handled" forever.
    expect((await call('DELETE', `/api/events/${id}`, kevin)).statusCode).toBe(204)
    expect(await idsNow()).toContain(outingId)
  })
})

// Booking is the whole point of the scheduling shape: the rhythm's job is to make sure
// the opportunity lands on the calendar, so it has to be able to put it there itself
// rather than telling you to go and do it somewhere else.
describe('booking a period from the rhythm', () => {
  let templeId = ''

  beforeAll(async () => {
    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Temple visit',
      emoji: '🕊️',
      satisfiedBy: 'scheduling',
      every: '3 months',
      startsOn: '2026-07-01',
      personId: kevinId,
    })
    expect(made.statusCode).toBe(201)
    templeId = JSON.parse(made.body).rhythm.id
  })

  it('creates a real event, not a chip, so it can carry reminders', async () => {
    const res = await call('POST', `/api/rhythms/${templeId}/schedule`, kevin, {
      startsAt: '2026-10-10T14:00:00Z',
      endsAt: '2026-10-10T16:00:00Z',
    })
    expect(res.statusCode).toBe(201)
    const ev = JSON.parse(res.body).event
    expect(ev.rhythmId).toBe(templeId)
    // Titled and assigned from the rhythm, so booking takes one tap and no typing.
    expect(ev.title).toBe('Temple visit')
    expect(ev.personId).toBe(kevinId)
    expect(await rhythmIdOf(ev.id)).toBe(templeId)
  })

  it('silences the period it booked', async () => {
    const res = await call('GET', '/api/rhythms/attention?from=2026-10-01&to=2026-10-31', kevin)
    const ids = JSON.parse(res.body).items.map((i: { rhythm: { id: string } }) => i.rhythm.id)
    expect(ids).not.toContain(templeId)
  })

  it('refuses to book a completion-shape rhythm', async () => {
    // "I did the thing" has no slot to book — offering one would just create an event
    // that satisfies nothing.
    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Air filter', satisfiedBy: 'completion', every: '3 months', nextDueAt: '2026-10-01T00:00:00Z',
    })
    const id = JSON.parse(made.body).rhythm.id
    expect((await call('POST', `/api/rhythms/${id}/schedule`, kevin, {
      startsAt: '2026-10-10T14:00:00Z', endsAt: '2026-10-10T16:00:00Z',
    })).statusCode).toBe(400)
  })

  it('404s for a rhythm belonging to somebody else', async () => {
    expect((await call('POST', `/api/rhythms/${outsiderRhythmId}/schedule`, kevin, {
      startsAt: '2026-10-10T14:00:00Z', endsAt: '2026-10-10T16:00:00Z',
    })).statusCode).toBe(404)
  })
})

// An auto_schedule rhythm books ONE recurring event and is then satisfied forever after —
// which only works if satisfaction can see the occurrences the rule generates. Checking
// only `events.starts_at` sees the master row alone, so the series would satisfy the month
// it was created in and every later month would resurface as "needs scheduling" while the
// outing sat right there on the calendar.
describe('a recurring booking satisfies every period it covers', () => {
  let seriesRhythmId = ''

  beforeAll(async () => {
    const made = await call('POST', '/api/rhythms', kevin, {
      title: 'Third-weekend outing',
      satisfiedBy: 'scheduling',
      every: '1 month',
      startsOn: '2026-09-01',
      autoSchedule: true,
      rrule: 'FREQ=MONTHLY;BYDAY=3SA',
    })
    expect(made.statusCode).toBe(201)
    seriesRhythmId = JSON.parse(made.body).rhythm.id
  })

  // Creating an auto-scheduled rhythm books its series, so by this point one already
  // exists. Asserted explicitly because satisfaction can't see the difference: it only
  // asks whether SOME occurrence falls in the period, so a second overlapping series
  // would leave every assertion below green while quietly double-booking the calendar.
  it('is already on the calendar exactly once, before anyone books it', async () => {
    const events = await withClient((c) =>
      c.query(`select 1 from events where rhythm_id = $1 and deleted_at is null`, [seriesRhythmId])
    )
    expect(events.rowCount).toBe(1)
  })

  it('books the whole series in one go', async () => {
    const res = await call('POST', `/api/rhythms/${seriesRhythmId}/schedule`, kevin, {
      startsAt: '2026-09-19T15:00:00Z',
      endsAt: '2026-09-19T18:00:00Z',
    })
    expect(res.statusCode).toBe(201)
    // The rhythm's own rule, so the caller never restates the recurrence.
    expect(JSON.parse(res.body).event.rrule).toBe('FREQ=MONTHLY;BYDAY=3SA')
  })

  it('is satisfied in the month it was created', async () => {
    const res = await call('GET', '/api/rhythms/attention?from=2026-09-01&to=2026-09-30', kevin)
    const ids = JSON.parse(res.body).items.map((i: { rhythm: { id: string } }) => i.rhythm.id)
    expect(ids).not.toContain(seriesRhythmId)
  })

  it('is still satisfied three months later, off the generated occurrences', async () => {
    const res = await call('GET', '/api/rhythms/attention?from=2026-12-01&to=2026-12-31', kevin)
    const ids = JSON.parse(res.body).items.map((i: { rhythm: { id: string } }) => i.rhythm.id)
    expect(ids).not.toContain(seriesRhythmId)
  })
})
