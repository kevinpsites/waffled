// Weekly Planning · step 8 (Tasks) — "Who's doing what?"
//
// A read over CHORE DEFINITIONS, not instances: an instance is one day, the session plans a
// week, and reading a week would side-effect-materialize seven days. The step stores nothing
// of its own — every write goes through the chores endpoints.
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
let ownerId: string
let wallyId: string
let lottieId: string

function mint(sub: string): string {
  return jwt.sign({}, SECRET, { algorithm: 'HS256', subject: sub, issuer: 'waffled-local', audience: 'waffled-api', expiresIn: '1h' })
}

// lambda-api reads the query off `queryStringParameters`, NOT off the path.
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

interface BoardChore { id: string; title: string; cadence: string; days: string[]; dueOn: string | null; carriedOver: boolean; pendingInstanceIds: string[]; requiresApproval: boolean; requiresPhoto: boolean }
interface BoardPerson { id: string; name: string; recurringChores: number; chores: BoardChore[] }
interface Board { weekStart: string; newTaskDay: string; people: BoardPerson[]; unassigned: BoardChore[] }
const board = async () => json(await call('GET', '/api/weekly-planning/tasks', kevin)) as Board
const strip = (b: { unassigned: BoardChore[] }) => b.unassigned.map((c) => c.title)
const who = (b: { people: BoardPerson[] }, name: string) => b.people.find((p) => p.name === name)!

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
  ownerId = json(setup).person.id
  const { query } = await import('../src/platform/db')
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [householdId, ownerId]
  )
  // One column per member, so seed the people directly — /api/persons doesn't create logins.
  const kids = await query<{ id: string; name: string }>(
    `insert into persons (household_id, name, member_type, sort_order)
     values ($1,'Wally','kid',1), ($1,'Lottie','kid',2) returning id, name`,
    [householdId]
  )
  wallyId = kids.rows.find((r) => r.name === 'Wally')!.id
  lottieId = kids.rows.find((r) => r.name === 'Lottie')!.id
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

describe('planning · tasks · gating', () => {
  it('403s while the weeklyPlanning module is off', async () => {
    expect((await call('GET', '/api/weekly-planning/tasks', kevin)).statusCode).toBe(403)
  })

  it('403s when chores — the module this step reads — is off', async () => {
    expect((await call('PATCH', '/api/household/modules', kevin, { weeklyPlanning: true })).statusCode).toBe(200)
    await call('PATCH', '/api/household/modules', kevin, { chores: false })
    expect((await call('GET', '/api/weekly-planning/tasks', kevin)).statusCode).toBe(403)
    await call('PATCH', '/api/household/modules', kevin, { chores: true })
    expect((await call('GET', '/api/weekly-planning/tasks', kevin)).statusCode).toBe(200)
  })
})

describe('planning · tasks · the board', () => {
  it('gives every member a column and states the recurring load they already carry', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Feed the dog', personId: wallyId, rrule: 'FREQ=DAILY' })
    await call('POST', '/api/chores', kevin, { title: 'Trash out', personId: wallyId, rrule: 'FREQ=WEEKLY;BYDAY=TU' })
    await call('POST', '/api/chores', kevin, { title: 'Water plants', personId: lottieId, rrule: 'FREQ=WEEKLY;BYDAY=SA' })
    // A one-off is not a standing commitment, so it must not inflate the footer.
    await call('POST', '/api/chores', kevin, { title: 'Post the letter', personId: lottieId, rrule: null })

    const b = await board()
    expect(b.people.map((p) => p.name)).toEqual(['Kevin', 'Wally', 'Lottie'])
    expect(who(b, 'Wally').recurringChores).toBe(2)
    expect(who(b, 'Lottie').recurringChores).toBe(1)
    expect(who(b, 'Kevin').recurringChores).toBe(0)
  })

  it('puts everything unassigned in the strip, with the cadence it repeats on', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Sweep the porch', personId: null, rrule: 'FREQ=WEEKLY;BYDAY=SU' })
    await call('POST', '/api/chores', kevin, { title: 'Fold the towels', personId: null, rrule: 'FREQ=DAILY' })

    const b = await board()
    expect(strip(b)).toEqual(expect.arrayContaining(['Sweep the porch', 'Fold the towels']))
    expect(b.unassigned.find((c) => c.title === 'Sweep the porch')!.cadence).toBe('weekly')
    expect(b.unassigned.find((c) => c.title === 'Fold the towels')!.cadence).toBe('daily')
    expect(strip(b)).not.toContain('Feed the dog')
  })

  it('tapping a face assigns the chore — it leaves the strip and joins that column', async () => {
    const before = await board()
    const chore = before.unassigned.find((c) => c.title === 'Sweep the porch')!

    expect((await call('PATCH', `/api/chores/${chore.id}`, kevin, { personId: lottieId })).statusCode).toBe(200)

    const after = await board()
    expect(strip(after)).not.toContain('Sweep the porch')
    expect(who(after, 'Lottie').recurringChores).toBe(who(before, 'Lottie').recurringChores + 1)
  })

  it('nobody is a real answer — the untaken chore survives the pass that assigned the other', async () => {
    // The one nobody took must come back unchanged, not swept up with the one handed over.
    const b = await board()
    expect(strip(b)).not.toContain('Sweep the porch')
    expect(strip(b)).toContain('Fold the towels')
    const { query } = await import('../src/platform/db')
    const { rows } = await query<{ person_id: string | null }>(
      `select person_id from chores where household_id = $1 and title = 'Fold the towels'`,
      [householdId]
    )
    expect(rows[0].person_id).toBe(null)
  })
})

describe('planning · tasks · one-offs already on the kiosk board', () => {
  it('surfaces the pending instance so assigning also fixes the day it already landed on', async () => {
    // A one-off snapshots person_id onto its instance at create time, so PATCHing only the
    // definition leaves the kiosk board showing it up for grabs.
    const created = await call('POST', '/api/chores', kevin, { title: 'Return the library books', personId: null, rrule: null })
    expect(created.statusCode).toBe(201)
    const choreId = json(created).chore.id

    const b = await board()
    const row = b.unassigned.find((c) => c.title === 'Return the library books')!
    expect(row.cadence).toBe('once')
    expect(row.pendingInstanceIds).toEqual([expect.any(String)])

    await call('PATCH', `/api/chores/${choreId}`, kevin, { personId: wallyId })
    expect((await call('POST', `/api/chore-instances/${row.pendingInstanceIds[0]}/assign`, kevin, { personId: wallyId })).statusCode).toBe(200)

    const day = json(await call('GET', '/api/chore-instances/today', kevin))
    const inst = day.instances.find((i: { choreTitle: string }) => i.choreTitle === 'Return the library books')
    expect(inst.personId).toBe(wallyId)
    expect(strip(await board())).not.toContain('Return the library books')
  })

  it('hands back EVERY unclaimed day, not just the first', async () => {
    // Assigning only the earliest of several materialized days leaves the rest up for grabs.
    const created = await call('POST', '/api/chores', kevin, { title: 'Wipe the counters', personId: null, rrule: 'FREQ=DAILY' })
    const choreId = json(created).chore.id
    const soon = (n: number) => {
      const d = new Date()
      d.setUTCDate(d.getUTCDate() + n)
      return d.toISOString().slice(0, 10)
    }
    await call('GET', `/api/chore-instances/today?date=${soon(1)}`, kevin)
    await call('GET', `/api/chore-instances/today?date=${soon(2)}`, kevin)

    const row = (await board()).unassigned.find((c) => c.title === 'Wipe the counters')!
    expect(row.pendingInstanceIds.length).toBeGreaterThanOrEqual(2)

    await call('PATCH', `/api/chores/${choreId}`, kevin, { personId: lottieId })
    for (const id of row.pendingInstanceIds) {
      expect((await call('POST', `/api/chore-instances/${id}/assign`, kevin, { personId: lottieId })).statusCode).toBe(200)
    }

    for (const d of [soon(1), soon(2)]) {
      const day = json(await call('GET', `/api/chore-instances/today?date=${d}`, kevin))
      expect(day.instances.find((i: { choreTitle: string }) => i.choreTitle === 'Wipe the counters').personId).toBe(lottieId)
    }
  })

  it('does the same for a recurring chore whose instance for today already exists', async () => {
    // Today's instances are already materialized, so handing the chore out fixes today too.
    const b = await board()
    const towels = b.unassigned.find((c) => c.title === 'Fold the towels')!
    expect(towels.cadence).toBe('daily')
    expect(towels.pendingInstanceIds.length).toBeGreaterThan(0)

    await call('PATCH', `/api/chores/${towels.id}`, kevin, { personId: ownerId })
    await call('POST', `/api/chore-instances/${towels.pendingInstanceIds[0]}/assign`, kevin, { personId: ownerId })

    const day = json(await call('GET', '/api/chore-instances/today', kevin))
    expect(day.instances.find((i: { choreTitle: string }) => i.choreTitle === 'Fold the towels').personId).toBe(ownerId)
    const after = await board()
    expect(strip(after)).not.toContain('Fold the towels')
    expect(who(after, 'Kevin').recurringChores).toBe(1)
  })
})

// A column is what someone is CARRYING — from the chores they own, not from what this
// sitting moved. That is what makes the board survive a refresh.
describe('planning · tasks · the week each person is carrying', () => {
  let weekStart: string
  // Nth day of the planned week (0 = the week start), as a plain UTC date.
  const day = (n: number) => {
    const d = new Date(`${weekStart}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + n)
    return d.toISOString().slice(0, 10)
  }
  const held = (b: { people: BoardPerson[] }, name: string) => who(b, name).chores

  it('names the week it resolved, and snaps a mid-week date to that week’s start', async () => {
    const b = await board()
    weekStart = b.weekStart
    expect(weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // The server owns the boundary: naming a week's Wednesday must not key the board to one.
    const mid = json(await call('GET', `/api/weekly-planning/tasks?weekStart=${day(3)}`, kevin))
    expect(mid.weekStart).toBe(weekStart)
  })

  it('fills a column from what that person holds, with the days each chore lands on', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Vacuum upstairs', personId: lottieId, rrule: `FREQ=WEEKLY;BYDAY=${['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(`${day(3)}T00:00:00Z`).getUTCDay()]}` })
    await call('POST', '/api/chores', kevin, { title: 'Dishes', personId: lottieId, rrule: 'FREQ=DAILY' })
    await call('POST', '/api/chores', kevin, { title: 'Gift for the party', personId: lottieId, rrule: null, dueOn: day(5) })

    const mine = held(await board(), 'Lottie')
    const titles = mine.map((c) => c.title)
    expect(titles).toEqual(expect.arrayContaining(['Vacuum upstairs', 'Dishes', 'Gift for the party']))
    expect(mine.find((c) => c.title === 'Vacuum upstairs')!.days).toEqual([day(3)])
    expect(mine.find((c) => c.title === 'Dishes')!.days).toHaveLength(7)
    expect(mine.find((c) => c.title === 'Gift for the party')!.days).toEqual([day(5)])
    expect(mine.length).toBe(titles.length)
  })

  it('leaves out a one-off that belongs to a different week', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Renew the passport', personId: lottieId, rrule: null, dueOn: day(30) })
    expect(held(await board(), 'Lottie').map((c) => c.title)).not.toContain('Renew the passport')
    const later = json(await call('GET', `/api/weekly-planning/tasks?weekStart=${day(28)}`, kevin))
    expect(later.weekStart).toBe(day(28))
    const lottie = later.people.find((p: BoardPerson) => p.name === 'Lottie')
    expect(lottie.chores.map((c: BoardChore) => c.title)).toContain('Renew the passport')
  })

  it('the column is the week, not the sitting — a fresh read shows what was handed out', async () => {
    const created = await call('POST', '/api/chores', kevin, { title: 'Garage sweep', personId: null, rrule: null, dueOn: day(2) })
    const choreId = json(created).chore.id
    expect(strip(await board())).toContain('Garage sweep')

    await call('PATCH', `/api/chores/${choreId}`, kevin, { personId: wallyId })

    const fresh = await board()
    const wally = held(fresh, 'Wally').find((c) => c.title === 'Garage sweep')!
    expect(wally.days).toEqual([day(2)])
    expect(strip(fresh)).not.toContain('Garage sweep')
  })

  it('a chore carried over from before the week arrives without a day of its own', async () => {
    const { query } = await import('../src/platform/db')
    const created = await call('POST', '/api/chores', kevin, { title: 'Fix the gate', personId: wallyId, rrule: null, dueOn: day(0) })
    // Backdate to a day that has genuinely PASSED, relative to TODAY: the planned week can
    // start six days out, so "before the week" would include days still ahead.
    const past = new Date()
    past.setUTCDate(past.getUTCDate() - 5)
    await query(`update chore_instances set due_on = $2::date where chore_id = $1`, [
      json(created).chore.id,
      past.toISOString().slice(0, 10),
    ])

    const gate = held(await board(), 'Wally').find((c) => c.title === 'Fix the gate')!
    expect(gate.carriedOver).toBe(true)
    expect(gate.days).toEqual([])
  })
})

// Handing a chore over has to be REVERSIBLE and the kiosk board must never disagree: every
// already-materialized pending day follows the change in BOTH directions, which is why the
// board hands those days back for an owned chore too.
describe('planning · tasks · handing a chore out is reversible', () => {
  const soon = (n: number) => {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() + n)
    return d.toISOString().slice(0, 10)
  }
  const dayOwner = async (date: string, title: string) => {
    const day = json(await call('GET', `/api/chore-instances/today?date=${date}`, kevin))
    return day.instances.find((i: { choreTitle: string }) => i.choreTitle === title)?.personId ?? null
  }

  it('takes a chore back off someone — every pending day follows, both ways', async () => {
    const created = await call('POST', '/api/chores', kevin, { title: 'Sort the recycling', personId: null, rrule: 'FREQ=DAILY' })
    const choreId = json(created).chore.id
    await call('GET', `/api/chore-instances/today?date=${soon(1)}`, kevin)
    await call('GET', `/api/chore-instances/today?date=${soon(2)}`, kevin)

    const offered = (await board()).unassigned.find((c) => c.title === 'Sort the recycling')!
    expect(offered.pendingInstanceIds.length).toBeGreaterThanOrEqual(2)
    await call('PATCH', `/api/chores/${choreId}`, kevin, { personId: wallyId })
    for (const id of offered.pendingInstanceIds) {
      await call('POST', `/api/chore-instances/${id}/assign`, kevin, { personId: wallyId })
    }
    expect(await dayOwner(soon(1), 'Sort the recycling')).toBe(wallyId)
    expect(await dayOwner(soon(2), 'Sort the recycling')).toBe(wallyId)

    // THE UNDO: the board hands back the pending days of an owned chore.
    const held = who(await board(), 'Wally').chores.find((c) => c.title === 'Sort the recycling')!
    expect(held.pendingInstanceIds.length).toBeGreaterThanOrEqual(2)
    expect((await call('PATCH', `/api/chores/${choreId}`, kevin, { personId: null })).statusCode).toBe(200)
    for (const id of held.pendingInstanceIds) {
      expect((await call('POST', `/api/chore-instances/${id}/assign`, kevin, { personId: null })).statusCode).toBe(200)
    }

    expect(strip(await board())).toContain('Sort the recycling')
    expect(await dayOwner(soon(1), 'Sort the recycling')).toBe(null)
    expect(await dayOwner(soon(2), 'Sort the recycling')).toBe(null)
  })

  it('hands one straight on to somebody else, days and all', async () => {
    const created = await call('POST', '/api/chores', kevin, { title: 'Rake the leaves', personId: wallyId, rrule: 'FREQ=DAILY' })
    const choreId = json(created).chore.id
    await call('GET', `/api/chore-instances/today?date=${soon(3)}`, kevin)

    const held = who(await board(), 'Wally').chores.find((c) => c.title === 'Rake the leaves')!
    expect(held.pendingInstanceIds.length).toBeGreaterThan(0)
    await call('PATCH', `/api/chores/${choreId}`, kevin, { personId: lottieId })
    for (const id of held.pendingInstanceIds) {
      await call('POST', `/api/chore-instances/${id}/assign`, kevin, { personId: lottieId })
    }

    expect(await dayOwner(soon(3), 'Rake the leaves')).toBe(lottieId)
    const after = await board()
    expect(who(after, 'Wally').chores.map((c) => c.title)).not.toContain('Rake the leaves')
    expect(who(after, 'Lottie').chores.map((c) => c.title)).toContain('Rake the leaves')
  })
})

// "Carried over" means a day that has actually PASSED with the task still open.
describe('planning · tasks · a brand-new task is not carried over', () => {
  it('a one-off created today says when it is for, not that it was left behind', async () => {
    const created = await call('POST', '/api/chores', kevin, { title: 'Book the sitter', personId: wallyId, rrule: null })
    expect(created.statusCode).toBe(201)

    const card = who(await board(), 'Wally').chores.find((c) => c.title === 'Book the sitter')
    expect(card).toBeTruthy()
    expect(card!.carriedOver).toBe(false)
    expect(card!.dueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('and one nobody has taken says the same in the strip', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Ring the plumber', personId: null, rrule: null })
    expect((await board()).unassigned.find((c) => c.title === 'Ring the plumber')!.carriedOver).toBe(false)
  })
})

// A one-off's day lives on its single pending INSTANCE, so moving it is a `dueOn` patch.
describe('planning · tasks · setting the day on a task', () => {
  const day = async (n: number) => {
    const d = new Date(`${(await board()).weekStart}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + n)
    return d.toISOString().slice(0, 10)
  }

  it('moves a one-off onto a day of the planned week', async () => {
    const created = await call('POST', '/api/chores', kevin, { title: 'Drop the parcel', personId: wallyId, rrule: null })
    const choreId = json(created).chore.id
    const target = await day(2)

    expect((await call('PATCH', `/api/chores/${choreId}`, kevin, { dueOn: target })).statusCode).toBe(200)

    const card = who(await board(), 'Wally').chores.find((c) => c.title === 'Drop the parcel')!
    expect(card.days).toEqual([target])
    expect(card.dueOn).toBe(target)
  })

  it('refuses a date that isn’t one', async () => {
    const created = await call('POST', '/api/chores', kevin, { title: 'Sharpen the knives', personId: wallyId, rrule: null })
    expect((await call('PATCH', `/api/chores/${json(created).chore.id}`, kevin, { dueOn: 'someday' })).statusCode).toBe(400)
  })

  it('never rewrites a day somebody already finished', async () => {
    const created = await call('POST', '/api/chores', kevin, { title: 'Wash the car', personId: wallyId, rrule: null })
    const choreId = json(created).chore.id
    const { query } = await import('../src/platform/db')
    const before = await query<{ id: string; due_on: string }>(
      `select id, due_on::text as due_on from chore_instances where chore_id = $1`,
      [choreId]
    )
    await call('POST', `/api/chore-instances/${before.rows[0].id}/complete`, kevin, {})

    await call('PATCH', `/api/chores/${choreId}`, kevin, { dueOn: await day(4) })

    const after = await query<{ due_on: string; status: string }>(
      `select due_on::text as due_on, status from chore_instances where id = $1`,
      [before.rows[0].id]
    )
    expect(after.rows[0].status).not.toBe('pending')
    expect(after.rows[0].due_on).toBe(before.rows[0].due_on)
  })
})

describe('planning · tasks · the step decision', () => {
  it('records counts, not a copy of the chores it handed out', async () => {
    const start = await call('POST', '/api/weekly-planning/session', kevin, {})
    const sessionId = json(start).session.id
    const res = await call('POST', `/api/weekly-planning/session/${sessionId}/step`, kevin, {
      stepKey: 'tasks',
      status: 'done',
      data: { assigned: 2, leftUpForGrabs: 1 },
    })
    expect(res.statusCode).toBe(200)
    const step = json(res).steps.find((s: { key: string }) => s.key === 'tasks')
    expect(step.status).toBe('done')
    expect(step.data).toEqual({ assigned: 2, leftUpForGrabs: 1 })
  })
})

// A task added DURING the session belongs to the week being planned; the boundary and
// "today" are both the server's.
describe('planning · tasks · the day a new task lands on', () => {
  const householdToday = async () => {
    const { query } = await import('../src/platform/db')
    const { rows } = await query<{ d: string }>(
      `select (now() at time zone h.timezone)::date::text as d from households h where h.id = $1`,
      [householdId]
    )
    return rows[0].d
  }

  it('is the start of the week when that week is still ahead of us', async () => {
    const b = await board()
    const d = new Date(`${b.weekStart}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + 28)
    const far = json(await call('GET', `/api/weekly-planning/tasks?weekStart=${d.toISOString().slice(0, 10)}`, kevin)) as Board
    expect(far.newTaskDay).toBe(far.weekStart)
  })

  it('is today when the session is planning the week today falls in', async () => {
    const today = await householdToday()
    const now = json(await call('GET', `/api/weekly-planning/tasks?weekStart=${today}`, kevin)) as Board
    expect(now.newTaskDay).toBe(today)
    expect(now.newTaskDay >= now.weekStart).toBe(true)
  })

  it('always lands inside the week it names', async () => {
    const b = await board()
    const end = new Date(`${b.weekStart}T00:00:00Z`)
    end.setUTCDate(end.getUTCDate() + 6)
    expect(b.newTaskDay >= b.weekStart).toBe(true)
    expect(b.newTaskDay <= end.toISOString().slice(0, 10)).toBe(true)
  })
})

// The card doesn't draw those flags but the chore editor opened from it does, and a client
// that can't see a flag can only send it back as false.
describe('planning · tasks · what the card can be edited from', () => {
  it('carries the flags the editor prefills, not just the ones it draws', async () => {
    const created = await call('POST', '/api/chores', kevin, {
      title: 'Scrub the tub', personId: lottieId, rrule: 'FREQ=DAILY',
      requiresApproval: true, requiresPhoto: true,
    })
    expect(created.statusCode).toBe(201)

    const card = who(await board(), 'Lottie').chores.find((c) => c.title === 'Scrub the tub')!
    expect(card.requiresApproval).toBe(true)
    expect(card.requiresPhoto).toBe(true)
  })

  it('and states them false when they are, rather than leaving them out', async () => {
    await call('POST', '/api/chores', kevin, { title: 'Fluff the cushions', personId: null, rrule: null })
    const card = (await board()).unassigned.find((c) => c.title === 'Fluff the cushions')!
    expect(card.requiresApproval).toBe(false)
    expect(card.requiresPhoto).toBe(false)
  })
})
