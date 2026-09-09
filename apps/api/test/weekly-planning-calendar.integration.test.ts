// Weekly Planning · step 2 · Calendar — against a real Postgres (Testcontainers).
//
// The step adds no endpoint of its own, so this is RETROFITTED coverage of an existing
// read (the red-green is in `planning/steps/CalendarStep.test.tsx`). It pins the exact
// weekStart…weekStart+6 window, that an event keeps the hour and length it was created
// with, the owner colour, and that the step's answer round-trips as a COUNT.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let ownerId: string

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

// Pure date arithmetic on a YYYY-MM-DD — UTC on purpose; nothing here is rendered.
const addDays = (iso: string, n: number): string =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10)

// The household is America/Chicago; spelling the offset out keeps a fixture on the day it
// says it is on however the test machine is set.
const at = (day: string, time: string) => `${day}T${time}:00-05:00`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const titles = (events: any[]) => events.map((e: { title: string }) => e.title)

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
  const householdId = json(setup).household.id
  ownerId = json(setup).person.id
  const { query } = await import('../src/platform/db')
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [householdId, ownerId]
  )
  // Weekly Planning is off by default; step 2 lives behind it.
  await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: true })
  // The columns are painted by owner colour, so the owner needs one.
  await call('PATCH', `/api/persons/${ownerId}`, kevin, { colorHex: '#2F7FED' })
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('weekly planning · step 2 · calendar', () => {
  let weekStart: string

  it('is a step of the session, and needs no module of its own', async () => {
    const view = json(await call('GET', '/api/weekly-planning', kevin))
    const step = view.steps.find((s: { key: string }) => s.key === 'calendar')
    expect(step).toMatchObject({ number: 2, title: 'Calendar', act: 'Frame the week', available: true })
    expect(step.requiresModule).toBeUndefined()
    // The week the step frames is the SERVER's, and it is a real week start.
    weekStart = view.weekStart
    expect(weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('shows the planned week — and only it — from the first hour of day 1 to the last of day 7', async () => {
    const last = addDays(weekStart, 6)

    const made = [
      { title: 'First thing Monday', startsAt: at(weekStart, '00:15') },
      { title: 'Late on the last night', startsAt: at(last, '23:30') },
      { title: 'Last week', startsAt: at(addDays(weekStart, -1), '12:00') },
      { title: 'Next week', startsAt: at(addDays(last, 1), '12:00') },
    ]
    for (const e of made) {
      const res = await call('POST', '/api/events', kevin, { ...e, participantIds: [ownerId] })
      expect(res.statusCode).toBe(201)
    }

    const week = json(await call('GET', `/api/events?from=${weekStart}&to=${last}`, kevin))
    expect(titles(week.events)).toContain('First thing Monday')
    expect(titles(week.events)).toContain('Late on the last night')
    // The neighbouring weeks are not this week — the step must not paint them.
    expect(titles(week.events)).not.toContain('Last week')
    expect(titles(week.events)).not.toContain('Next week')
  })

  it('paints an added event in its owner’s colour, which is what the columns read by', async () => {
    const created = json(await call('POST', '/api/events', kevin, {
      title: 'Soccer practice',
      startsAt: at(addDays(weekStart, 3), '17:00'),
      endsAt: at(addDays(weekStart, 3), '18:00'),
      allDay: false,
      participantIds: [ownerId],
    })).event
    // The owner is DERIVED from the participants. The create response carries the owner
    // id but not their colour (it doesn't join persons) — that arrives on the week read.
    expect(created).toMatchObject({ personId: ownerId })

    const week = json(await call('GET', `/api/events?from=${weekStart}&to=${addDays(weekStart, 6)}`, kevin))
    const onWeek = week.events.find((e: { title: string }) => e.title === 'Soccer practice')
    expect(onWeek).toBeTruthy()
    expect(onWeek).toMatchObject({ personId: ownerId, personName: 'Kevin', personColor: '#2F7FED' })
    expect(onWeek.startsAt.slice(0, 10) >= addDays(weekStart, 3)).toBe(true)
  })

  it('keeps the hour and the length an addition was given — not a default one', async () => {
    // Time AND duration both have to survive the round trip; 8:30 for two hours is
    // deliberately neither the default start nor a one-hour end.
    const day = addDays(weekStart, 2)
    const created = json(await call('POST', '/api/events', kevin, {
      title: 'Swim lesson',
      startsAt: at(day, '08:30'),
      endsAt: at(day, '10:30'),
      allDay: false,
      participantIds: [ownerId],
    })).event
    expect(created.allDay).toBe(false)

    const week = json(await call('GET', `/api/events?from=${weekStart}&to=${addDays(weekStart, 6)}`, kevin))
    const onWeek = week.events.find((e: { title: string }) => e.title === 'Swim lesson')
    expect(onWeek).toBeTruthy()
    // Compared as instants, not strings: the row comes back in UTC, and the household
    // is America/Chicago (CDT, -05:00) — so 08:30 local is 13:30Z on the same date.
    expect(new Date(onWeek.startsAt).toISOString()).toBe(new Date(at(day, '08:30')).toISOString())
    expect(new Date(onWeek.endsAt).toISOString()).toBe(new Date(at(day, '10:30')).toISOString())
    expect(onWeek.startsAt.slice(0, 10)).toBe(day)
  })

  it('puts one addition on more than one person', async () => {
    // The week read has to carry every participant back, not just the derived owner.
    const nora = json(await call('POST', '/api/persons', kevin, { name: 'Nora', memberType: 'adult', colorHex: '#25A368' })).person
    const res = await call('POST', '/api/events', kevin, {
      title: 'Parent-teacher night',
      startsAt: at(addDays(weekStart, 4), '19:00'),
      allDay: false,
      participantIds: [ownerId, nora.id],
    })
    expect(res.statusCode).toBe(201)

    const week = json(await call('GET', `/api/events?from=${weekStart}&to=${addDays(weekStart, 6)}`, kevin))
    const onWeek = week.events.find((e: { title: string }) => e.title === 'Parent-teacher night')
    expect(onWeek).toBeTruthy()
    expect(onWeek.participants.map((p: { id: string }) => p.id).sort()).toEqual([ownerId, nora.id].sort())
  })

  it('files an all-day addition at midday so it cannot slide into the day next door', async () => {
    const day = addDays(weekStart, 5)
    const created = json(await call('POST', '/api/events', kevin, {
      title: 'Grandma visits',
      startsAt: at(day, '12:00'),
      endsAt: null,
      allDay: true,
      participantIds: [],
    })).event
    expect(created.allDay).toBe(true)

    const week = json(await call('GET', `/api/events?from=${weekStart}&to=${addDays(weekStart, 6)}`, kevin))
    expect(titles(week.events)).toContain('Grandma visits')
  })

  it('refuses an addition with no line of text, so an empty day never gets a blank event', async () => {
    const res = await call('POST', '/api/events', kevin, { title: '   ', startsAt: at(weekStart, '09:00') })
    expect(res.statusCode).toBe(400)
  })

  it('records the step’s answer as a count, not a copy of the calendar', async () => {
    const session = json(await call('POST', '/api/weekly-planning/session', kevin)).session
    const res = await call('POST', `/api/weekly-planning/session/${session.id}/step`, kevin, {
      stepKey: 'calendar', status: 'done', data: { added: 2 },
    })
    expect(res.statusCode).toBe(200)

    const view = json(await call('GET', '/api/weekly-planning', kevin))
    const step = view.steps.find((s: { key: string }) => s.key === 'calendar')
    expect(step.status).toBe('done')
    expect(step.data).toEqual({ added: 2 })
    expect(step.decidedAt).toBeTruthy()
  })

  it('is gated with the rest of the module — the step disappears when Weekly Planning is off', async () => {
    await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: false })
    expect((await call('GET', '/api/weekly-planning', kevin)).statusCode).toBe(403)
    // …but the calendar itself is not the session's to gate: the week is still readable.
    expect((await call('GET', `/api/events?from=${weekStart}&to=${addDays(weekStart, 6)}`, kevin)).statusCode).toBe(200)
    await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: true })
  })
})
