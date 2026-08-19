// Countdowns — merged read (standalone + flagged events + birthdays), CRUD, and the
// sleeps config, against a real Postgres (Testcontainers).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}

function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run(
    { httpMethod: method, path, headers, queryStringParameters: {}, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false },
    {}
  ) as Promise<{ statusCode: number; body: string }>
}

const kevin = mint('dev|kevin')

// A YYYY-MM-DD n days from "now" (UTC-ish; the test only asserts ordering/presence).
function inDays(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
}

// A birthday whose MM-DD lands n days from today (year far in the past so it's a
// valid persons.birthday). Used to place a birthday inside/outside the horizon.
function birthdayInDays(n: number): string {
  return `2010-${inDays(n).slice(5)}`
}

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
  const householdId = JSON.parse(setup.body).household.id
  const ownerId = JSON.parse(setup.body).person.id
  const { query } = await import('../src/platform/db')
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [householdId, ownerId]
  )
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('countdowns', () => {
  let standaloneId = ''

  it('starts empty', async () => {
    const res = await call('GET', '/api/countdowns', kevin)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.countdowns).toEqual([])
    expect(body.sleeps).toBe(false)
  })

  it('creates a standalone countdown and lists it with days left', async () => {
    const res = await call('POST', '/api/countdowns', kevin, { title: 'Hawaii trip', date: inDays(30), emoji: '🏝️' })
    expect(res.statusCode).toBe(201)
    standaloneId = JSON.parse(res.body).id

    const list = JSON.parse((await call('GET', '/api/countdowns', kevin)).body).countdowns
    const hawaii = list.find((c: { title: string }) => c.title === 'Hawaii trip')
    expect(hawaii).toBeTruthy()
    expect(hawaii.source).toBe('standalone')
    expect(hawaii.daysLeft).toBeGreaterThan(0)
    expect(hawaii.emoji).toBe('🏝️')
  })

  it('rejects a bad date', async () => {
    expect((await call('POST', '/api/countdowns', kevin, { title: 'x', date: 'soon' })).statusCode).toBe(400)
    expect((await call('POST', '/api/countdowns', kevin, { title: '', date: inDays(5) })).statusCode).toBe(400)
  })

  it('includes an event flagged as a countdown', async () => {
    const ev = await call('POST', '/api/events', kevin, { title: 'Concert', startsAt: `${inDays(10)}T19:00:00.000Z`, isCountdown: true })
    expect(ev.statusCode).toBe(201)
    const list = JSON.parse((await call('GET', '/api/countdowns', kevin)).body).countdowns
    const concert = list.find((c: { title: string }) => c.title === 'Concert')
    expect(concert).toBeTruthy()
    expect(concert.source).toBe('event')
  })

  it('does NOT include an event that is not flagged', async () => {
    await call('POST', '/api/events', kevin, { title: 'Dentist', startsAt: `${inDays(12)}T09:00:00.000Z` })
    const list = JSON.parse((await call('GET', '/api/countdowns', kevin)).body).countdowns
    expect(list.some((c: { title: string }) => c.title === 'Dentist')).toBe(false)
  })

  it("derives a member's next birthday", async () => {
    // Inside the horizon relative to "today" — a fixed date breaks once it rolls a year out.
    const birthday = birthdayInDays(30)
    await call('POST', '/api/persons', kevin, { name: 'Wally', memberType: 'kid', birthday })
    const list = JSON.parse((await call('GET', '/api/countdowns', kevin)).body).countdowns
    const bday = list.find((c: { source: string; title: string }) => c.source === 'birthday' && c.title === "Wally's birthday")
    expect(bday).toBeTruthy()
    expect(bday.date.endsWith(birthday.slice(4))).toBe(true)
    expect(bday.daysLeft).toBeGreaterThanOrEqual(0)
  })

  it('sorts soonest first', async () => {
    const list = JSON.parse((await call('GET', '/api/countdowns', kevin)).body).countdowns
    const days = list.map((c: { daysLeft: number }) => c.daysLeft)
    expect(days).toEqual([...days].sort((a, b) => a - b))
  })

  it('edits and deletes a standalone countdown', async () => {
    expect((await call('PATCH', `/api/countdowns/${standaloneId}`, kevin, { title: 'Maui trip' })).statusCode).toBe(200)
    let list = JSON.parse((await call('GET', '/api/countdowns', kevin)).body).countdowns
    expect(list.some((c: { title: string }) => c.title === 'Maui trip')).toBe(true)

    expect((await call('DELETE', `/api/countdowns/${standaloneId}`, kevin)).statusCode).toBe(204)
    list = JSON.parse((await call('GET', '/api/countdowns', kevin)).body).countdowns
    expect(list.some((c: { title: string }) => c.title === 'Maui trip')).toBe(false)
  })

  it('persists the sleeps display preference', async () => {
    expect((await call('PUT', '/api/countdowns/config', kevin, { sleeps: true })).statusCode).toBe(200)
    expect(JSON.parse((await call('GET', '/api/countdowns', kevin)).body).sleeps).toBe(true)
  })
})

// A birthday far off (nearly a year away) is noise on the countdown list. It should
// only surface once it's inside the horizon (~6 months by default), and a birthday
// that just passed shouldn't drag next year's occurrence onto the list either.
describe('countdowns — birthday horizon', () => {
  const person = (name: string, birthday: string) =>
    call('POST', '/api/persons', kevin, { name, memberType: 'kid', birthday })
  const listTitles = async () =>
    JSON.parse((await call('GET', '/api/countdowns', kevin)).body).countdowns.map((c: { title: string }) => c.title)

  it('excludes a birthday beyond the horizon', async () => {
    await person('Faraway', birthdayInDays(300)) // ~10 months out
    expect(await listTitles()).not.toContain("Faraway's birthday")
  })

  it('includes a birthday within the horizon', async () => {
    await person('Soon', birthdayInDays(30))
    expect(await listTitles()).toContain("Soon's birthday")
  })

  it('hides a just-passed birthday whose next occurrence is far off', async () => {
    await person('Recent', birthdayInDays(-3)) // 3 days ago → next is ~362 days away
    expect(await listTitles()).not.toContain("Recent's birthday")
  })

  it('config can widen birthdayHorizonDays to surface a far-off birthday', async () => {
    // Faraway (~300 days) is hidden by the default ~183-day horizon…
    expect(await listTitles()).not.toContain("Faraway's birthday")
    // …widen the horizon and it appears; sleeps is unchanged.
    const res = await call('PUT', '/api/countdowns/config', kevin, { birthdayHorizonDays: 365 })
    expect(res.statusCode).toBe(200)
    expect(await listTitles()).toContain("Faraway's birthday")
  })

  it('narrowing birthdayHorizonDays hides an otherwise-visible birthday', async () => {
    // "Soon" (~30 days out) is visible under a generous horizon…
    expect(await listTitles()).toContain("Soon's birthday")
    // …but a 15-day horizon drops it (and keeps Faraway hidden).
    expect((await call('PUT', '/api/countdowns/config', kevin, { birthdayHorizonDays: 15 })).statusCode).toBe(200)
    const titles = await listTitles()
    expect(titles).not.toContain("Soon's birthday")
    expect(titles).not.toContain("Faraway's birthday")
  })

  it('config still accepts sleeps and reads back both fields', async () => {
    expect((await call('PUT', '/api/countdowns/config', kevin, { sleeps: false })).statusCode).toBe(200)
    const body = JSON.parse((await call('GET', '/api/countdowns', kevin)).body)
    expect(body.sleeps).toBe(false)
    expect(typeof body.birthdayHorizonDays).toBe('number')
  })
})

// Rhythms as a fourth countdown source. Only the COMPLETION shape belongs here: a
// scheduling-shape rhythm IS an event, so the existing is_countdown flag already covers
// it and adding one here would list the same thing twice. See "Countdown reuse" in
// docs/product/rhythms-plan.md.
describe('countdowns — rhythms source', () => {
  const listCountdowns = async () =>
    JSON.parse((await call('GET', '/api/countdowns', kevin)).body).countdowns as Array<{
      id: string
      title: string
      date: string
      daysLeft: number
      source: string
      emoji: string | null
      personId: string | null
    }>

  const householdId = async () => {
    const { query } = await import('../src/platform/db')
    return (await query<{ id: string }>('select id from households limit 1')).rows[0].id
  }

  let filterId = ''

  it('ignores rhythms while the module is off', async () => {
    // Inserted directly: /api/rhythms 403s while the module is off, and the only thing
    // under test here is whether the countdown list opts in.
    const { query } = await import('../src/platform/db')
    const { rows } = await query<{ id: string }>(
      `insert into rhythms (household_id, title, emoji, satisfied_by, every, next_due_at)
         values ($1, 'Change the air filter', '🌬️', 'completion', '3 months', $2::timestamptz)
       returning id`,
      [await householdId(), `${inDays(45)}T12:00:00.000Z`]
    )
    filterId = rows[0].id
    expect((await listCountdowns()).some((c) => c.title === 'Change the air filter')).toBe(false)
  })

  it('counts down to a completion rhythm once the module is on', async () => {
    expect((await call('PATCH', '/api/household/modules', kevin, { rhythms: true })).statusCode).toBe(200)
    const filter = (await listCountdowns()).find((c) => c.title === 'Change the air filter')
    expect(filter).toBeTruthy()
    expect(filter!.source).toBe('rhythm')
    expect(filter!.id).toBe(`rhythm:${filterId}`)
    expect(filter!.emoji).toBe('🌬️')
    expect(filter!.date).toBe(inDays(45))
    expect(filter!.daysLeft).toBeGreaterThan(0)
  })

  it('leaves a scheduling rhythm out — it is already an event', async () => {
    const res = await call('POST', '/api/rhythms', kevin, {
      title: 'Temple visit',
      satisfiedBy: 'scheduling',
      every: '3 months',
      startsOn: inDays(0),
    })
    expect(res.statusCode).toBe(201)
    expect((await listCountdowns()).some((c) => c.title === 'Temple visit')).toBe(false)
  })

  it('drops a rhythm that is overdue, paused, or deleted', async () => {
    const { query } = await import('../src/platform/db')
    await query(
      `insert into rhythms (household_id, title, satisfied_by, every, next_due_at)
         values ($1,'Overdue oil change','completion','6 months',$2::timestamptz),
                ($1,'Paused toothbrush head','completion','3 months',$3::timestamptz),
                ($1,'Retired smoke detector','completion','1 year',$3::timestamptz)`,
      [await householdId(), `${inDays(-2)}T12:00:00.000Z`, `${inDays(20)}T12:00:00.000Z`]
    )
    await query(`update rhythms set is_active = false where title = 'Paused toothbrush head'`)
    await query(`update rhythms set deleted_at = now() where title = 'Retired smoke detector'`)
    const titles = (await listCountdowns()).map((c) => c.title)
    expect(titles).not.toContain('Overdue oil change')
    expect(titles).not.toContain('Paused toothbrush head')
    expect(titles).not.toContain('Retired smoke detector')
  })

  it('still sorts the merged list soonest first', async () => {
    const days = (await listCountdowns()).map((c) => c.daysLeft)
    expect(days).toEqual([...days].sort((a, b) => a - b))
  })
})
