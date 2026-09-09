// Weekly Planning · step 3 · Horizon scan — against a real Postgres (Testcontainers).
//
// Most of what the step renders comes off endpoints tested elsewhere. What is new here:
//   · `GET /api/weekly-planning/horizon` — which tags a note may carry (only steps this
//     household runs) and what this session has parked, since `setDecisionData` is not storage;
//   · THE CENTRAL CLAIM: a parked note is NOT an event. Parking writes to
//     planning_parked_items and nothing at all to the calendar;
//   · the tag is the DESTINATION step, the same shape step 1 writes when it routes.
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
let sessionId: string

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

const setModules = (mods: Record<string, boolean>) => call('PATCH', '/api/household/modules', kevin, mods)

const horizon = (session?: string) =>
  call('GET', `/api/weekly-planning/horizon${session ? `?sessionId=${session}` : ''}`, kevin)

const park = (body: Record<string, unknown>) =>
  call('POST', '/api/weekly-planning/loose-ends/parked', kevin, body)

// Pure date arithmetic on a YYYY-MM-DD — UTC on purpose, because nothing here is
// rendered.
const addDays = (iso: string, n: number): string =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10)

// The household is America/Chicago; spelling the offset out keeps a fixture on the day
// it says it is on however the test machine is set.
const at = (day: string, time: string) => `${day}T${time}:00-05:00`

interface Tag { stepKey: string; label: string; hint: string; primary?: boolean }
interface Note { id: string; note: string; stepKey: string | null; stepLabel: string | null; createdAt: string }

const keys = (tags: Tag[]) => tags.map((t) => t.stepKey)
const notes = (list: Note[]) => list.map((n) => n.note)

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
  // Weekly Planning is off by default; step 3 lives behind it. The tag list is filtered
  // by the OTHER modules, so they start on and individual tests turn one off.
  await setModules({ weeklyPlanning: true, chores: true, meals: true })
  await call('PATCH', `/api/persons/${ownerId}`, kevin, { colorHex: '#2F7FED' })
  sessionId = json(await call('POST', '/api/weekly-planning/session', kevin)).session.id
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('weekly planning · step 3 · horizon', () => {
  it('is a step of the session, and needs no module of its own', async () => {
    const view = json(await call('GET', '/api/weekly-planning', kevin))
    const step = view.steps.find((s: { key: string }) => s.key === 'horizon')
    // The month is not an optional module — every household has a calendar — so unlike
    // meals/goals/chores this step is never skipped over for want of one.
    expect(step).toMatchObject({ number: 3, act: 'Frame the week', available: true })
    expect(step.requiresModule).toBeUndefined()
  })

  it('is behind the weeklyPlanning toggle like the rest of the module', async () => {
    // Turn it back on BEFORE asserting: a failed expect throws, and a toggle left off
    // here would fail every test after this one for the wrong reason.
    await setModules({ weeklyPlanning: false })
    const off = await horizon(sessionId)
    await setModules({ weeklyPlanning: true })
    expect(off.statusCode).toBe(403)
    expect((await horizon(sessionId)).statusCode).toBe(200)
  })
})

describe('horizon · the tags a note can carry', () => {
  it('offers only the steps still AHEAD of the bar, in the order they will come up', async () => {
    const view = json(await horizon(sessionId))
    // A tag names the step that will LOOK at this note, so a step the session has
    // already walked past cannot be one: tagging Calendar from the Horizon scan
    // addresses the note to step 2 while you are standing on step 3, and it would only
    // ever resurface in a LATER session.
    expect(keys(view.tags)).toEqual(['connection', 'goals', 'meals', 'tasks', 'kids'])
    expect(view.tags.every((t: Tag) => t.label && t.hint)).toBe(true)
    // The label is the catalog's own title for that step, so the bar and the agenda
    // sheet can never call the same step two different things.
    expect(view.tags.find((t: Tag) => t.stepKey === 'tasks')!.label).toBe('Tasks')
    // Exactly one primary — the one the bar opens on. Tasks, for the same reason step
    // 1's `DESTINATIONS.parked` marks it primary.
    expect(view.tags.filter((t: Tag) => t.primary).map((t: Tag) => t.stepKey)).toEqual(['tasks'])
  })

  it('never offers a step at or before the bar, whatever is switched on', async () => {
    // The three that are structurally impossible as destinations: the two steps behind
    // this one, and this one. `recap` is excluded too — it REPORTS and settles nothing.
    const ks = keys(json(await horizon(sessionId)).tags)
    for (const behind of ['looseEnds', 'calendar', 'horizon', 'recap']) {
      expect(ks).not.toContain(behind)
    }
  })

  it('picks the destinations up from the step order, so a switched-on module joins them', async () => {
    // Family night is off by default; turning it on puts it in the list WHERE IT FALLS
    // in the session, not at the end. The list is derived from the step catalog rather
    // than hand-kept.
    await setModules({ familyNight: true })
    expect(keys(json(await horizon(sessionId)).tags)).toEqual(['familyNight', 'connection', 'goals', 'meals', 'tasks', 'kids'])
    await setModules({ familyNight: false })
  })

  it('drops a tag whose step this household does not run', async () => {
    // A tag naming a step the session skips over addresses the note to nobody — the
    // same rule step 1 applies to its routing destinations.
    await setModules({ meals: false })
    expect(keys(json(await horizon(sessionId)).tags)).toEqual(['connection', 'goals', 'tasks', 'kids'])
    await setModules({ chores: false })
    const noTasks = json(await horizon(sessionId)).tags
    expect(keys(noTasks)).toEqual(['connection', 'goals', 'kids'])
    expect(noTasks.filter((t: Tag) => t.primary)).toEqual([])
    await setModules({ meals: true, chores: true })
    expect(keys(json(await horizon(sessionId)).tags)).toEqual(['connection', 'goals', 'meals', 'tasks', 'kids'])
  })
})

describe('horizon · parking a note', () => {
  it('parks with a destination tag, and reads back on the step with that step’s name', async () => {
    const res = await park({ note: 'Camping — we need to pack', stepKey: 'tasks', sessionId })
    expect(res.statusCode).toBe(200)

    const view = json(await horizon(sessionId))
    const parked: Note[] = view.parked
    const mine = parked.find((n) => n.note === 'Camping — we need to pack')!
    expect(mine).toBeTruthy()
    // 'tasks', not 'horizon': the tag names the step that will LOOK at the note, which
    // is the same thing step 1 writes when somebody routes a note there.
    expect(mine.stepKey).toBe('tasks')
    expect(mine.stepLabel).toBe('Tasks')
  })

  it('is NOT a calendar entry — the month is untouched', async () => {
    // The whole distinction the step draws: ＋ on a day writes an event, the bar does
    // not. Read a wide window so a note landing anywhere in the month would show up.
    const from = json(await call('GET', '/api/weekly-planning', kevin)).weekStart
    const window = `from=${addDays(from, -35)}&to=${addDays(from, 35)}`
    const before = json(await call('GET', `/api/events?${window}`, kevin)).events.length

    await park({ note: 'Two nights away — sort the sleeping bags', stepKey: 'tasks', sessionId })

    const after = json(await call('GET', `/api/events?${window}`, kevin)).events
    expect(after.length).toBe(before)
    expect(after.map((e: { title: string }) => e.title)).not.toContain('Two nights away — sort the sleeping bags')
  })

  it('accepts "No tag" — an untagged note is a whole answer', async () => {
    const res = await park({ note: 'Something is coming and we don’t know what', sessionId })
    expect(res.statusCode).toBe(200)
    const mine = (json(await horizon(sessionId)).parked as Note[]).find(
      (n) => n.note === 'Something is coming and we don’t know what'
    )!
    expect(mine.stepKey).toBeNull()
    expect(mine.stepLabel).toBeNull()
  })

  it('refuses a tag that is not a step', async () => {
    // Validated in the service against the server-owned catalog (there is deliberately
    // no check constraint), so a typo can't create a tag nothing will ever match.
    expect((await park({ note: 'x', stepKey: 'holidays', sessionId })).statusCode).toBe(400)
  })

  it('lists only what THIS session parked, oldest first', async () => {
    // `setDecisionData` is not storage: the list has to survive leaving the step and
    // coming back, and it must not swell with every note the household ever wrote.
    const other = json(
      await call('POST', '/api/weekly-planning/session', kevin, {
        weekStart: addDays(json(await call('GET', '/api/weekly-planning', kevin)).weekStart, 28),
      })
    ).session.id
    await park({ note: 'Parked in another session', stepKey: 'tasks', sessionId: other })
    await park({ note: 'Parked outside any session' })

    const mine = notes(json(await horizon(sessionId)).parked)
    expect(mine).not.toContain('Parked in another session')
    expect(mine).not.toContain('Parked outside any session')
    expect(mine.indexOf('Camping — we need to pack')).toBeLessThan(
      mine.indexOf('Two nights away — sort the sleeping bags')
    )

    // And the other session's own read sees only its own.
    expect(notes(json(await horizon(other)).parked)).toEqual(['Parked in another session'])
  })

  it('answers with an empty board when no session is named', async () => {
    const view = json(await horizon())
    expect(view.parked).toEqual([])
    expect(keys(view.tags)).toEqual(['connection', 'goals', 'meals', 'tasks', 'kids'])
  })

  it('drops a note off the board once step 1 settles it', async () => {
    const id = json(await park({ note: 'It was never really a thing', sessionId })).item.id
    expect(notes(json(await horizon(sessionId)).parked)).toContain('It was never really a thing')
    expect(
      (await call('POST', '/api/weekly-planning/loose-ends/resolve', kevin, { kind: 'parked', id, action: 'drop' })).statusCode
    ).toBe(200)
    expect(notes(json(await horizon(sessionId)).parked)).not.toContain('It was never really a thing')
  })

  it('the month it scans is the real calendar — events on it are the ordinary read', async () => {
    // Not a horizon endpoint: the grid is `GET /api/events` over the 42-cell window, so
    // an event added through the app's own modal is on the step the moment it exists.
    const weekStart = json(await call('GET', '/api/weekly-planning', kevin)).weekStart
    const day = addDays(weekStart, 13)
    expect(
      (await call('POST', '/api/events', kevin, { title: 'Scout campout', startsAt: at(day, '09:00'), participantIds: [ownerId] })).statusCode
    ).toBe(201)
    const events = json(await call('GET', `/api/events?from=${weekStart}&to=${addDays(weekStart, 27)}`, kevin)).events
    expect(events.map((e: { title: string }) => e.title)).toContain('Scout campout')
  })
})
