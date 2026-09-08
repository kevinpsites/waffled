// Calendar → goal auto-counting (Phase 1) — the recap queue, the editable confirm
// write, idempotency, skip, attribution, and the cancelled/future filters, all
// against a real Postgres.
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
  if (qs) for (const pair of qs.split('&')) { const [k, v] = pair.split('='); queryStringParameters[k] = decodeURIComponent(v ?? '') }
  return app.run({ httpMethod: method, path: rawPath, headers, queryStringParameters, body: body !== undefined ? JSON.stringify(body) : null, isBase64Encoded: false }, {}) as Promise<RunResult>
}

const kevin = mint('dev|kevin')
const guest = mint('dev|goal-calendar-guest')
let householdId = ''
let kevinId = ''
let kellyId = ''
let foreignPersonId = ''
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
  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  expect(setup.statusCode).toBe(201)
  const body = JSON.parse(setup.body)
  kevinId = body.person.id
  householdId = body.household.id
  // Seed an identity so the legacy mint('dev|kevin') token resolves to the owner.
  await withClient((cl) =>
    cl.query(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
      [householdId, kevinId]
    )
  )
  const guestPerson = await withClient((cl) =>
    cl.query<{ id: string }>(
      `insert into persons (household_id, name, member_type)
       values ($1, 'Goal Calendar Guest', 'guest') returning id`,
      [householdId]
    )
  )
  await withClient((cl) =>
    cl.query(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified)
       values ($1,$2,'password','dev|goal-calendar-guest',true)`,
      [householdId, guestPerson.rows[0].id]
    )
  )
  const k = await call('POST', '/api/persons', kevin, { name: 'Kelly', memberType: 'adult' })
  kellyId = JSON.parse(k.body).person.id
  foreignPersonId = await withClient(async (cl) => {
    const h = await cl.query<{ id: string }>(
      `insert into households (name, timezone) values ('Other recap','UTC') returning id`
    )
    return (await cl.query<{ id: string }>(
      `insert into persons (household_id, name, member_type) values ($1,'Outsider','adult') returning id`,
      [h.rows[0].id]
    )).rows[0].id
  })
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
  it('rejects confirmation attribution to another household', async () => {
    const goalId = await makeGoal({ title: 'Boundary recap' })
    await linkedEvent(goalId, 60, [kevinId])
    const item = (await recap(goalId))[0]
    expect((await call('POST', '/api/goal-calendar/recap/confirm', kevin, {
      eventId: item.eventId,
      occurrenceDate: item.occurrenceDate,
      amount: 1,
      personIds: [foreignPersonId],
    })).statusCode).toBe(404)
    expect(await recap(goalId)).toHaveLength(1)
  })

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

  it('editing the note on a confirmed entry keeps the event link intact', async () => {
    // The recap's idempotency is keyed on (event, occurrence, goal) via event_goal_logs,
    // which points at the goal_logs row it wrote. A note edit must update that row in
    // place — re-planning it (soft-delete + re-insert under new ids) would leave the link
    // dangling and let the same occurrence be confirmed a second time.
    const goalId = await makeGoal({ title: 'Note on a confirmed entry' })
    const eventId = await linkedEvent(goalId, 60, [kevinId])
    const occ = (await recap(goalId))[0].occurrenceDate as string
    await call('POST', '/api/goal-calendar/recap/confirm', kevin, { eventId, occurrenceDate: occ, amount: 1, personIds: [kevinId] })
    const entry = JSON.parse((await call('GET', `/api/goals/${goalId}`, kevin)).body).goal.recent[0]
    expect(entry.editable).toBe(false)

    const res = await call('PATCH', `/api/goals/${goalId}/logs/${entry.id}`, kevin, { amount: entry.amount, note: 'good session', loggedOn: entry.dateKey })
    expect(res.statusCode).toBe(200)

    const after = JSON.parse((await call('GET', `/api/goals/${goalId}`, kevin)).body).goal
    expect(after.recent[0]).toMatchObject({ id: entry.id, note: 'good session' })
    expect(after.totalProgress).toBe(1)
    // The bridge row still points at a live log, so the occurrence stays resolved.
    const link = await withClient((cl) =>
      cl.query(`select egl.goal_log_id, gl.deleted_at from event_goal_logs egl
                  join goal_logs gl on gl.id = egl.goal_log_id
                 where egl.goal_id=$1`, [goalId])
    )
    expect(link.rows.length).toBe(1)
    expect(link.rows[0].deleted_at).toBeNull()
    const again = await call('POST', '/api/goal-calendar/recap/confirm', kevin, { eventId, occurrenceDate: occ, amount: 1, personIds: [kevinId] })
    expect(JSON.parse(again.body).status).toBe('duplicate')
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

    const statuses: string[] = []
    for (const it of items) {
      const c = await call('POST', '/api/goal-calendar/recap/confirm', kevin, { eventId: it.eventId, occurrenceDate: it.occurrenceDate, amount: 1, personIds: [kevinId] })
      expect(c.statusCode).toBe(201)
      statuses.push(JSON.parse(c.body).status)
    }
    // Both resolve, but the habit's once-a-day guard means only one of them wrote
    // anything — and the caller can tell which, rather than hearing 'logged' twice.
    expect(statuses).toEqual(['logged', 'already_logged'])
    const rows = await withClient((cl) =>
      cl.query(`select count(*)::int as n from goal_logs where goal_id=$1 and deleted_at is null`, [goalId])
    )
    expect(rows.rows[0].n).toBe(1)
    void e1; void e2
  })

  // Backdating a recap moved the habit dedupe from "vs today" to "vs the event's own
  // day" — which makes this the ordinary case, not a corner: you ran on Monday and
  // logged it yourself on Monday, then answer Thursday's recap for that same run.
  // The recap must resolve (stop asking) without double-counting, and must not claim
  // it recorded something it didn't.
  it('habit already logged by hand on the event day → resolves, says so, writes nothing new', async () => {
    const goalId = await makeGoal({ title: 'Habit dup', goalType: 'habit', unit: null, habitPeriod: 'day', habitTargetPerPeriod: 1, trackingMode: 'each_tracks' })
    const eventId = await linkedEvent(goalId, 30, [kevinId])
    const item = (await recap(goalId))[0]
    const occ = item.occurrenceDate as string

    // The manual log, dated to the event's own day.
    const manual = await call('POST', `/api/goals/${goalId}/log`, kevin, { amount: 1, personIds: [kevinId], loggedOn: occ })
    expect(manual.statusCode).toBe(201)

    const c = await call('POST', '/api/goal-calendar/recap/confirm', kevin, { eventId, occurrenceDate: occ, amount: 1, personIds: [kevinId] })
    expect(c.statusCode).toBe(201)
    expect(JSON.parse(c.body).status).toBe('already_logged')

    // Resolved (the recap stops asking) and still exactly one log for that day.
    expect(await recap(goalId)).toHaveLength(0)
    const rows = await withClient((cl) =>
      cl.query(`select count(*)::int as n from goal_logs where goal_id=$1 and deleted_at is null`, [goalId])
    )
    expect(rows.rows[0].n).toBe(1)
  })

  it('checklist: a linked event ticks its step on confirm (and only its step)', async () => {
    // Checklist goal with two steps; the event is linked to the second one.
    const g = await call('POST', '/api/goals', kevin, {
      goalListId: listId, title: 'Reno', goalType: 'checklist', trackingMode: 'shared_total',
      autoFromCalendar: true, participantIds: [kevinId],
      steps: [{ label: 'Sand the deck' }, { label: 'Prime the walls' }],
    })
    const goalId = JSON.parse(g.body).goal.id
    const before = JSON.parse((await call('GET', `/api/goals/${goalId}`, kevin)).body).goal
    const primeStep = before.steps.find((s: { label: string }) => s.label === 'Prime the walls')

    // An ended event linked to the goal + that step.
    const start = new Date(Date.now() - 24 * 3600_000)
    const ev = await call('POST', '/api/events', kevin, {
      title: 'Painting', startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3600_000).toISOString(),
      participantIds: [kevinId], goalId, goalStepId: primeStep.id,
    })
    const eventId = JSON.parse(ev.body).event.id

    // Recap surfaces it with the step label and no amount expectation.
    const items = await recap(goalId)
    expect(items.length).toBe(1)
    expect(items[0].goalType).toBe('checklist')
    expect(items[0].stepLabel).toBe('Prime the walls')

    // Confirm ticks the linked step — and ONLY it.
    const c = await call('POST', '/api/goal-calendar/recap/confirm', kevin, {
      eventId, occurrenceDate: items[0].occurrenceDate, amount: 1, personIds: [kevinId],
    })
    expect(JSON.parse(c.body).status).toBe('logged')

    const after = JSON.parse((await call('GET', `/api/goals/${goalId}`, kevin)).body).goal
    const prime = after.steps.find((s: { label: string }) => s.label === 'Prime the walls')
    const sand = after.steps.find((s: { label: string }) => s.label === 'Sand the deck')
    expect(prime.done).toBe(true)
    expect(sand.done).toBe(false)
    expect(after.stepDone).toBe(1)

    // The tick is mirrored as a goal_log (auto_calendar / goal_step) and the recap clears.
    const log = await withClient((cl) =>
      cl.query(`select source, ref_type, ref_id from goal_logs where goal_id=$1 and deleted_at is null`, [goalId])
    )
    expect(log.rows[0]).toMatchObject({ source: 'auto_calendar', ref_type: 'goal_step', ref_id: primeStep.id })
    expect((await recap(goalId)).length).toBe(0)
  })

  it('checklist: recap hides once the linked step is already done', async () => {
    const g = await call('POST', '/api/goals', kevin, {
      goalListId: listId, title: 'Reno2', goalType: 'checklist', trackingMode: 'shared_total',
      autoFromCalendar: true, participantIds: [kevinId], steps: [{ label: 'Caulk the tub' }],
    })
    const goalId = JSON.parse(g.body).goal.id
    const detail = JSON.parse((await call('GET', `/api/goals/${goalId}`, kevin)).body).goal
    const stepId = detail.steps[0].id
    // Tick the step manually first.
    await call('PATCH', `/api/goals/${goalId}/steps/${stepId}`, kevin, { done: true })
    // A linked event for that already-done step shouldn't ask.
    const start = new Date(Date.now() - 24 * 3600_000)
    await call('POST', '/api/events', kevin, {
      title: 'Caulking', startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 1800_000).toISOString(),
      participantIds: [kevinId], goalId, goalStepId: stepId,
    })
    expect((await recap(goalId)).length).toBe(0)
  })

  // A recap is answered AFTER the fact — often days later. The entry belongs on the
  // day the event happened, not the day you got round to confirming it.
  it('lands the confirmed entry on the event’s day, not today', async () => {
    const goalId = await makeGoal({ title: 'Backdated recap' })
    const eventId = await linkedEvent(goalId, 60, [kevinId], 72) // ended 3 days ago
    const occ = (await recap(goalId))[0].occurrenceDate as string
    const today = await withClient(async (cl) =>
      (await cl.query<{ d: string }>(`select (now() at time zone 'America/Chicago')::date::text as d`)).rows[0].d
    )
    expect(occ).not.toBe(today) // guard: the fixture really is in the past

    const c = await call('POST', '/api/goal-calendar/recap/confirm', kevin, {
      eventId, occurrenceDate: occ, amount: 2, personIds: [kevinId],
    })
    expect(JSON.parse(c.body).status).toBe('logged')

    const detail = JSON.parse((await call('GET', `/api/goals/${goalId}`, kevin)).body).goal
    expect(detail.recent[0].dateKey).toBe(occ)
    const act = JSON.parse((await call('GET', `/api/goals/${goalId}/activity`, kevin)).body)
    expect((act.days as Array<{ dateKey: string; total: number }>).find((d) => d.dateKey === occ)?.total).toBe(2)
  })

  it('checklist: the mirrored tick also lands on the event’s day', async () => {
    const g = await call('POST', '/api/goals', kevin, {
      goalListId: listId, title: 'Reno backdate', goalType: 'checklist', trackingMode: 'shared_total',
      autoFromCalendar: true, participantIds: [kevinId], steps: [{ label: 'Grout the tile' }],
    })
    const goalId = JSON.parse(g.body).goal.id
    const start = new Date(Date.now() - 72 * 3600_000)
    const ev = await call('POST', '/api/events', kevin, {
      title: 'Grouting', startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3600_000).toISOString(),
      participantIds: [kevinId], goalId,
      goalStepId: JSON.parse((await call('GET', `/api/goals/${goalId}`, kevin)).body).goal.steps[0].id,
    })
    const eventId = JSON.parse(ev.body).event.id
    const occ = (await recap(goalId))[0].occurrenceDate as string
    await call('POST', '/api/goal-calendar/recap/confirm', kevin, { eventId, occurrenceDate: occ, amount: 1, personIds: [kevinId] })

    const day = await withClient(async (cl) =>
      (await cl.query<{ d: string }>(
        `select (logged_at at time zone 'America/Chicago')::date::text as d
           from goal_logs where goal_id=$1 and deleted_at is null`, [goalId]
      )).rows[0].d
    )
    expect(day).toBe(occ)
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

// An untagged event N hours ago with a given title + people (for suggestions).
async function untaggedEvent(title: string, participantIds: string[], hoursAgo = 24): Promise<string> {
  const start = new Date(Date.now() - hoursAgo * 3600_000)
  const end = new Date(start.getTime() + 3600_000)
  const r = await call('POST', '/api/events', kevin, { title, startsAt: start.toISOString(), endsAt: end.toISOString(), participantIds })
  return JSON.parse(r.body).event.id
}
async function suggestions() {
  const r = await call('GET', '/api/goal-calendar/suggestions', kevin)
  return JSON.parse(r.body).items as Array<Record<string, unknown>>
}

describe('calendar → goal suggestions (Phase B)', () => {
  it('keyword-matches an untagged event to a goal, then link clears it', async () => {
    const goalId = await makeGoal({ title: 'Reading hours', category: 'intellectual' })
    const eventId = await untaggedEvent('Library trip', [kevinId])

    const items = await suggestions()
    const mine = items.find((s) => s.eventId === eventId)
    expect(mine).toBeTruthy()
    expect(mine!.goalId).toBe(goalId)
    expect(mine!.via).toBe('keyword')

    const lk = await call('POST', '/api/goal-calendar/suggestions/link', kevin, { eventId, goalId })
    expect(lk.statusCode).toBe(200)
    // Now tagged → no longer suggested; the event carries the goal link.
    expect((await suggestions()).find((s) => s.eventId === eventId)).toBeFalsy()
    const ev = JSON.parse((await call('GET', `/api/events/${eventId}`, kevin)).body).event
    expect(ev.goalId).toBe(goalId)
  })

  it('dismiss hides a suggestion for good', async () => {
    // Distinct concept (swimming) so it can't tie with the reading goal above.
    await makeGoal({ title: 'Swim 50 laps', category: 'physical' })
    const eventId = await untaggedEvent('Pool time', [kevinId])
    expect((await suggestions()).find((s) => s.eventId === eventId)).toBeTruthy()
    const d = await call('POST', '/api/goal-calendar/suggestions/dismiss', kevin, { eventId })
    expect(d.statusCode).toBe(200)
    expect((await suggestions()).find((s) => s.eventId === eventId)).toBeFalsy()
  })

  it('learned memory matches a phrasing keywords would miss', async () => {
    // A goal whose title shares no concept with "Trivia night".
    const goalId = await makeGoal({ title: 'Brain training', category: 'intellectual' })
    const first = await untaggedEvent('Trivia night', [kevinId])
    // Keywords can't place it (no shared concept/token) → not suggested yet.
    expect((await suggestions()).find((s) => s.eventId === first)).toBeFalsy()
    // Human links it → teaches the household matcher (token "trivia" → goal).
    await call('POST', '/api/goal-calendar/suggestions/link', kevin, { eventId: first, goalId })
    // A NEW "Trivia night" is now matched from memory, no LLM needed.
    const second = await untaggedEvent('Trivia night', [kevinId], 20)
    const hit = (await suggestions()).find((s) => s.eventId === second)
    expect(hit).toBeTruthy()
    expect(hit!.goalId).toBe(goalId)
    expect(hit!.via).toBe('memory')
  })

  it('respects the participant superset rule', async () => {
    // Kevin-only goal; an event with Kelly can't be suggested for it.
    await makeGoal({ title: 'Reading hours', category: 'intellectual' })
    const eventId = await untaggedEvent('Library trip', [kevinId, kellyId])
    expect((await suggestions()).find((s) => s.eventId === eventId)).toBeFalsy()
  })

  it('keeps a guest suggestion GET out of the persistence-bearing LLM fallback', async () => {
    await makeGoal({ title: 'Unrelated austere objective', category: 'other' })
    const eventId = await untaggedEvent('Zorblax rendezvous', [kevinId], 18)
    await withClient((cl) =>
      cl.query(
        `update households
            set settings = coalesce(settings, '{}'::jsonb)
              || jsonb_build_object('ai', jsonb_build_object('provider', 'ollama', 'model', 'test'))
          where id = $1`,
        [householdId]
      )
    )
    try {
      const response = await call('GET', '/api/goal-calendar/suggestions', guest)
      expect(response.statusCode).toBe(200)
      const seen = await withClient((cl) =>
        cl.query(`select 1 from event_llm_seen where household_id=$1 and event_id=$2`, [householdId, eventId])
      )
      expect(seen.rows).toHaveLength(0)
    } finally {
      await withClient((cl) =>
        cl.query(
          `update households
              set settings = coalesce(settings, '{}'::jsonb)
                || jsonb_build_object('ai', jsonb_build_object('provider', 'heuristic', 'model', null))
            where id = $1`,
          [householdId]
        )
      )
    }
  })
})

describe('calendar → goal recap (recurring)', () => {
  const day = 86_400_000
  // A weekly linked series with 3 past, ended occurrences (−21, −14, −7 days).
  async function weeklyLinked(goalId: string): Promise<string> {
    const start = new Date(Date.now() - 21 * day)
    const end = new Date(start.getTime() + 60 * 60_000) // 1h
    const r = await call('POST', '/api/events', kevin, {
      title: 'Weekly session',
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      participantIds: [kevinId],
      goalId,
      rrule: 'FREQ=WEEKLY',
      recurrenceEndAt: new Date(Date.now() - day).toISOString(),
    })
    return JSON.parse(r.body).event.id
  }

  it('recaps each past occurrence of a recurring series (keyed by the master id)', async () => {
    const goalId = await makeGoal({ title: 'Weekly hours' })
    const seriesId = await weeklyLinked(goalId)

    const items = await recap(goalId)
    expect(items).toHaveLength(3)
    // every item belongs to the master series, with a distinct occurrence date
    expect(items.every((i) => i.eventId === seriesId)).toBe(true)
    expect(new Set(items.map((i) => i.occurrenceDate)).size).toBe(3)
    expect(items.every((i) => i.suggestedAmount === 1)).toBe(true) // 1h duration

    // confirm one occurrence → only that instance leaves the queue; idempotent
    const first = items[0]
    const c = await call('POST', '/api/goal-calendar/recap/confirm', kevin, {
      eventId: first.eventId,
      occurrenceDate: first.occurrenceDate,
      amount: 1,
      personIds: [kevinId],
    })
    expect(c.statusCode).toBe(201)
    const dup = await call('POST', '/api/goal-calendar/recap/confirm', kevin, {
      eventId: first.eventId,
      occurrenceDate: first.occurrenceDate,
      amount: 1,
      personIds: [kevinId],
    })
    expect(JSON.parse(dup.body).status).toBe('duplicate')

    const after = await recap(goalId)
    expect(after).toHaveLength(2)
    expect(after.some((i) => i.occurrenceDate === first.occurrenceDate)).toBe(false)
  })

  it('suggests linking an untagged recurring series (one suggestion, master id)', async () => {
    // Distinctive token ("quokka") so memory matching is unambiguous in the shared
    // test household (common words get polluted by other tests' learned matches).
    const goalId = await makeGoal({ title: 'Quokka outings', category: 'physical' })
    const single = await untaggedEvent('Quokka outing', [kevinId])
    await call('POST', '/api/goal-calendar/suggestions/link', kevin, { eventId: single, goalId })

    // An untagged weekly series of the same phrasing, with an occurrence in-window.
    const start = new Date(Date.now() - 2 * day)
    const r = await call('POST', '/api/events', kevin, {
      title: 'Quokka outing',
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 45 * 60_000).toISOString(),
      participantIds: [kevinId],
      rrule: 'FREQ=WEEKLY',
      recurrenceEndAt: new Date(Date.now() + 30 * day).toISOString(),
    })
    const seriesId = JSON.parse(r.body).event.id
    const hits = (await suggestions()).filter((s) => s.eventId === seriesId)
    expect(hits).toHaveLength(1) // one per series, not per occurrence
    expect(hits[0].goalId).toBe(goalId)
  })
})
