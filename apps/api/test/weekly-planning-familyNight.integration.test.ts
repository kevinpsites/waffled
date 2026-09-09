// Weekly Planning · step 4 (Family night) — against a real Postgres (Testcontainers).
//
// The read is scoped to the WEEK BEING PLANNED, not the module's "next gathering on or
// after today", and three rules hold: a pin lives on the OCCURRENCE (a date), never on
// households.settings; the occurrence COUNT is the rotation's clock, so a pin advances
// next week's turn; calling the week off leaves the recurring calendar event alone.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let householdId: string
let people: { id: string; name: string }[]

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}

// lambda-api reads the query off `queryStringParameters`, NOT off the path — a `?x=y`
// left in `path` is silently invisible to the handler.
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
  ) as Promise<{ statusCode: number; body: string }>
}

const kevin = mint('dev|kevin')
const json = (r: { body: string }) => JSON.parse(r.body)

interface BoardPart {
  partId: string; label: string; emoji: string; rotates: boolean
  detail: string | null
  personId: string | null; personName: string | null; pinned: boolean
}
interface Board {
  weekStart: string; date: string; dayOfWeek: number; time: string
  occurrenceId: string | null; theme: string | null; status: string
  // `onCalendar` is the STANDING recurring series; `eventId` is the event THIS week's
  // gathering points at. A household can have one without the other.
  onCalendar: boolean
  eventId: string | null; eventTitle: string | null; eventWhen: string | null
  members: { id: string; name: string; avatarEmoji: string | null; colorHex: string | null }[]
  parts: BoardPart[]
}

const board = async (weekStart?: string) =>
  json(await call('GET', `/api/weekly-planning/familyNight${weekStart ? `?weekStart=${weekStart}` : ''}`, kevin)) as Board

const whoOn = (b: Board) => b.parts.map((p) => p.personName)

const plusDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

let W0: string // the week the server plans by default
let W1: string, W2: string, W3: string

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool

  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  householdId = json(setup).household.id
  const ownerId = json(setup).person.id
  const { query } = await import('../src/platform/db')
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [householdId, ownerId]
  )
  // The rotation is only legible with more than one person in it. /api/persons doesn't
  // create logins, so seed them directly (as chores.integration.test.ts does).
  await query(
    `insert into persons (household_id, name, member_type, sort_order, avatar_emoji, color_hex)
     values ($1,'Kelly','adult',1,'🦊','#E0653F'), ($1,'Wally','kid',2,'🐢','#25A368'), ($1,'Lottie','kid',3,'🦄','#7A5AF8')`,
    [householdId]
  )
  const { rows } = await query<{ id: string; name: string }>(
    `select id, name from persons where household_id = $1 and deleted_at is null order by sort_order, created_at`,
    [householdId]
  )
  people = rows

  await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: true, familyNight: true })
  // Wednesday: three days into a Sunday-start week, so "inside the planned week" is not
  // an accident of the day the suite runs.
  await call('PUT', '/api/family-night/config', kevin, { dayOfWeek: 3, time: '17:00' })

  const view = json(await call('GET', '/api/weekly-planning', kevin))
  W0 = view.defaultWeekStart
  W1 = plusDays(W0, 7)
  W2 = plusDays(W0, 14)
  W3 = plusDays(W0, 21)
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('planning · familyNight · gating', () => {
  it('403s while the weeklyPlanning module is off', async () => {
    await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: false })
    expect((await call('GET', '/api/weekly-planning/familyNight', kevin)).statusCode).toBe(403)
    await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: true })
  })

  it('403s when familyNight — the module this step reads — is off', async () => {
    // The catalog's `requiresModule: 'familyNight'` hides the step; it does not guard
    // the endpoint, so the route has to assert the module itself.
    await call('PATCH', '/api/household/modules', kevin, { familyNight: false })
    expect((await call('GET', '/api/weekly-planning/familyNight', kevin)).statusCode).toBe(403)
    await call('PATCH', '/api/household/modules', kevin, { familyNight: true })
    expect((await call('GET', '/api/weekly-planning/familyNight', kevin)).statusCode).toBe(200)
  })
})

describe('planning · familyNight · the read', () => {
  it('puts the gathering inside the week being planned, not the module\'s "next one"', async () => {
    const b = await board(W1)
    expect(b.weekStart).toBe(W1)
    expect(b.date).toBe(plusDays(W1, 3)) // Wednesday of THAT week
    expect(b.dayOfWeek).toBe(3)
    expect(b.time).toBe('17:00')
  })

  it('snaps a mid-week ?weekStart= through the shell rather than keying off the day named', async () => {
    const b = await board(plusDays(W1, 4)) // "the Thursday of the trip"
    expect(b.weekStart).toBe(W1)
  })

  it('lands on the week start itself when family night IS the household\'s first day', async () => {
    await call('PUT', '/api/family-night/config', kevin, { dayOfWeek: 0 })
    const b = await board(W1)
    expect(b.date).toBe(W1)
    await call('PUT', '/api/family-night/config', kevin, { dayOfWeek: 3 })
  })

  it('offers every part on rotation, with nothing pinned and no occurrence yet', async () => {
    const b = await board(W0)
    expect(b.occurrenceId).toBeNull()
    expect(b.theme).toBeNull()
    expect(b.status).toBe('planned')
    expect(b.parts.map((p) => p.label)).toEqual(['Activity', 'Treat', 'Check-in'])
    expect(b.parts.every((p) => p.pinned)).toBe(false)
    expect(whoOn(b)).toEqual(['Kevin', 'Kelly', 'Wally'])
    expect(b.members.map((m) => m.name)).toEqual(['Kevin', 'Kelly', 'Wally', 'Lottie'])
    expect(b.members[3].avatarEmoji).toBe('🦄')
    expect(b.members[3].colorHex).toBe('#7A5AF8')
  })

  it('leaves a non-rotating part on nobody rather than auto-assigning it', async () => {
    await call('PUT', '/api/family-night/config', kevin, {
      parts: [
        { id: 'activity', label: 'Activity', emoji: '🎲', rotates: true },
        { id: 'treat', label: 'Treat', emoji: '🍪', rotates: true },
        { id: 'checkin', label: 'Check-in', emoji: '💬', rotates: false },
      ],
    })
    const b = await board(W0)
    expect(b.parts[2].rotates).toBe(false)
    expect(b.parts[2].personId).toBeNull()
    expect(b.parts[2].pinned).toBe(false) // "nobody yet", not "pinned to nobody"
    expect(whoOn(b).slice(0, 2)).toEqual(['Kevin', 'Kelly'])
    await call('PUT', '/api/family-night/config', kevin, {
      parts: [
        { id: 'activity', label: 'Activity', emoji: '🎲', rotates: true },
        { id: 'treat', label: 'Treat', emoji: '🍪', rotates: true },
        { id: 'checkin', label: 'Check-in', emoji: '💬', rotates: true },
      ],
    })
  })
})

describe('planning · familyNight · pinning is for this week only', () => {
  it('pins a face on the occurrence, leaves the household config alone, and shifts next week', async () => {
    const before = await board(W1)
    expect(whoOn(before)).toEqual(['Kevin', 'Kelly', 'Wally'])

    const lottie = people.find((p) => p.name === 'Lottie')!
    const w0 = await board(W0)
    expect((await call('POST', '/api/family-night/occurrence', kevin, {
      date: w0.date,
      assignments: [{ partId: 'activity', personId: lottie.id }],
    })).statusCode).toBe(200)

    const after = await board(W0)
    expect(after.occurrenceId).not.toBeNull()
    expect(after.parts[0]).toMatchObject({ partId: 'activity', personId: lottie.id, personName: 'Lottie', pinned: true })
    expect(after.parts.slice(1).map((p) => p.pinned)).toEqual([false, false])
    expect(whoOn(after).slice(1)).toEqual(['Kelly', 'Wally']) // rotation untouched around it

    const next = await board(W1)
    expect(next.parts[0].pinned).toBe(false)
    // The pin materialized the occurrence, and the occurrence count is the rotation's
    // clock, so every part has moved on one.
    expect(whoOn(next)).toEqual(['Kelly', 'Wally', 'Lottie'])
  })

  it('never writes a pin into households.settings.familyNight', async () => {
    const { config } = json(await call('GET', '/api/family-night/config', kevin))
    expect(config.parts.map((p: { id: string }) => p.id)).toEqual(['activity', 'treat', 'checkin'])
    expect(JSON.stringify(config)).not.toContain(people.find((p) => p.name === 'Lottie')!.id)
    expect(config.rotationOrder).toBeNull()
  })

  it('takes a pin back off — one call, both directions', async () => {
    const w0 = await board(W0)
    await call('POST', '/api/family-night/occurrence', kevin, {
      date: w0.date,
      assignments: [{ partId: 'activity', personId: null }],
    })
    const b = await board(W0)
    // Cleared, not un-pinned: the row still exists, so the part reads "nobody yet"
    // rather than silently snapping back to the rotation's guess.
    expect(b.parts[0].personId).toBeNull()
    expect(b.parts[0].pinned).toBe(true)

    const lottie = people.find((p) => p.name === 'Lottie')!
    await call('POST', '/api/family-night/occurrence', kevin, {
      date: w0.date,
      assignments: [{ partId: 'activity', personId: lottie.id }],
    })
    expect((await board(W0)).parts[0].personName).toBe('Lottie')
  })
})

describe('planning · familyNight · the theme line', () => {
  it('keeps a free-text theme on the occurrence and can blank it again', async () => {
    const w0 = await board(W0)
    await call('POST', '/api/family-night/occurrence', kevin, { date: w0.date, theme: 'Pizza and the new Lego set' })
    expect((await board(W0)).theme).toBe('Pizza and the new Lego set')

    // upsertOccurrence coalesces a null theme to the stored one ("leave it alone"), so
    // clearing has to send an empty string. The board normalizes it back to null.
    await call('POST', '/api/family-night/occurrence', kevin, { date: w0.date, theme: '' })
    expect((await board(W0)).theme).toBeNull()

    await call('POST', '/api/family-night/occurrence', kevin, { date: w0.date, theme: 'Pizza and the new Lego set' })
  })
})

describe('planning · familyNight · calling the week off', () => {
  it('marks the occurrence skipped without touching the recurring calendar event', async () => {
    // Put Family Night on the calendar first — otherwise "left the event alone" is
    // vacuously true and proves nothing.
    const scheduled = await call('POST', '/api/family-night/schedule', kevin)
    expect(scheduled.statusCode).toBe(200)
    const eventId = json(scheduled).eventId

    const w0 = await board(W0)
    expect(w0.onCalendar).toBe(true)
    await call('POST', '/api/family-night/occurrence', kevin, { date: w0.date, status: 'skipped' })

    const b = await board(W0)
    expect(b.status).toBe('skipped')
    expect(b.onCalendar).toBe(true)
    const { config } = json(await call('GET', '/api/family-night/config', kevin))
    expect(config.eventId).toBe(eventId)
    const event = await call('GET', `/api/events/${eventId}`, kevin)
    expect(event.statusCode).toBe(200)
    expect(json(event).event.rrule).toMatch(/FREQ=WEEKLY/)
  })

  it('undoes a skip without losing the pin or the theme', async () => {
    const w0 = await board(W0)
    await call('POST', '/api/family-night/occurrence', kevin, { date: w0.date, status: 'planned' })
    const b = await board(W0)
    expect(b.status).toBe('planned')
    expect(b.parts[0].personName).toBe('Lottie')
    expect(b.theme).toBe('Pizza and the new Lego set')
  })

  // A skipped week TAKES ITS TURN — settled as a product call against the design doc's
  // "without advancing the rotation", because otherwise the same person is up again every
  // week the family skips. `rotationIndex()` counts every occurrence regardless of status.
  it('a skipped week still takes its turn — the intended rule, not a gap', async () => {
    // The SPECIFIC shift, not "something changed": five earlier describes have written
    // config and occurrences, so a vague assertion would pass on any of them.
    expect(whoOn(await board(W3))).toEqual(['Kelly', 'Wally', 'Lottie']) // one occurrence behind it
    const w2 = await board(W2)
    await call('POST', '/api/family-night/occurrence', kevin, { date: w2.date, status: 'skipped' })
    expect(whoOn(await board(W3))).toEqual(['Wally', 'Lottie', 'Kevin'])
  })
})

describe('planning · familyNight · a part can say what it actually is', () => {
  // `occurrences.notes` is one note for the whole gathering, so three parts sharing it
  // gives three answers in one field with no way to render each beside its person —
  // hence `assignments.detail`.
  it('keeps a detail per part, beside the person, and can blank one without blanking the others', async () => {
    const w0 = await board(W0)
    const kelly = people.find((p) => p.name === 'Kelly')!
    await call('POST', '/api/family-night/occurrence', kevin, {
      date: w0.date,
      assignments: [
        { partId: 'activity', personId: kelly.id, detail: 'Charades, kids vs parents' },
        { partId: 'treat', detail: 'The good ice cream' },
      ],
    })

    const b = await board(W0)
    const byId = Object.fromEntries(b.parts.map((x) => [x.partId, x])) as Record<string, BoardPart>
    expect(byId.activity).toMatchObject({ personName: 'Kelly', detail: 'Charades, kids vs parents' })
    // A detail with NO person: "the treat is the good ice cream, whoever's turn it is."
    // The rotation still names somebody, and the part is not pinned by a detail alone.
    expect(byId.treat.detail).toBe('The good ice cream')
    expect(byId.checkin.detail).toBeNull()

    // Blanking one leaves the other alone (the same empty-string-clears rule the theme
    // line uses, since a null means "leave it").
    await call('POST', '/api/family-night/occurrence', kevin, {
      date: w0.date,
      assignments: [{ partId: 'treat', detail: '' }],
    })
    const after = await board(W0)
    const afterById = Object.fromEntries(after.parts.map((x) => [x.partId, x])) as Record<string, BoardPart>
    expect(afterById.treat.detail).toBeNull()
    expect(afterById.activity.detail).toBe('Charades, kids vs parents')
  })

  it('does not treat a detail as a pin', async () => {
    const w0 = await board(W0)
    await call('POST', '/api/family-night/occurrence', kevin, {
      date: w0.date,
      assignments: [{ partId: 'checkin', detail: 'How was school, actually' }],
    })
    const b = await board(W0)
    const checkin = b.parts.find((x) => x.partId === 'checkin')!
    expect(checkin.detail).toBe('How was school, actually')
    expect(checkin.pinned).toBe(false)
    expect(checkin.personName).toBeTruthy()
  })
})

describe('planning · familyNight · this week on the calendar', () => {
  // A per-week event link, which `settings.familyNight.eventId` cannot answer: one field
  // for all weeks, and `scheduleEvent()` always creates a fresh series. There is no new
  // event-CREATION path — an event is made through the app's own endpoint, adopted by id.
  it('adopts an event that is already on the calendar for this week only', async () => {
    const w0 = await board(W0)
    const made = await call('POST', '/api/events', kevin, {
      title: '🍿 Movie night',
      startsAt: `${w0.date}T19:00:00`,
    })
    expect(made.statusCode).toBe(201)
    const eventId = json(made).event.id

    expect((await call('POST', '/api/family-night/occurrence', kevin, {
      date: w0.date,
      eventId,
    })).statusCode).toBe(200)

    const b = await board(W0)
    expect(b.eventId).toBe(eventId)
    expect(b.eventTitle).toBe('🍿 Movie night')

    expect((await board(W1)).eventId).toBeNull()
    const { config } = json(await call('GET', '/api/family-night/config', kevin))
    expect(config.eventId).not.toBe(eventId)
  })

  it('creates a one-off event for this week and links it in one call', async () => {
    // Server-side deliberately: the web writes events LOCALLY first (PowerSync uploads
    // afterwards), so a create-then-adopt round trip from the client would hand back an id
    // that does not exist server-side yet and 404 on an unreproducible race.
    const w1 = await board(W1)
    expect(w1.eventId).toBeNull()
    await call('POST', '/api/family-night/occurrence', kevin, { date: w1.date, theme: 'Board games' })

    const made = await call('POST', '/api/family-night/occurrence', kevin, { date: w1.date, createEvent: true })
    expect(made.statusCode).toBe(200)

    const b = await board(W1)
    expect(b.eventId).toBeTruthy()
    expect(b.eventTitle).toContain('Board games')
    expect((await call('GET', `/api/events/${b.eventId}`, kevin)).statusCode).toBe(200)
    expect(b.eventWhen).toBeTruthy()

    await call('POST', '/api/family-night/occurrence', kevin, { date: w1.date, createEvent: true })
    expect((await board(W1)).eventId).toBe(b.eventId)
  })

  it('unlinks the week without deleting the event', async () => {
    const w0 = await board(W0)
    const eventId = (await board(W0)).eventId!
    expect(eventId).toBeTruthy()

    await call('POST', '/api/family-night/occurrence', kevin, { date: w0.date, eventId: null })
    expect((await board(W0)).eventId).toBeNull()
    expect((await call('GET', `/api/events/${eventId}`, kevin)).statusCode).toBe(200)
  })
})
