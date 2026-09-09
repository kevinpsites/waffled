// Weekly Planning · step 6 — Goals. "What's each group's focus this week?"
//
// A READ over goal_lists + goals plus one write: picking a group's focus sets the goal's
// existing `is_featured` flag, one per list. No "focus" table, no parallel flag. The
// SESSION records which groups have settled (and that "nothing this week" was a real
// answer).
//
// The other half of this file is privacy: a private goal list belongs to its members. It
// must not appear in the read for anyone else, and naming it in a write must 404.
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

const kevin = mint('dev|kevin')   // admin, in the family list and the private couple's list
const kelly = mint('dev|kelly')   // adult, in both too
const lottie = mint('dev|lottie') // kid — NOT in the private list
const json = (r: { body: string }) => JSON.parse(r.body)

let householdId: string
let kevinId: string
let kellyId: string
let lottieId: string
let familyList: string
let coupleList: string  // private
let lottieList: string
let paceList: string
let sessionId: string
let gWater: string
let gWalk: string
// A goal the family pinned BEFORE the session — the session must never un-pin it.
let gPinned: string
// A goal in another list, to prove a focus write is scoped to its own list.
let gDate: string
let gReading: string
let gNever: string
let gStalled: string
let gGone: string
let gWeek: string
let gHabit: string
let gCadence: string

interface Group {
  listId: string
  name: string
  isPrivate: boolean
  isEveryone: boolean
  settled: boolean
  focusGoalId: string | null
  members: Array<{ personId: string; name: string; age: number | null }>
  goals: Array<{
    id: string; title: string; isFeatured: boolean; goalType: string
    periodDone: number; stepDone: number; stepTotal: number; totalProgress: number
    pace: { text: string; tone: 'ok' | 'flat' | 'behind' } | null
  }>
}

const groups = async (token: string): Promise<Group[]> =>
  json(await call('GET', `/api/weekly-planning/goals?sessionId=${sessionId}`, token)).groups

const group = async (token: string, listId: string): Promise<Group> => {
  const g = (await groups(token)).find((x) => x.listId === listId)
  if (!g) throw new Error(`group ${listId} not visible`)
  return g
}

const setFocus = (token: string, listId: string, goalId: string | null) =>
  call('PUT', '/api/weekly-planning/goals/focus', token, { sessionId, listId, goalId })

// A SET, not an ordered list: which goals carry the flag is what matters.
const featuredIn = async (listId: string): Promise<Set<string>> => {
  const { query } = await import('../src/platform/db')
  const { rows } = await query<{ id: string }>(
    `select id from goals where goal_list_id = $1 and deleted_at is null and is_featured`,
    [listId]
  )
  return new Set(rows.map((r) => r.id))
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
  householdId = json(setup).household.id
  kevinId = json(setup).person.id

  const { query } = await import('../src/platform/db')
  const identify = async (personId: string, sub: string) =>
    query(
      `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password',$3,true)`,
      [householdId, personId, sub]
    )
  await identify(kevinId, 'dev|kevin')

  kellyId = json(await call('POST', '/api/persons', kevin, { name: 'Kelly', memberType: 'adult' })).person.id
  // Born 9 years and a month ago, so "age 9" is true whenever this test runs.
  const nineYearsAgo = new Date(Date.now() - (9 * 365 + 32) * 864e5).toISOString().slice(0, 10)
  lottieId = json(await call('POST', '/api/persons', kevin, { name: 'Lottie', memberType: 'kid', birthday: nineYearsAgo })).person.id
  await identify(kellyId, 'dev|kelly')
  await identify(lottieId, 'dev|lottie')

  // 🏡 Family — everyone. 💛 Mom & Dad — the couple's PRIVATE list. Lottie — hers.
  familyList = json(await call('POST', '/api/goal-lists', kevin, {
    name: 'Family', emoji: '🏡', memberIds: [kevinId, kellyId, lottieId],
  })).list.id
  coupleList = json(await call('POST', '/api/goal-lists', kevin, {
    name: 'Mom & Dad', emoji: '💛', isPrivate: true, memberIds: [kevinId, kellyId],
  })).list.id
  lottieList = json(await call('POST', '/api/goal-lists', kevin, {
    name: 'Lottie', emoji: '🦊', memberIds: [lottieId],
  })).list.id
  paceList = json(await call('POST', '/api/goal-lists', kevin, {
    name: 'Pace', emoji: '⏱️', memberIds: [kevinId, kellyId, lottieId],
  })).list.id

  const goal = async (body: Record<string, unknown>) => json(await call('POST', '/api/goals', kevin, body)).goal.id
  // A habit (this period's count) and a checklist (steps) so the read carries what the
  // shared display helper needs for BOTH axes.
  gWater = await goal({
    title: 'Water the garden', goalListId: familyList, goalType: 'habit', habitPeriod: 'week',
    habitTargetPerPeriod: 3, trackingMode: 'each_tracks', participantIds: [kevinId, kellyId, lottieId],
  })
  gWalk = await goal({
    title: 'Walk after dinner', goalListId: familyList, goalType: 'habit', habitPeriod: 'week',
    habitTargetPerPeriod: 5, trackingMode: 'each_tracks', participantIds: [kevinId, kellyId],
  })
  gDate = await goal({
    title: 'Date night', goalListId: coupleList, goalType: 'count', unit: 'nights', targetValue: 12,
    trackingMode: 'shared_total', participantIds: [kevinId, kellyId],
  })
  gReading = await goal({
    title: 'Finish the dragon book', goalListId: lottieList, goalType: 'checklist',
    trackingMode: 'each_tracks', participantIds: [lottieId], steps: [{ label: 'Part one' }, { label: 'Part two' }],
  })
  // Pinned by hand BEFORE any session existed. `is_featured` is that "Pinned" tier, and
  // the planning step must not silently undo it.
  gPinned = await goal({
    title: 'Learn to whistle', goalListId: familyList, goalType: 'count', unit: 'tries',
    targetValue: 50, trackingMode: 'shared_total', isFeatured: true, participantIds: [kevinId],
  })

  // ── Pace fixtures ─────────────────────────────────────────────────────────
  const total = (title: string, unit: string) => goal({
    title, goalListId: paceList, goalType: 'total', unit, targetValue: 100,
    trackingMode: 'shared_total', participantIds: [kevinId],
  })
  gNever = await total('Never touched', 'hours')
  gStalled = await total('Went quiet', 'hours')
  gGone = await total('Long forgotten', 'hours')
  gWeek = await total('Time outside', 'hours')
  gCadence = await goal({
    title: 'Read a book', goalListId: paceList, goalType: 'total', unit: 'books',
    targetValue: 12, trackingMode: 'shared_total', participantIds: [kevinId],
  })
  gHabit = await goal({
    title: 'Walk the dog', goalListId: paceList, goalType: 'habit', habitPeriod: 'week',
    habitTargetPerPeriod: 5, trackingMode: 'each_tracks', participantIds: [kevinId],
  })

  // Logs are inserted with explicit timestamps: "stalled since Aug 14" and "2 of 5 last
  // week" cannot be produced by the logging endpoint, which always writes `now()`.
  // `atSql` is evaluated against the household row, so the habit windows share the
  // service's anchor.
  const logAt = (goalId: string, amount: number, atSql: string) =>
    query(
      `insert into goal_logs (household_id, goal_id, amount, logged_at)
       select h.id, $2::uuid, $3::numeric, ${atSql} from households h where h.id = $1`,
      [householdId, goalId, amount]
    )
  await logAt(gStalled, 4, `now() - interval '10 days'`)
  await logAt(gGone, 4, `now() - interval '25 days'`)
  await logAt(gWeek, 5, `now() - interval '3 days'`)
  await logAt(gWeek, 3, `now() - interval '1 day'`)
  await logAt(gCadence, 2, `now() - interval '70 days'`)
  await logAt(gCadence, 1, `now() - interval '2 days'`)
  // Two distinct days in the PREVIOUS household week, plus one in the current week so
  // the goal doesn't read as stalled. Anchored to a week START, not a day count, so it
  // lands in the right week whatever weekday the suite runs on — and to the HOUSEHOLD's
  // week (`week_start`, default sunday), never `date_trunc('week', …)`, which is
  // Monday-only. A fixture that shares the code's mistake cannot catch it.
  const weekStartSql = `((now() at time zone h.timezone)::date`
    + ` - ((extract(dow from (now() at time zone h.timezone))::int`
    + `     - case when h.week_start = 'monday' then 1 else 0 end + 7) % 7))`
  await logAt(gHabit, 1, `(${weekStartSql} - interval '1 day') at time zone h.timezone`)
  await logAt(gHabit, 1, `(${weekStartSql} - interval '2 days') at time zone h.timezone`)
  await logAt(gHabit, 1, `(${weekStartSql} + interval '2 hours') at time zone h.timezone`)

  await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: true })
  sessionId = json(await call('POST', '/api/weekly-planning/session', kevin)).session.id
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('weekly planning · goals · the gate', () => {
  it('403s when the weeklyPlanning module is off', async () => {
    await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: false })
    expect((await call('GET', `/api/weekly-planning/goals?sessionId=${sessionId}`, kevin)).statusCode).toBe(403)
    expect((await setFocus(kevin, familyList, gWater)).statusCode).toBe(403)
    await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: true })
  })

  it('403s when the goals module the step reads is off', async () => {
    await call('PATCH', '/api/household/modules', kevin, { goals: false })
    expect((await call('GET', `/api/weekly-planning/goals?sessionId=${sessionId}`, kevin)).statusCode).toBe(403)
    await call('PATCH', '/api/household/modules', kevin, { goals: true })
    expect((await call('GET', `/api/weekly-planning/goals?sessionId=${sessionId}`, kevin)).statusCode).toBe(200)
  })
})

describe('weekly planning · goals · the read', () => {
  it('is one group per goal list, with each list’s goals and the numbers the display axis needs', async () => {
    const all = await groups(kevin)
    expect(all.map((g) => g.name)).toEqual(['Family', 'Mom & Dad', 'Lottie', 'Pace'])

    const family = all.find((g) => g.listId === familyList)!
    expect(family.goals.map((g) => g.title).sort()).toEqual(['Learn to whistle', 'Walk after dinner', 'Water the garden'])
    // A habit is shown on THIS period's count, a checklist on its steps — so both fields
    // have to arrive, not just the lifetime total.
    const water = family.goals.find((g) => g.id === gWater)!
    expect(water.goalType).toBe('habit')
    expect(water.periodDone).toBe(0)
    const reading = (await group(kevin, lottieList)).goals.find((g) => g.id === gReading)!
    expect(reading.stepTotal).toBe(2)
    expect(reading.stepDone).toBe(0)
  })

  it('has nothing settled before the session decides anything', async () => {
    for (const g of await groups(kevin)) expect(g.settled).toBe(false)
    expect((await group(kevin, coupleList)).focusGoalId).toBe(null)
    expect((await group(kevin, paceList)).focusGoalId).toBe(null)
  })

  // What closes the "＋ New goal for this week" round trip. The editor creates the goal
  // already featured (?featured=1), so the step must show it as the group's focus rather
  // than making the family pick it a second time.
  it('shows a list’s single already-featured goal as its focus, without claiming the group settled', async () => {
    const family = await group(kevin, familyList)
    expect(family.focusGoalId).toBe(gPinned)
    expect(family.settled).toBe(false)
  })

  it('adopts nothing when a list has two pins — the family chose those, not the session', async () => {
    const { query } = await import('../src/platform/db')
    await query(`update goals set is_featured = true where id = $1`, [gWater])
    const family = await group(kevin, familyList)
    expect(family.focusGoalId).toBe(null)
    expect(family.settled).toBe(false)
    await query(`update goals set is_featured = false where id = $1`, [gWater])
  })

  it('flags the private list so the tab can wear its lock', async () => {
    expect((await group(kevin, coupleList)).isPrivate).toBe(true)
    expect((await group(kevin, familyList)).isPrivate).toBe(false)
  })

  it('carries what the group card’s header has to say about the group', async () => {
    expect((await group(kevin, familyList)).isEveryone).toBe(true)
    expect((await group(kevin, coupleList)).isEveryone).toBe(false)
    // "individual · age 9" needs the member's age; a member with no birthday reads null
    // and the sub line omits it.
    const lottie = await group(kevin, lottieList)
    expect(lottie.members).toHaveLength(1)
    expect(lottie.members[0].age).toBe(9)
    expect((await group(kevin, coupleList)).members.find((m) => m.name === 'Kevin')!.age).toBe(null)
  })
})

// The second half of a goal row's subtitle — how the goal is actually GOING, in a
// sentence, with one of three tones. Every one is derived from real logged activity.
describe('weekly planning · goals · pace', () => {
  const paceOf = async (goalId: string) => {
    const g = (await group(kevin, paceList)).goals.find((x) => x.id === goalId)
    return g?.pace ?? null
  }

  it('says so plainly when a goal has never been logged', async () => {
    expect(await paceOf(gNever)).toEqual({ text: 'nothing logged yet', tone: 'behind' })
  })

  it('names the day a goal stalled', async () => {
    const p = await paceOf(gStalled)
    expect(p!.tone).toBe('behind')
    expect(p!.text).toMatch(/^stalled since [A-Z][a-z]{2} \d{1,2}$/)
  })

  it('counts the weeks once a goal has been quiet for three or more', async () => {
    expect(await paceOf(gGone)).toEqual({ text: 'nothing logged in 3 weeks', tone: 'behind' })
  })

  it('reads a recently-worked goal as last week’s amount, in its own unit', async () => {
    expect(await paceOf(gWeek)).toEqual({ text: '8 hours last week', tone: 'ok' })
  })

  // WHICH WEEK "LAST WEEK" IS — the household's, not Postgres's. `prev_period_days` must
  // derive the week from `households.week_start` (default **sunday**), never bare
  // `date_trunc('week', …)`, which is MONDAY-only.
  //
  // The habit fixture above cannot catch that: it anchors its own logs with the same
  // expression, so it reads correctly under either rule. This one pins the log to a REAL
  // calendar Sunday and then flips the household's setting — under the bug the answer
  // does not move when the setting does. (On a Sunday run both rules agree, so the first
  // assertion is never wrong, just less sharp; pinning `now()` is not available to us in
  // SQL.)
  it('reads “last week” off the household’s week_start, not Postgres’s Monday', async () => {
    const { query } = await import('../src/platform/db')
    const gRule = json(await call('POST', '/api/goals', kevin, {
      title: 'Stretch', goalListId: paceList, goalType: 'habit', habitPeriod: 'week',
      habitTargetPerPeriod: 5, trackingMode: 'each_tracks', participantIds: [kevinId],
    })).goal.id as string

    // This week's SUNDAY, always — `today - dow`, independent of any household setting.
    const thisSunday = `((now() at time zone h.timezone)::date - (extract(dow from (now() at time zone h.timezone))::int))`
    await query(
      `insert into goal_logs (household_id, goal_id, amount, logged_at)
       select h.id, $2::uuid, 1, (${thisSunday} + interval '3 hours') at time zone h.timezone
         from households h where h.id = $1`,
      [householdId, gRule]
    )
    const paceFor = async () => {
      const g = (await group(kevin, paceList)).goals.find((x) => x.id === gRule)
      return g?.pace?.text
    }

    // Sunday-start household: that log is THIS week, so last week saw nothing.
    await query(`update households set week_start = 'sunday' where id = $1`, [householdId])
    expect(await paceFor()).toBe('0 of 5 last week')

    // Monday-start household: the very same log now belongs to the week that just ended.
    await query(`update households set week_start = 'monday' where id = $1`, [householdId])
    expect(await paceFor()).toBe('1 of 5 last week')

    await query(`update households set week_start = 'sunday' where id = $1`, [householdId])
  })

  it('measures a habit against the cadence it set itself, on last period’s count', async () => {
    expect(await paceOf(gHabit)).toEqual({ text: '2 of 5 last week', tone: 'behind' })
  })

  it('reads a long, sparse goal as a monthly cadence rather than weekly noise', async () => {
    const p = await paceOf(gCadence)
    expect(p!.tone).toBe('flat')
    expect(p!.text).toMatch(/^roughly [\d.,]+ books a month$/)
  })
})

describe('weekly planning · goals · picking a focus', () => {
  it('sets the goal’s existing is_featured flag and marks the group settled', async () => {
    expect((await setFocus(kevin, familyList, gWater)).statusCode).toBe(200)
    expect(await featuredIn(familyList)).toEqual(new Set([gPinned, gWater]))

    const family = await group(kevin, familyList)
    expect(family.settled).toBe(true)
    expect(family.focusGoalId).toBe(gWater)
    expect(family.goals.find((g) => g.id === gWater)!.isFeatured).toBe(true)
  })

  it('holds only ONE focus per list — changing it un-features the last focus', async () => {
    expect((await setFocus(kevin, familyList, gWalk)).statusCode).toBe(200)
    expect(await featuredIn(familyList)).toEqual(new Set([gPinned, gWalk]))
    expect((await group(kevin, familyList)).focusGoalId).toBe(gWalk)
    // The goal it replaced is no longer featured — the session's own pick is the only
    // flag it manages.
    expect((await group(kevin, familyList)).goals.find((g) => g.id === gWater)!.isFeatured).toBe(false)
  })

  // The previous focus is un-featured by ID, not by a blanket clear: `is_featured` is
  // the goals screen's "Pinned" tier, which is not one-per-list there, so wiping the
  // list would un-pin goals a family pinned on purpose.
  it('never un-pins a goal the session didn’t pin — a pre-existing pin survives', async () => {
    expect((await group(kevin, familyList)).goals.find((g) => g.id === gPinned)!.isFeatured).toBe(true)
    await setFocus(kevin, familyList, gWater)
    await setFocus(kevin, familyList, gWalk)
    await setFocus(kevin, familyList, null)
    expect(await featuredIn(familyList)).toEqual(new Set([gPinned]))
    expect((await group(kevin, familyList)).goals.find((g) => g.id === gPinned)!.isFeatured).toBe(true)
  })

  it('leaves the other lists alone — the un-feature is scoped by goal list', async () => {
    await setFocus(kevin, lottieList, gReading)
    await setFocus(kevin, familyList, gWater)
    expect(await featuredIn(lottieList)).toEqual(new Set([gReading]))
    expect(await featuredIn(familyList)).toEqual(new Set([gPinned, gWater]))
  })

  it('takes "nothing this week" as a real answer: no focus featured, group still settled', async () => {
    expect((await setFocus(kevin, familyList, null)).statusCode).toBe(200)
    expect(await featuredIn(familyList)).toEqual(new Set([gPinned]))
    const family = await group(kevin, familyList)
    expect(family.settled).toBe(true)     // ★ on the tab
    expect(family.focusGoalId).toBe(null) // …and it decided on nothing
    await setFocus(kevin, familyList, gWalk)
    expect((await group(kevin, familyList)).focusGoalId).toBe(gWalk)
  })

  it('refuses a goal that is not in the list being answered', async () => {
    const res = await setFocus(kevin, familyList, gReading)
    expect(res.statusCode).toBe(404)
    expect(await featuredIn(familyList)).toEqual(new Set([gPinned, gWalk]))
  })

  it('404s on a session that is not this household’s', async () => {
    const res = await call('PUT', '/api/weekly-planning/goals/focus', kevin, {
      sessionId: '11111111-1111-1111-1111-111111111111', listId: familyList, goalId: gWater,
    })
    expect(res.statusCode).toBe(404)
  })

  it('keeps what it decided on the session record, so the recap can read it', async () => {
    await setFocus(kevin, familyList, gWater)
    await setFocus(kevin, coupleList, null)
    const view = json(await call('GET', '/api/weekly-planning', kevin))
    const step = view.steps.find((s: { key: string }) => s.key === 'goals')
    expect(step.data.focus).toEqual({ [familyList]: gWater, [coupleList]: null, [lottieList]: gReading })
    expect(step.status).toBe('pending')
  })
})

describe('weekly planning · goals · privacy', () => {
  it('does not show the couple’s private list to someone outside it', async () => {
    const mine = await groups(lottie)
    expect(mine.map((g) => g.name)).toEqual(['Family', 'Lottie', 'Pace'])
    expect(mine.some((g) => g.listId === coupleList)).toBe(false)
    expect(mine.flatMap((g) => g.goals).some((g) => g.id === gDate)).toBe(false)
  })

  it('shows it to its own members', async () => {
    expect((await groups(kelly)).map((g) => g.listId)).toContain(coupleList)
    expect((await groups(kevin)).map((g) => g.listId)).toContain(coupleList)
  })

  it('404s a focus write on a private list the caller is not in — hiding it is not enough', async () => {
    const before = await featuredIn(coupleList)
    expect((await setFocus(lottie, coupleList, gDate)).statusCode).toBe(404)
    expect(await featuredIn(coupleList)).toEqual(before)
  })

  it('gives an admin no bypass — membership is the whole rule', async () => {
    // Rebuild the private list without Kevin: being the household owner must not be a
    // way into his partner's private group.
    await call('PATCH', `/api/goal-lists/${coupleList}`, kevin, { memberIds: [kellyId] })
    expect((await groups(kevin)).some((g) => g.listId === coupleList)).toBe(false)
    expect((await setFocus(kevin, coupleList, gDate)).statusCode).toBe(404)
    expect((await groups(kelly)).some((g) => g.listId === coupleList)).toBe(true)
    await call('PATCH', `/api/goal-lists/${coupleList}`, kevin, { memberIds: [kevinId, kellyId] })
  })
})
