// Events' capture target — Tier 2 mutate verbs on calendar events (reschedule +
// delete), end to end through the dispatcher: POST /api/capture/resolve ranks
// upcoming events, POST /api/capture/commit applies to ONE occurrence (never the
// whole series). Real PG (Testcontainers) + app.run, mirroring the sibling
// capture-mutate harness. Household timezone is UTC so wall-clock asserts are exact.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'
let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

interface RunResult { statusCode: number; body: string }
function call(method: string, path: string, token?: string, body?: unknown, qs: Record<string, string> = {}) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  return app.run({ httpMethod: method, path, headers, queryStringParameters: qs, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false }, {}) as Promise<RunResult>
}

let kevin = ''

// All test events sit a few days out so they land inside the resolver's upcoming
// window regardless of when the suite runs.
const DAY = 86_400_000
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10)
}
function atUtc(daysFromNow: number, hour: number, minute = 0): Date {
  const d = new Date(Date.now() + daysFromNow * DAY)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute, 0))
}

async function createEvent(body: Record<string, unknown>): Promise<string> {
  const res = await call('POST', '/api/events', kevin, body)
  expect(res.statusCode).toBe(201)
  return JSON.parse(res.body).event.id as string
}

interface OccOut { id: string; seriesId: string; occurrenceStart: string | null; startsAt: string; title: string }
async function range(from: Date, to: Date, token = kevin): Promise<OccOut[]> {
  const res = await call('GET', '/api/events', token, undefined, { from: ymd(from), to: ymd(to) })
  expect(res.statusCode).toBe(200)
  return JSON.parse(res.body).events as OccOut[]
}

function resolve(body: Record<string, unknown>) {
  return call('POST', '/api/capture/resolve', kevin, body)
}
function commit(body: Record<string, unknown>) {
  return call('POST', '/api/capture/commit', kevin, body)
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  process.env.LOCAL_JWT_SECRET = SECRET
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Cap', timezone: 'UTC' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  kevin = JSON.parse(setup.body).accessToken
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('resolve — event candidates', () => {
  it('ranks upcoming events by description and excludes past ones', async () => {
    await createEvent({ title: 'Soccer practice', startsAt: atUtc(5, 16).toISOString() })
    await createEvent({ title: 'Dentist appointment', startsAt: atUtc(3, 9).toISOString() })
    // A past event with the same word must not surface.
    await createEvent({ title: 'Soccer banquet', startsAt: atUtc(-30, 18).toISOString() })

    const res = await resolve({ targetKind: 'event', verb: 'reschedule', target: { description: 'soccer' }, args: {} })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.unsupported).toBeUndefined()
    const titles = body.candidates.map((c: { title: string }) => c.title)
    expect(titles).toContain('Soccer practice')
    expect(titles).not.toContain('Soccer banquet')
    expect(titles).not.toContain('Dentist appointment')
    const cand = body.candidates.find((c: { title: string }) => c.title === 'Soccer practice')
    expect(typeof cand.subtitle).toBe('string')
    expect(cand.subtitle.length).toBeGreaterThan(0)
    expect(cand.meta.seriesId).toBeDefined()
    expect(cand.meta.occurrenceStart).toBeNull() // single event
  })

  it('surfaces an in-progress multi-day event that started before today', async () => {
    // A camping trip already underway (began 2 days ago, ends in 2) — you should still
    // be able to "cancel the camping trip". rangeEvents filters on starts_at::date, so
    // the resolve window must open before it began (PR #83 review, direction a).
    await createEvent({ title: 'Camping trip', startsAt: atUtc(-2, 9).toISOString(), endsAt: atUtc(2, 17).toISOString() })
    const res = await resolve({ targetKind: 'event', verb: 'delete', target: { description: 'camping trip' }, args: {} })
    expect(res.statusCode).toBe(200)
    const titles = JSON.parse(res.body).candidates.map((c: { title: string }) => c.title)
    expect(titles).toContain('Camping trip')
  })

  it('does not surface an event that already ended earlier today', async () => {
    // Ended an hour ago. It must NOT resolve — otherwise, as the sole match, the bar
    // auto-selects it and the user reschedules an appointment already past (PR #83
    // review, direction b). The window is now-based, not date-based.
    const startedAt = new Date(Date.now() - 2 * 3_600_000)
    const endedAt = new Date(Date.now() - 3_600_000)
    await createEvent({ title: 'Morning standup', startsAt: startedAt.toISOString(), endsAt: endedAt.toISOString() })
    const res = await resolve({ targetKind: 'event', verb: 'reschedule', target: { description: 'morning standup' }, args: {} })
    expect(res.statusCode).toBe(200)
    const titles = JSON.parse(res.body).candidates.map((c: { title: string }) => c.title)
    expect(titles).not.toContain('Morning standup')
  })

  it('flags a verb events cannot apply (complete) as unsupported', async () => {
    const res = await resolve({ targetKind: 'event', verb: 'complete', target: { description: 'soccer' }, args: {} })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.candidates).toEqual([])
    expect(body.unsupported).toBe(true)
    expect(body.disabledReason).toMatch(/calendar/i)
  })
})

describe('commit — reschedule a single event', () => {
  it('moves date+time and preserves the duration', async () => {
    const start = atUtc(4, 10)
    const end = atUtc(4, 11) // 1h long
    const id = await createEvent({ title: 'Piano lesson', startsAt: start.toISOString(), endsAt: end.toISOString() })

    const newDay = ymd(atUtc(9, 0))
    const res = await commit({
      targetKind: 'event', verb: 'reschedule', targetId: id,
      args: { date: newDay, time: '15:30' }, meta: { seriesId: id, occurrenceStart: null },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.message).toMatch(/moved/i)

    const detail = await call('GET', `/api/events/${id}`, kevin)
    const ev = JSON.parse(detail.body).event
    expect(ev.startsAt).toBe(`${newDay}T15:30:00.000Z`)
    expect(new Date(ev.endsAt).getTime() - new Date(ev.startsAt).getTime()).toBe(3_600_000)
  })

  it('date-only keeps the original clock time; time-only keeps the original date', async () => {
    const id = await createEvent({ title: 'Vet visit', startsAt: atUtc(6, 14, 15).toISOString() })

    const newDay = ymd(atUtc(12, 0))
    let res = await commit({ targetKind: 'event', verb: 'reschedule', targetId: id, args: { date: newDay } })
    expect(res.statusCode).toBe(200)
    let ev = JSON.parse((await call('GET', `/api/events/${id}`, kevin)).body).event
    expect(ev.startsAt).toBe(`${newDay}T14:15:00.000Z`)

    res = await commit({ targetKind: 'event', verb: 'reschedule', targetId: id, args: { time: '08:05' } })
    expect(res.statusCode).toBe(200)
    ev = JSON.parse((await call('GET', `/api/events/${id}`, kevin)).body).event
    expect(ev.startsAt).toBe(`${newDay}T08:05:00.000Z`)
  })

  it('converts a single all-day event to a timed one when a clock time is given', async () => {
    // "move the fair to 4pm" on an all-day event must actually show 4pm — not silently
    // write the time while the row stays all-day and every surface ignores it (PR #83
    // review). A single event can clear all_day.
    const day = ymd(atUtc(5, 0))
    const id = await createEvent({ title: 'County fair', startsAt: `${day}T00:00:00.000Z`, allDay: true })
    const res = await commit({ targetKind: 'event', verb: 'reschedule', targetId: id, args: { time: '16:00' } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).message).toMatch(/4:00/) // labeled with a time, not "All day"
    const ev = JSON.parse((await call('GET', `/api/events/${id}`, kevin)).body).event
    expect(ev.allDay).toBe(false)
    expect(ev.startsAt).toBe(`${day}T16:00:00.000Z`)
  })

  it('refuses to give a RECURRING all-day occurrence a clock time (no per-occurrence all_day)', async () => {
    // event_overrides has no all_day column, so we can't clear it per-occurrence —
    // 400 honestly rather than silently swallow the time (PR #83 review).
    const day = ymd(atUtc(2, 0))
    await createEvent({ title: 'Trash day', startsAt: `${day}T00:00:00.000Z`, allDay: true, rrule: 'FREQ=WEEKLY' })
    const occs = (await range(atUtc(0, 0), atUtc(40, 0))).filter((e) => e.title === 'Trash day')
    expect(occs.length).toBeGreaterThanOrEqual(2)
    const target = occs[1]
    const res = await commit({
      targetKind: 'event', verb: 'reschedule', targetId: target.id,
      args: { time: '09:00' }, meta: { seriesId: target.seriesId, occurrenceStart: target.occurrenceStart },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toMatch(/all-day/i)
  })

  it('date-only reschedule of an all-day event keeps it all-day', async () => {
    // Only a TIME converts it. Moving an all-day event to another day stays all-day.
    const day = ymd(atUtc(3, 0))
    const id = await createEvent({ title: 'Yard sale', startsAt: `${day}T00:00:00.000Z`, allDay: true })
    const newDay = ymd(atUtc(9, 0))
    const res = await commit({ targetKind: 'event', verb: 'reschedule', targetId: id, args: { date: newDay } })
    expect(res.statusCode).toBe(200)
    const ev = JSON.parse((await call('GET', `/api/events/${id}`, kevin)).body).event
    expect(ev.allDay).toBe(true)
    expect(ev.startsAt).toBe(`${newDay}T00:00:00.000Z`)
  })

  it('400s with friendly copy when no date/time is given', async () => {
    const id = await createEvent({ title: 'Book club', startsAt: atUtc(5, 19).toISOString() })
    const res = await commit({ targetKind: 'event', verb: 'reschedule', targetId: id, args: {} })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).message).toMatch(/when/i)
  })

  it('400s on a garbage date or time instead of guessing', async () => {
    const id = await createEvent({ title: 'Recital', startsAt: atUtc(5, 18).toISOString() })
    for (const args of [{ date: 'someday' }, { time: '99:99' }]) {
      const res = await commit({ targetKind: 'event', verb: 'reschedule', targetId: id, args })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).message).not.toMatch(/invalid input syntax/i)
    }
  })
})

describe('commit — recurring series: acts on ONE occurrence, never the series', () => {
  it('reschedules only the chosen occurrence', async () => {
    await createEvent({ title: 'Karate class', startsAt: atUtc(2, 17).toISOString(), rrule: 'FREQ=WEEKLY' })
    const occs = (await range(atUtc(0, 0), atUtc(40, 0))).filter((e) => e.title === 'Karate class')
    expect(occs.length).toBeGreaterThanOrEqual(3)
    const target = occs[1]
    expect(target.occurrenceStart).not.toBeNull()

    // Resolve surfaces occurrence rows with the occurrence handle in meta.
    const res = await resolve({ targetKind: 'event', verb: 'reschedule', target: { description: 'karate' }, args: {} })
    const cands = JSON.parse(res.body).candidates as { id: string; meta: { seriesId: string; occurrenceStart: string | null } }[]
    const cand = cands.find((c) => c.id === target.id)!
    expect(cand).toBeDefined()
    expect(cand.meta.seriesId).toBe(target.seriesId)
    expect(cand.meta.occurrenceStart).toBe(target.occurrenceStart)

    const commitRes = await commit({
      targetKind: 'event', verb: 'reschedule', targetId: target.id,
      args: { time: '19:45' }, meta: cand.meta,
    })
    expect(commitRes.statusCode).toBe(200)
    expect(JSON.parse(commitRes.body).message).toMatch(/moved/i)

    const after = (await range(atUtc(0, 0), atUtc(40, 0))).filter((e) => e.title === 'Karate class')
    expect(after.length).toBe(occs.length) // nothing dropped
    const moved = after.find((o) => o.occurrenceStart === target.occurrenceStart)!
    expect(moved.startsAt).toBe(`${target.startsAt.slice(0, 10)}T19:45:00.000Z`)
    for (const o of after) {
      if (o.occurrenceStart === target.occurrenceStart) continue
      const before = occs.find((b) => b.occurrenceStart === o.occurrenceStart)!
      expect(o.startsAt).toBe(before.startsAt) // siblings untouched
    }
  })

  it('delete cancels only the chosen occurrence', async () => {
    await createEvent({ title: 'Swim lessons', startsAt: atUtc(3, 8).toISOString(), rrule: 'FREQ=WEEKLY' })
    const occs = (await range(atUtc(0, 0), atUtc(40, 0))).filter((e) => e.title === 'Swim lessons')
    expect(occs.length).toBeGreaterThanOrEqual(3)
    const drop = occs[1]

    const res = await commit({
      targetKind: 'event', verb: 'delete', targetId: drop.id,
      args: {}, meta: { seriesId: drop.seriesId, occurrenceStart: drop.occurrenceStart },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).message).toMatch(/just this one/i)

    const after = (await range(atUtc(0, 0), atUtc(40, 0))).filter((e) => e.title === 'Swim lessons')
    expect(after.length).toBe(occs.length - 1)
    expect(after.some((o) => o.occurrenceStart === drop.occurrenceStart)).toBe(false)
  })
})

describe('commit — delete a single event', () => {
  it('soft-deletes it and confirms with the title', async () => {
    const id = await createEvent({ title: 'Garage sale', startsAt: atUtc(8, 9).toISOString() })
    const res = await commit({ targetKind: 'event', verb: 'delete', targetId: id, args: {} })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.message).toMatch(/garage sale/i)

    const detail = await call('GET', `/api/events/${id}`, kevin)
    expect(detail.statusCode).toBe(404)
  })
})

describe('commit — tenancy', () => {
  it("404s another household's event id", async () => {
    // Seed a foreign household + event straight in SQL (auth/setup is one-per-instance).
    const { query } = await import('../src/platform/db')
    const h = await query<{ id: string }>(`insert into households (name, timezone) values ('Other','UTC') returning id`)
    const ev = await query<{ id: string }>(
      `insert into events (household_id, title, starts_at, timezone) values ($1, 'Private thing', now() + interval '5 days', 'UTC') returning id`,
      [h.rows[0].id]
    )

    const res = await commit({ targetKind: 'event', verb: 'delete', targetId: ev.rows[0].id, args: {} })
    expect(res.statusCode).toBe(404)
  })
})
