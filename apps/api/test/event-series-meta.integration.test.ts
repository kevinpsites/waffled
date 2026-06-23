// Series-level goal links for GOOGLE-sourced recurring events. Google expands a
// recurrence (singleEvents=true) into one events row per instance, all sharing one
// ical_uid; a goal link must (a) cover every current instance, (b) be recorded at the
// series level (event_series_meta), and (c) be inherited by a NEW instance that streams
// in later (the sync path). A Nook-native event (no ical_uid) keeps single-event
// behavior — no series meta, only itself linked. All against a real Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client, type Pool } from 'pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'nook-local-dev-secret-change-me'
let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let applySeriesMeta: any
let getPool: () => Pool

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'nook-local', audience: 'nook-api', expiresIn: '1h' })
}
interface RunResult { statusCode: number; body: string }
function call(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const [rawPath, qs] = path.split('?')
  const queryStringParameters: Record<string, string> = {}
  if (qs) for (const pair of qs.split('&')) { const [k, v] = pair.split('='); queryStringParameters[k] = decodeURIComponent(v ?? '') }
  return app.run({ httpMethod: method, path: rawPath, headers, queryStringParameters, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false }, {}) as Promise<RunResult>
}

const kevin = mint('dev|kevin')
let householdId = ''
let kevinId = ''
let listId = ''

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try { return await fn(client) } finally { await client.end() }
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
  getPool = (await import('../src/platform/db')).getPool
  applySeriesMeta = (await import('../src/modules/events/event-series-meta')).applySeriesMeta
  const h = await call('POST', '/api/households', kevin, { name: 'Sites', timezone: 'America/Chicago', person: { name: 'Kevin' } })
  const body = JSON.parse(h.body)
  kevinId = body.person.id
  householdId = body.household.id
  const list = await call('POST', '/api/goal-lists', kevin, { name: 'Kevin', memberIds: [kevinId] })
  listId = JSON.parse(list.body).list.id
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

async function makeGoal(over: Record<string, unknown> = {}): Promise<string> {
  const g = await call('POST', '/api/goals', kevin, {
    goalListId: listId, title: 'Goal', goalType: 'total', unit: 'hours', targetValue: 100,
    trackingMode: 'shared_total', autoFromCalendar: true, participantIds: [kevinId], ...over,
  })
  return JSON.parse(g.body).goal.id
}

// Create an event via the API, then stamp it as a Google series instance (shared
// ical_uid + its own google_event_id) the way inbound sync would.
async function googleInstance(icalUid: string, googleEventId: string, hoursAgo = 24): Promise<string> {
  const start = new Date(Date.now() - hoursAgo * 3600_000)
  const r = await call('POST', '/api/events', kevin, {
    title: 'Weekly standup', startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3600_000).toISOString(),
    participantIds: [kevinId],
  })
  const id = JSON.parse(r.body).event.id
  await withClient((cl) =>
    cl.query(`update events set ical_uid = $2, google_event_id = $3, origin = 'google' where id = $1`, [id, icalUid, googleEventId])
  )
  return id
}

async function goalOf(eventId: string): Promise<string | null> {
  return withClient(async (cl) => {
    const r = await cl.query<{ goal_id: string | null }>(`select goal_id from events where id = $1`, [eventId])
    return r.rows[0]?.goal_id ?? null
  })
}

describe('event series meta — Google recurring goal links survive re-sync', () => {
  it('linking one instance of a series links every instance + writes series meta', async () => {
    const goalId = await makeGoal({ title: 'Series hours' })
    const ical = 'series-aaa@google.com'
    const e1 = await googleInstance(ical, 'g-aaa-1')
    const e2 = await googleInstance(ical, 'g-aaa-2', 48)

    // Link the goal to ONE instance (the suggestion-link path → updateEvent → series meta).
    const lk = await call('POST', '/api/goal-calendar/suggestions/link', kevin, { eventId: e1, goalId })
    expect(lk.statusCode).toBe(200)

    // Both instances now carry the goal.
    expect(await goalOf(e1)).toBe(goalId)
    expect(await goalOf(e2)).toBe(goalId)

    // And a series meta row exists for (household, ical_uid) with the goal.
    const meta = await withClient((cl) =>
      cl.query<{ goal_id: string; goal_step_id: string | null }>(
        `select goal_id, goal_step_id from event_series_meta where household_id = $1 and ical_uid = $2 and deleted_at is null`,
        [householdId, ical]
      )
    )
    expect(meta.rows).toHaveLength(1)
    expect(meta.rows[0].goal_id).toBe(goalId)
  })

  it('a NEW instance arriving for the series inherits the goal via applySeriesMeta', async () => {
    const goalId = await makeGoal({ title: 'Inherit hours' })
    const ical = 'series-bbb@google.com'
    const e1 = await googleInstance(ical, 'g-bbb-1')
    await call('POST', '/api/goal-calendar/suggestions/link', kevin, { eventId: e1, goalId })

    // Simulate a fresh Google instance streaming in later: a new events row with the
    // same ical_uid and NO goal link (Nook fields never come from Google).
    const fresh = await googleInstance(ical, 'g-bbb-new', 1)
    expect(await goalOf(fresh)).toBeNull() // not linked at insert

    // The sync path runs applySeriesMeta after persisting the instance.
    const client = await getPool().connect()
    try {
      await applySeriesMeta(client, householdId, ical)
    } finally {
      client.release()
    }
    expect(await goalOf(fresh)).toBe(goalId) // inherited from series meta
  })

  it('applySeriesMeta does not clobber an instance that already has its own link', async () => {
    const seriesGoal = await makeGoal({ title: 'Series goal' })
    const otherGoal = await makeGoal({ title: 'Other goal' })
    const ical = 'series-ccc@google.com'
    const e1 = await googleInstance(ical, 'g-ccc-1')
    await call('POST', '/api/goal-calendar/suggestions/link', kevin, { eventId: e1, goalId: seriesGoal })

    // An instance manually pointed at a DIFFERENT goal.
    const e2 = await googleInstance(ical, 'g-ccc-2', 72)
    await withClient((cl) => cl.query(`update events set goal_id = $2 where id = $1`, [e2, otherGoal]))

    const client = await getPool().connect()
    try {
      await applySeriesMeta(client, householdId, ical)
    } finally {
      client.release()
    }
    // applySeriesMeta only fills NULL links — it leaves e2's explicit choice alone.
    expect(await goalOf(e2)).toBe(otherGoal)
  })

  it('a Nook-native event (no ical_uid) links only itself — no series meta', async () => {
    const goalId = await makeGoal({ title: 'Native goal' })
    const r = await call('POST', '/api/events', kevin, {
      title: 'One-off', startsAt: new Date(Date.now() - 3600_000).toISOString(),
      endsAt: new Date().toISOString(), participantIds: [kevinId],
    })
    const id = JSON.parse(r.body).event.id

    const lk = await call('POST', '/api/goal-calendar/suggestions/link', kevin, { eventId: id, goalId })
    expect(lk.statusCode).toBe(200)
    expect(await goalOf(id)).toBe(goalId)

    // No series meta rows were created for a native (ical_uid-less) event.
    const cnt = await withClient((cl) =>
      cl.query<{ n: number }>(`select count(*)::int n from event_series_meta where goal_id = $1`, [goalId])
    )
    expect(cnt.rows[0].n).toBe(0)
  })
})
