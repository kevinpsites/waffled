// Calendar → goal auto-counting (Phase 1) — the recap queue, the editable confirm
// write, idempotency, skip, attribution, and the cancelled/future filters, all
// against a real Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Client } from 'pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'nook-local-dev-secret-change-me'
let pg: StartedPostgreSqlContainer
let url: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>

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
let kellyId = ''
let listId = ''

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try { return await fn(client) } finally { await client.end() }
}

// A timed event N hours ago, lasting `durMin` minutes, linked to a goal.
async function linkedEvent(goalId: string, durMin: number, participantIds: string[], hoursAgo = 24): Promise<string> {
  const start = new Date(Date.now() - hoursAgo * 3600_000)
  const end = new Date(start.getTime() + durMin * 60_000)
  const r = await call('POST', '/api/events', kevin, {
    title: 'Session', startsAt: start.toISOString(), endsAt: end.toISOString(),
    participantIds, goalId,
  })
  return JSON.parse(r.body).event.id
}

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  closePool = (await import('../src/platform/db')).closePool
  const h = await call('POST', '/api/households', kevin, { name: 'Sites', timezone: 'America/Chicago', person: { name: 'Kevin' } })
  const body = JSON.parse(h.body)
  kevinId = body.person.id
  householdId = body.household.id
  const k = await call('POST', '/api/persons', kevin, { name: 'Kelly', memberType: 'adult' })
  kellyId = JSON.parse(k.body).person.id
  const list = await call('POST', '/api/goal-lists', kevin, { name: 'Kevin', memberIds: [kevinId] })
  listId = JSON.parse(list.body).list.id
}, 60_000)

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

async function makeGoal(over: Record<string, unknown>): Promise<string> {
  const g = await call('POST', '/api/goals', kevin, {
    goalListId: listId, title: 'Goal', goalType: 'total', unit: 'hours', targetValue: 100,
    trackingMode: 'shared_total', autoFromCalendar: true, participantIds: [kevinId], ...over,
  })
  return JSON.parse(g.body).goal.id
}

async function recap(goalId?: string) {
  const r = await call('GET', goalId ? `/api/goal-calendar/recap?goalId=${goalId}` : '/api/goal-calendar/recap', kevin)
  return JSON.parse(r.body).items as Array<Record<string, unknown>>
}

describe('calendar → goal recap', () => {
  it('surfaces a linked, ended event with duration + attribution, then confirms it', async () => {
    const goalId = await makeGoal({ title: 'Hours total' })
    const eventId = await linkedEvent(goalId, 90, [kevinId]) // 90 min = 1.5 hours

    const items = await recap(goalId)
    expect(items.length).toBe(1)
    expect(items[0].eventId).toBe(eventId)
    expect(items[0].suggestedAmount).toBe(1.5)
    expect(items[0].defaultPersonIds).toEqual([kevinId])

    const occ = items[0].occurrenceDate as string
    const c = await call('POST', '/api/goal-calendar/recap/confirm', kevin, {
      eventId, occurrenceDate: occ, amount: 2, personIds: [kevinId],
    })
    expect(c.statusCode).toBe(201)
    expect(JSON.parse(c.body).status).toBe('logged')

    // Progress written with source auto_calendar; recap now empty.
    const detail = JSON.parse((await call('GET', `/api/goals/${goalId}`, kevin)).body).goal
    expect(detail.totalProgress).toBe(2)
    expect((await recap(goalId)).length).toBe(0)
    const src = await withClient((cl) =>
      cl.query(`select source, ref_type, ref_id from goal_logs where goal_id=$1 and deleted_at is null`, [goalId])
    )
    expect(src.rows[0]).toMatchObject({ source: 'auto_calendar', ref_type: 'event', ref_id: eventId })
  })

  it('is idempotent — a second confirm never double-counts', async () => {
    const goalId = await makeGoal({ title: 'Idem' })
    const eventId = await linkedEvent(goalId, 60, [kevinId])
    const occ = (await recap(goalId))[0].occurrenceDate as string

    await call('POST', '/api/goal-calendar/recap/confirm', kevin, { eventId, occurrenceDate: occ, amount: 1, personIds: [kevinId] })
    const again = await call('POST', '/api/goal-calendar/recap/confirm', kevin, { eventId, occurrenceDate: occ, amount: 1, personIds: [kevinId] })
    expect(JSON.parse(again.body).status).toBe('duplicate')

    const detail = JSON.parse((await call('GET', `/api/goals/${goalId}`, kevin)).body).goal
    expect(detail.totalProgress).toBe(1) // not 2
  })

  it('skip records resolution without writing progress', async () => {
    const goalId = await makeGoal({ title: 'Skip' })
    const eventId = await linkedEvent(goalId, 60, [kevinId])
    const occ = (await recap(goalId))[0].occurrenceDate as string

    const s = await call('POST', '/api/goal-calendar/recap/skip', kevin, { eventId, occurrenceDate: occ })
    expect(s.statusCode).toBe(200)
    expect((await recap(goalId)).length).toBe(0)
    const detail = JSON.parse((await call('GET', `/api/goals/${goalId}`, kevin)).body).goal
    expect(detail.totalProgress).toBe(0)
  })

  it('default attribution = event ∩ goal participants', async () => {
    // Goal has Kevin only; event tags Kevin + Kelly → intersection is Kevin.
    const goalId = await makeGoal({ title: 'Attr' })
    await linkedEvent(goalId, 60, [kevinId, kellyId])
    expect((await recap(goalId))[0].defaultPersonIds).toEqual([kevinId])
  })

  it('habit confirm respects once-a-day (two events, one log)', async () => {
    const goalId = await makeGoal({ title: 'Habit', goalType: 'habit', unit: null, habitPeriod: 'day', habitTargetPerPeriod: 1, trackingMode: 'each_tracks' })
    const e1 = await linkedEvent(goalId, 30, [kevinId], 26)
    const e2 = await linkedEvent(goalId, 30, [kevinId], 25) // same day, later
    const items = await recap(goalId)
    expect(items.length).toBe(2)
    expect(items.every((i) => i.suggestedAmount === 1)).toBe(true)

    for (const it of items) {
      const c = await call('POST', '/api/goal-calendar/recap/confirm', kevin, { eventId: it.eventId, occurrenceDate: it.occurrenceDate, amount: 1, personIds: [kevinId] })
      expect(JSON.parse(c.body).status).toBe('logged') // both resolve...
    }
    // ...but the habit's once-a-day guard means only one progress row exists.
    const rows = await withClient((cl) =>
      cl.query(`select count(*)::int as n from goal_logs where goal_id=$1 and deleted_at is null`, [goalId])
    )
    expect(rows.rows[0].n).toBe(1)
    void e1; void e2
  })

  it('excludes cancelled, future, and non-opted-in events', async () => {
    // cancelled status
    const g1 = await makeGoal({ title: 'Cancelled' })
    const ce = await linkedEvent(g1, 60, [kevinId])
    await withClient((cl) => cl.query(`update events set status='cancelled' where id=$1`, [ce]))
    expect((await recap(g1)).length).toBe(0)

    // future event (hasn't ended)
    const g2 = await makeGoal({ title: 'Future' })
    const start = new Date(Date.now() + 3600_000)
    const fr = await call('POST', '/api/events', kevin, {
      title: 'Later', startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3600_000).toISOString(),
      participantIds: [kevinId], goalId: g2,
    })
    expect(fr.statusCode).toBe(201)
    expect((await recap(g2)).length).toBe(0)

    // goal not opted in (auto_from_calendar false) → linked event ignored
    const g3 = await makeGoal({ title: 'NoOptIn', autoFromCalendar: false })
    await linkedEvent(g3, 60, [kevinId])
    expect((await recap(g3)).length).toBe(0)
  })
})
