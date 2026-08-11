// Calendar — ICS feed subscriptions (fork P2): read-only "third calendar source"
// that polls a published ICS URL (school schedule, Outlook published calendar, …)
// into the events table with origin='ics'. Exercised against a real Postgres
// (shared-harness Testcontainers) and an in-process HTTP stub serving fixture ICS.
// Covers: admin-only management, url validation, first sync (timed w/ TZID,
// all-day, UTC 'Z', weekly RRULE master → materialized occurrences, CANCELLED),
// idempotent re-sync, soft-delete of events that vanish from the feed, per-feed
// error isolation (404 feed → last_error, other feeds still sync), the feeds
// block on /api/calendar/google/status, and feed PATCH/DELETE.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import { createServer, type Server } from 'node:http'
import jwt from 'jsonwebtoken'
import { DateTime } from 'luxon'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'
const TZ = 'America/Chicago'

let pg: StartedPostgreSqlContainer
let stub: Server
let stubPort = 0
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
let householdId = ''
let wallyId = ''

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}

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

const kevin = mint('dev|kevin')
const wally = mint('dev|wally')

// ── Fixture ICS (dates computed relative to "now" so the test never goes stale) ──

const now = DateTime.now().setZone(TZ)
// Next Monday at 16:00 local — anchor for the weekly recurring event.
let mondayCursor = now.plus({ days: 1 }).startOf('day')
while (mondayCursor.weekday !== 1) mondayCursor = mondayCursor.plus({ days: 1 })
const weeklyStart = mondayCursor.set({ hour: 16 })
const timedStart = now.plus({ days: 3 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
const alldayDate = now.plus({ days: 5 }).startOf('day')
const utcStart = DateTime.utc().plus({ days: 4 }).set({ hour: 14, minute: 0, second: 0, millisecond: 0 })
const cancelledStart = DateTime.utc().plus({ days: 6 }).set({ hour: 14, minute: 0, second: 0, millisecond: 0 })

const fmtLocal = (d: DateTime) => d.toFormat("yyyyMMdd'T'HHmmss")
const fmtDate = (d: DateTime) => d.toFormat('yyyyMMdd')
const fmtUtc = (d: DateTime) => d.toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'")

const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:America/Chicago',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0600',
  'TZOFFSETTO:-0500',
  'TZNAME:CDT',
  'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0600',
  'TZNAME:CST',
  'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
]

function vcal(events: string[][]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Waffled test//EN', ...VTIMEZONE, ...events.flat(), 'END:VCALENDAR'].join('\r\n')
}

const evTimed = [
  'BEGIN:VEVENT',
  'UID:timed-1@school.example',
  `DTSTART;TZID=${TZ}:${fmtLocal(timedStart)}`,
  `DTEND;TZID=${TZ}:${fmtLocal(timedStart.plus({ hours: 1 }))}`,
  'SUMMARY:Dentist appointment',
  'LOCATION:123 Main St',
  'END:VEVENT',
]
const evAllDay = [
  'BEGIN:VEVENT',
  'UID:allday-1@school.example',
  `DTSTART;VALUE=DATE:${fmtDate(alldayDate)}`,
  `DTEND;VALUE=DATE:${fmtDate(alldayDate.plus({ days: 1 }))}`,
  'SUMMARY:Teacher inservice day',
  'END:VEVENT',
]
const evUtc = [
  'BEGIN:VEVENT',
  'UID:utc-1@school.example',
  `DTSTART:${fmtUtc(utcStart)}`,
  `DTEND:${fmtUtc(utcStart.plus({ minutes: 30 }))}`,
  'SUMMARY:Video call',
  'END:VEVENT',
]
const evWeekly = [
  'BEGIN:VEVENT',
  'UID:weekly-1@school.example',
  `DTSTART;TZID=${TZ}:${fmtLocal(weeklyStart)}`,
  `DTEND;TZID=${TZ}:${fmtLocal(weeklyStart.plus({ hours: 1 }))}`,
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'SUMMARY:Soccer practice',
  'END:VEVENT',
]
const evCancelled = [
  'BEGIN:VEVENT',
  'UID:cancelled-1@school.example',
  `DTSTART:${fmtUtc(cancelledStart)}`,
  'STATUS:CANCELLED',
  'SUMMARY:Cancelled assembly',
  'END:VEVENT',
]

// Mutable: tests swap this to simulate the feed changing between polls.
let schoolIcs = vcal([evTimed, evAllDay, evUtc, evWeekly, evCancelled])
const workIcs = vcal([[
  'BEGIN:VEVENT',
  'UID:work-1@work.example',
  `DTSTART:${fmtUtc(utcStart.plus({ days: 1 }))}`,
  `DTEND:${fmtUtc(utcStart.plus({ days: 1, hours: 1 }))}`,
  'SUMMARY:Quarterly review',
  'END:VEVENT',
]])

function startStub(): Promise<number> {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      if (req.url === '/school.ics') {
        res.setHeader('content-type', 'text/calendar')
        return res.end(schoolIcs)
      }
      if (req.url === '/work.ics') {
        res.setHeader('content-type', 'text/calendar')
        return res.end(workIcs)
      }
      res.statusCode = 404
      res.end('not found')
    })
    stub.listen(0, '127.0.0.1', () => resolve((stub.address() as { port: number }).port))
  })
}

let feedId = ''

async function dbQuery<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
  const { query } = await import('../src/platform/db')
  const { rows } = await query(sql, params)
  return rows as T[]
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  stubPort = await startStub()
  process.env.DATABASE_URL = url
  process.env.LOCAL_JWT_SECRET = SECRET
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool

  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: TZ },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  householdId = JSON.parse(setup.body).household.id
  const ownerId = JSON.parse(setup.body).person.id
  const { query } = await import('../src/platform/db')
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [householdId, ownerId]
  )
  // A non-admin member, to prove feed management is admin-only but reads aren't.
  const w = await query<{ id: string }>(
    `insert into persons (household_id, name, member_type, is_admin) values ($1,'Wally','adult',false) returning id`,
    [householdId]
  )
  wallyId = w.rows[0].id
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|wally',true)`,
    [householdId, wallyId]
  )
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await new Promise<void>((r) => stub?.close(() => r()))
  await pg?.stop()
})

describe('ICS calendar feeds', () => {
  it('requires admin to add a feed (non-admin → 403)', async () => {
    const res = await call('POST', '/api/calendar/feeds', wally, { url: `http://127.0.0.1:${stubPort}/school.ics` })
    expect(res.statusCode).toBe(403)
  })

  it('rejects a non-http(s) url', async () => {
    const res = await call('POST', '/api/calendar/feeds', kevin, { url: 'ftp://example.com/cal.ics' })
    expect(res.statusCode).toBe(400)
  })

  it('adds a feed (admin) and any member can list it', async () => {
    const res = await call('POST', '/api/calendar/feeds', kevin, {
      url: `http://127.0.0.1:${stubPort}/school.ics`,
      name: 'School calendar',
    })
    expect(res.statusCode).toBe(201)
    const { feed } = JSON.parse(res.body)
    expect(feed).toMatchObject({ name: 'School calendar', visibility: 'family', lastSyncedAt: null, lastError: null })
    feedId = feed.id

    const list = await call('GET', '/api/calendar/feeds', wally)
    expect(list.statusCode).toBe(200)
    const feeds = JSON.parse(list.body).feeds
    expect(feeds).toHaveLength(1)
    expect(feeds[0].id).toBe(feedId)
  })

  it('first sync imports timed (TZID), all-day, UTC, and recurring events with correct fields', async () => {
    const res = await call('POST', `/api/calendar/feeds/${feedId}/sync`, kevin)
    expect(res.statusCode).toBe(200)
    const result = JSON.parse(res.body)
    expect(result.imported).toBe(4) // timed + all-day + utc + weekly master (cancelled never lands)
    expect(result.error).toBeUndefined()

    const rows = await dbQuery<{
      google_event_id: string; title: string; starts_at: Date; ends_at: Date | null
      all_day: boolean; timezone: string; origin: string; origin_ref_id: string
      calendar_id: string | null; rrule: string | null; sync_state: string; visibility: string
      ical_uid: string | null; deleted_at: Date | null
    }>(`select * from events where household_id = $1 and origin = 'ics' order by google_event_id`, [householdId])
    expect(rows.filter((r) => !r.deleted_at)).toHaveLength(4)
    const byUid = new Map(rows.map((r) => [r.google_event_id, r]))

    const timed = byUid.get('timed-1@school.example')!
    expect(timed).toMatchObject({
      title: 'Dentist appointment', all_day: false, timezone: TZ, origin: 'ics',
      origin_ref_id: feedId, calendar_id: null, sync_state: 'synced', visibility: 'family',
      ical_uid: 'timed-1@school.example',
    })
    expect(new Date(timed.starts_at).toISOString()).toBe(timedStart.toUTC().toISO())
    expect(new Date(timed.ends_at!).toISOString()).toBe(timedStart.plus({ hours: 1 }).toUTC().toISO())

    const allday = byUid.get('allday-1@school.example')!
    expect(allday.all_day).toBe(true)
    // Anchored to midnight in the household/feed zone.
    expect(new Date(allday.starts_at).toISOString()).toBe(alldayDate.toUTC().toISO())

    const utc = byUid.get('utc-1@school.example')!
    expect(new Date(utc.starts_at).toISOString()).toBe(utcStart.toISO())
    expect(utc.all_day).toBe(false)

    const weekly = byUid.get('weekly-1@school.example')!
    expect(weekly.rrule).toContain('FREQ=WEEKLY')
    expect(weekly.timezone).toBe(TZ)
    expect(new Date(weekly.starts_at).toISOString()).toBe(weeklyStart.toUTC().toISO())

    // CANCELLED never shows up as a live event.
    const cancelled = byUid.get('cancelled-1@school.example')
    expect(cancelled?.deleted_at ?? 'absent').not.toBeNull()

    // The recurring master is materialized into occurrences by the existing
    // expansion engine (so it renders like any Waffled-native series).
    const occ = await dbQuery<{ starts_at: Date }>(
      `select o.starts_at from event_occurrences o join events e on e.id = o.event_id
        where e.google_event_id = 'weekly-1@school.example' and o.deleted_at is null order by o.starts_at`,
    )
    expect(occ.length).toBeGreaterThanOrEqual(2)
    expect(new Date(occ[0].starts_at).toISOString()).toBe(weeklyStart.toUTC().toISO())
    expect(new Date(occ[1].starts_at).toISOString()).toBe(weeklyStart.plus({ weeks: 1 }).toUTC().toISO())

    // …and the whole set surfaces on the normal agenda read.
    const from = now.toISODate()
    const to = now.plus({ days: 40 }).toISODate()
    const agenda = await call('GET', `/api/events?from=${from}&to=${to}`, kevin)
    expect(agenda.statusCode).toBe(200)
    const titles = (JSON.parse(agenda.body).events as Array<{ title: string }>).map((e) => e.title)
    expect(titles).toContain('Dentist appointment')
    expect(titles).toContain('Teacher inservice day')
    expect(titles).toContain('Video call')
    expect(titles.filter((t) => t === 'Soccer practice').length).toBeGreaterThanOrEqual(2)
    expect(titles).not.toContain('Cancelled assembly')

    // The feed row records the successful sync.
    const feeds = JSON.parse((await call('GET', '/api/calendar/feeds', kevin)).body).feeds
    expect(feeds[0].lastSyncedAt).not.toBeNull()
    expect(feeds[0].lastError).toBeNull()
  })

  it('re-sync is idempotent (no duplicate events)', async () => {
    const res = await call('POST', `/api/calendar/feeds/${feedId}/sync`, kevin)
    expect(res.statusCode).toBe(200)
    const result = JSON.parse(res.body)
    expect(result.imported).toBe(0)
    expect(result.updated).toBe(4)

    const dupes = await dbQuery<{ google_event_id: string; n: string }>(
      `select google_event_id, count(*) as n from events
        where origin = 'ics' and origin_ref_id = $1 and deleted_at is null
        group by google_event_id having count(*) > 1`,
      [feedId]
    )
    expect(dupes).toHaveLength(0)
    const live = await dbQuery<{ n: string }>(
      `select count(*) as n from events where origin = 'ics' and origin_ref_id = $1 and deleted_at is null`,
      [feedId]
    )
    expect(Number(live[0].n)).toBe(4)
  })

  it('an event removed from the feed is soft-deleted on the next sync', async () => {
    schoolIcs = vcal([evAllDay, evUtc, evWeekly, evCancelled]) // dentist appointment vanished
    const res = await call('POST', `/api/calendar/feeds/${feedId}/sync`, kevin)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).deleted).toBe(1)

    const rows = await dbQuery<{ deleted_at: Date | null }>(
      `select deleted_at from events where origin_ref_id = $1 and google_event_id = 'timed-1@school.example'`,
      [feedId]
    )
    expect(rows[0].deleted_at).not.toBeNull()
    // The survivors are untouched.
    const live = await dbQuery<{ n: string }>(
      `select count(*) as n from events where origin = 'ics' and origin_ref_id = $1 and deleted_at is null`,
      [feedId]
    )
    expect(Number(live[0].n)).toBe(3)
  })

  it('a 404 feed records last_error; other feeds still sync (scheduler unit of work)', async () => {
    const add = await call('POST', '/api/calendar/feeds', kevin, {
      url: `http://127.0.0.1:${stubPort}/missing.ics`,
      name: 'Broken feed',
    })
    const brokenId = JSON.parse(add.body).feed.id
    const addWork = await call('POST', '/api/calendar/feeds', kevin, {
      url: `http://127.0.0.1:${stubPort}/work.ics`,
      name: 'Work',
    })
    const workId = JSON.parse(addWork.body).feed.id

    // Run the scheduler's unit of work over ALL feeds: the broken one must not
    // abort the others.
    const { syncAllIcsFeeds } = await import('../src/modules/calendar/ics-feeds')
    await syncAllIcsFeeds()

    const feeds = JSON.parse((await call('GET', '/api/calendar/feeds', kevin)).body).feeds as Array<{
      id: string; lastError: string | null; lastSyncedAt: string | null
    }>
    const broken = feeds.find((f) => f.id === brokenId)!
    const work = feeds.find((f) => f.id === workId)!
    const school = feeds.find((f) => f.id === feedId)!
    expect(broken.lastError).toMatch(/404/)
    expect(work.lastError).toBeNull()
    expect(work.lastSyncedAt).not.toBeNull()
    expect(school.lastError).toBeNull()

    const workEvents = await dbQuery<{ title: string }>(
      `select title from events where origin_ref_id = $1 and deleted_at is null`, [workId]
    )
    expect(workEvents.map((e) => e.title)).toContain('Quarterly review')

    // Clean up the broken feed so later assertions stay focused.
    await call('DELETE', `/api/calendar/feeds/${brokenId}`, kevin)
  })

  it('feeds appear in the /api/calendar/google/status payload', async () => {
    const res = await call('GET', '/api/calendar/google/status', kevin)
    expect(res.statusCode).toBe(200)
    const { feeds } = JSON.parse(res.body)
    expect(Array.isArray(feeds)).toBe(true)
    const names = feeds.map((f: { name: string | null }) => f.name)
    expect(names).toContain('School calendar')
    expect(names).toContain('Work')
  })

  it('PATCH maps the feed to a person + visibility and restamps its events', async () => {
    const res = await call('PATCH', `/api/calendar/feeds/${feedId}`, kevin, { personId: wallyId, visibility: 'personal' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).feed).toMatchObject({ personId: wallyId, visibility: 'personal' })

    const rows = await dbQuery<{ visibility: string; owner_person_id: string | null }>(
      `select distinct visibility, owner_person_id from events where origin_ref_id = $1 and deleted_at is null`,
      [feedId]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ visibility: 'personal', owner_person_id: wallyId })

    // Non-admin cannot PATCH.
    expect((await call('PATCH', `/api/calendar/feeds/${feedId}`, wally, { name: 'x' })).statusCode).toBe(403)
  })

  it('DELETE soft-deletes the feed and its events', async () => {
    const res = await call('DELETE', `/api/calendar/feeds/${feedId}`, kevin)
    expect(res.statusCode).toBe(204)

    const feeds = JSON.parse((await call('GET', '/api/calendar/feeds', kevin)).body).feeds as Array<{ id: string }>
    expect(feeds.find((f) => f.id === feedId)).toBeUndefined()

    const live = await dbQuery<{ n: string }>(
      `select count(*) as n from events where origin_ref_id = $1 and deleted_at is null`, [feedId]
    )
    expect(Number(live[0].n)).toBe(0)
    // Materialized occurrences of the recurring master are tombstoned too.
    const occ = await dbQuery<{ n: string }>(
      `select count(*) as n from event_occurrences o join events e on e.id = o.event_id
        where e.origin_ref_id = $1 and o.deleted_at is null`, [feedId]
    )
    expect(Number(occ[0].n)).toBe(0)
  })
})
