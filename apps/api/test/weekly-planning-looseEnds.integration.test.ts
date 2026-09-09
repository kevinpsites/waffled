// Weekly Planning · step 1 "Loose ends" — the read over four modules, the ROUTING that is
// the step's whole job, and the two answers allowed to write. Real Postgres.
//
// The load-bearing assertions: an overdue chore is STILL overdue after being routed, and
// the decision lands on the SESSION (`planning_session_steps.data.routes`) where every
// later step reads it. A source module that is off contributes nothing, on the read AND
// the write.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from './helpers/pg'
import jwt from 'jsonwebtoken'
import { runMigrations } from '../src/migrate'

const SECRET = 'waffled-local-dev-secret-change-me'

let pg: StartedPostgreSqlContainer
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any
let closePool: () => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let query: any
let householdId: string
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

interface LooseEnd {
  key: string
  kind: string
  id: string
  title: string
  detail: string | null
  actions: string[]
  owner?: { id: string; name: string; colorHex: string | null; avatarEmoji: string | null } | null
}
interface Destination { to: string; label: string; hint: string; primary?: boolean }
interface Route { kind: string; id: string; title: string; source: string; to: string }
interface LooseEndsPayload {
  weekStart: string
  notDone: LooseEnd[]
  parked: LooseEnd[]
  counts: { notDone: number; parked: number }
  destinations: { notDone: Destination[]; parked: Destination[] }
  routes: Route[]
  sources: string[]
  lists?: { id: string; name: string; emoji: string | null; relevant: boolean }[]
}

const read = async (qs = ''): Promise<LooseEndsPayload> =>
  json(await call('GET', `/api/weekly-planning/loose-ends${qs}`, kevin))

const resolve = (body: unknown) => call('POST', '/api/weekly-planning/loose-ends/resolve', kevin, body)
const route = (body: unknown) => call('POST', '/api/weekly-planning/loose-ends/route', kevin, body)
const park = (body: unknown) => call('POST', '/api/weekly-planning/loose-ends/parked', kevin, body)

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const setModules = (mods: Record<string, boolean>) => call('PATCH', '/api/household/modules', kevin, mods)

let sessionId: string

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16').start()
  const url = pg.getConnectionUri()
  await runMigrations(url)
  process.env.DATABASE_URL = url
  delete process.env.AUTH0_DOMAIN
  app = (await import('../src/app')).default
  const db = await import('../src/platform/db')
  closePool = db.closePool
  query = db.query

  const setup = await call('POST', '/api/auth/setup', undefined, {
    household: { name: 'Sites', timezone: 'America/Chicago' },
    admin: { name: 'Kevin', email: 'kevin@example.com', password: 'ownerpass1' },
  })
  householdId = json(setup).household.id
  ownerId = json(setup).person.id
  await query(
    `insert into identities (household_id, person_id, provider, auth0_user_id, email_verified) values ($1,$2,'password','dev|kevin',true)`,
    [householdId, ownerId]
  )
  // Everything step 1 reads, on. `rhythms` is defaultOn:false, so it has to be asked for.
  await setModules({ weeklyPlanning: true, chores: true, lists: true, goals: true, rhythms: true })
  sessionId = json(await call('POST', '/api/weekly-planning/session', kevin)).session.id
})

afterAll(async () => {
  await closePool?.()
  await pg?.stop()
})

// The household's CURRENT week start — the anchor the list read uses. Not the planned
// week (always >= today, so comparing anything against it filters nothing).
async function currentWeekStart(): Promise<string> {
  return json(await call('GET', '/api/weekly-planning', kevin)).minWeekStart as string
}
async function plannedWeekStart(): Promise<string> {
  return json(await call('GET', '/api/weekly-planning', kevin)).defaultWeekStart as string
}
// The routes as the SHELL serves them — the actual cross-step contract, not our own copy.
async function routesFromSessionView(): Promise<Route[]> {
  const view = json(await call('GET', '/api/weekly-planning', kevin))
  const step = view.steps.find((s: { key: string }) => s.key === 'looseEnds')
  return (step?.data?.routes ?? []) as Route[]
}

describe('loose ends · the module gate', () => {
  it('is behind the weeklyPlanning toggle like the rest of the module', async () => {
    await setModules({ weeklyPlanning: false })
    expect((await call('GET', '/api/weekly-planning/loose-ends', kevin)).statusCode).toBe(403)
    expect((await resolve({ kind: 'parked', id: ownerId, action: 'drop' })).statusCode).toBe(403)
    expect((await route({ sessionId, kind: 'chore', id: ownerId, title: 'x', to: 'tasks' })).statusCode).toBe(403)
    expect((await park({ note: 'x' })).statusCode).toBe(403)
    await setModules({ weeklyPlanning: true })
    expect((await call('GET', '/api/weekly-planning/loose-ends', kevin)).statusCode).toBe(200)
  })

  it('starts empty — nothing is open, so nothing is asked', async () => {
    const p = await read()
    expect(p.notDone).toEqual([])
    expect(p.parked).toEqual([])
    expect(p.counts).toEqual({ notDone: 0, parked: 0 })
    expect(p.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

// ── Destinations ──────────────────────────────────────────────────────────────
describe('loose ends · where a card can send things', () => {
  it('offers the four triage destinations for "not done" and the two verbs for "parked"', async () => {
    const p = await read()
    expect(p.destinations.notDone.map((d) => d.to)).toEqual(['tasks', 'calendar', 'kids', 'goals'])
    expect(p.destinations.notDone[0]).toMatchObject({ to: 'tasks', label: 'Tasks', primary: true })
    expect(p.destinations.notDone[0].hint).toMatch(/owner and a day/i)
    expect(p.destinations.parked.map((d) => d.to)).toEqual(['tasks', 'calendar'])
    expect(p.destinations.parked[0]).toMatchObject({ to: 'tasks', label: 'Make it a task', primary: true })
  })

  it('drops a destination whose step this household is not running', async () => {
    await setModules({ chores: false })
    let p = await read()
    // `tasks` requires chores, so routing there would send things into a step the session
    // skips.
    expect(p.destinations.notDone.map((d) => d.to)).not.toContain('tasks')
    expect(p.destinations.parked.map((d) => d.to)).toEqual(['calendar'])
    expect(p.sources).not.toContain('chores')

    await call('PUT', '/api/weekly-planning/config', kevin, { steps: { kids: false } })
    p = await read()
    expect(p.destinations.notDone.map((d) => d.to)).not.toContain('kids')

    await call('PUT', '/api/weekly-planning/config', kevin, { steps: { kids: true } })
    await setModules({ chores: true })
    expect((await read()).sources).toEqual(['chores', 'lists', 'rhythms', 'goals'])
  })
})

// ── "Not done" · chores ───────────────────────────────────────────────────────
describe('loose ends · overdue chores', () => {
  let choreId: string
  let overdueId: string

  beforeAll(async () => {
    const { rows } = await query(
      `insert into chores (household_id, title, person_id, is_active) values ($1,'Take the bins out',$2,true) returning id`,
      [householdId, ownerId]
    )
    choreId = rows[0].id
    const week = await currentWeekStart()
    const { rows: inst } = await query(
      `insert into chore_instances (household_id, chore_id, person_id, due_on, status)
       values ($1,$2,$3,$4::date,'pending') returning id`,
      [householdId, choreId, ownerId, addDays(week, -9)]
    )
    overdueId = inst[0].id
  })

  it('surfaces an instance whose due date has passed, and says how late it is', async () => {
    const item = (await read()).notDone.find((i) => i.id === overdueId)
    expect(item).toBeTruthy()
    expect(item!.kind).toBe('chore')
    expect(item!.title).toBe('Take the bins out')
    expect(item!.detail).toMatch(/late|overdue|days/i)
    expect(item!.actions).toEqual(['done'])
  })

  it('does NOT surface an instance still to come, or one already answered', async () => {
    const week = await currentWeekStart()
    const { rows: soon } = await query(
      `insert into chore_instances (household_id, chore_id, due_on, status) values ($1,$2,$3::date,'pending') returning id`,
      [householdId, choreId, addDays(week, 20)]
    )
    const { rows: doneRow } = await query(
      `insert into chore_instances (household_id, chore_id, due_on, status) values ($1,$2,$3::date,'done') returning id`,
      [householdId, choreId, addDays(week, -12)]
    )
    const ids = (await read()).notDone.map((i) => i.id)
    expect(ids).not.toContain(soon[0].id)
    expect(ids).not.toContain(doneRow[0].id)
  })

  // THE LOAD-BEARING TEST OF THE WHOLE STEP.
  it('ROUTING CHANGES NOTHING IN THE MODULE — it only records which step handles it', async () => {
    const before = await query(`select * from chore_instances where id = $1`, [overdueId])
    const res = await route({ sessionId, kind: 'chore', id: overdueId, title: 'Take the bins out', source: 'notDone', to: 'tasks' })
    expect(res.statusCode).toBe(200)

    const after = await query(`select * from chore_instances where id = $1`, [overdueId])
    expect(after.rows[0]).toEqual(before.rows[0])

    const { rows } = await query(
      `select data from planning_session_steps where session_id = $1 and step_key = 'looseEnds'`,
      [sessionId]
    )
    expect(rows[0].data.routes).toEqual([
      { kind: 'chore', id: overdueId, title: 'Take the bins out', source: 'notDone', to: 'tasks' },
    ])
    const step = json(await call('GET', '/api/weekly-planning', kevin)).steps.find((s: { key: string }) => s.key === 'looseEnds')
    expect(step.status).toBe('pending')

    expect(await routesFromSessionView()).toHaveLength(1)
    expect((await read(`?sessionId=${sessionId}`)).routes).toHaveLength(1)
    expect((await read()).routes).toEqual([])
  })

  it('re-routing replaces the decision rather than stacking a second one', async () => {
    await route({ sessionId, kind: 'chore', id: overdueId, title: 'Take the bins out', source: 'notDone', to: 'kids' })
    const routes = await routesFromSessionView()
    expect(routes).toHaveLength(1)
    expect(routes[0].to).toBe('kids')
  })

  it('undoes a route with to: null, which is what the trail under the card calls', async () => {
    const res = await route({ sessionId, kind: 'chore', id: overdueId, to: null })
    expect(res.statusCode).toBe(200)
    expect(json(res).routes).toEqual([])
    expect(await routesFromSessionView()).toEqual([])
  })

  // The routes array is a decision LOG, not a queue, so it must never point at something
  // already finished — a later step could not tell without re-reading four modules.
  it('retires an item’s route when it is settled instead', async () => {
    await route({ sessionId, kind: 'chore', id: overdueId, title: 'Take the bins out', source: 'notDone', to: 'tasks' })
    expect(await routesFromSessionView()).toHaveLength(1)
    expect((await resolve({ kind: 'chore', id: overdueId, action: 'done', sessionId })).statusCode).toBe(200)
    expect(await routesFromSessionView()).toEqual([])
    await query(`update chore_instances set status='pending', completed_by=null, completed_at=null where id = $1`, [overdueId])
  })

  it('resolving "It’s done already" completes the INSTANCE — the exception that writes', async () => {
    const res = await resolve({ kind: 'chore', id: overdueId, action: 'done' })
    expect(res.statusCode).toBe(200)
    const { rows } = await query(`select status, completed_by from chore_instances where id = $1`, [overdueId])
    expect(rows[0].status).toBe('done')
    expect(rows[0].completed_by).toBe(ownerId)
    expect((await read()).notDone.map((i) => i.id)).not.toContain(overdueId)
  })

  it('refuses to DROP a computed item — that would delete another module’s data', async () => {
    const week = await currentWeekStart()
    const { rows: late } = await query(
      `insert into chore_instances (household_id, chore_id, due_on, status) values ($1,$2,$3::date,'pending') returning id`,
      [householdId, choreId, addDays(week, -5)]
    )
    expect((await resolve({ kind: 'chore', id: late[0].id, action: 'drop' })).statusCode).toBe(400)
    const { rows } = await query(`select status from chore_instances where id = $1`, [late[0].id])
    expect(rows[0].status).toBe('pending')
    await query(`update chore_instances set deleted_at = now() where id = $1`, [late[0].id])
  })

  it('withholds "it’s done already" from an instance whose chore demands photo proof', async () => {
    const week = await currentWeekStart()
    const { rows: proof } = await query(
      `insert into chore_instances (household_id, chore_id, due_on, status, requires_photo)
       values ($1,$2,$3::date,'pending',true) returning id`,
      [householdId, choreId, addDays(week, -6)]
    )
    const item = (await read()).notDone.find((i) => i.id === proof[0].id)
    expect(item).toBeTruthy()
    // Planning has no camera, so completing here would 500 on ProofRequiredError. It can
    // still be ROUTED — which is the whole point of the step.
    expect(item!.actions).toEqual([])
    expect((await resolve({ kind: 'chore', id: proof[0].id, action: 'done' })).statusCode).toBe(400)
    expect((await route({ sessionId, kind: 'chore', id: proof[0].id, title: 'proof', source: 'notDone', to: 'tasks' })).statusCode).toBe(200)
    await route({ sessionId, kind: 'chore', id: proof[0].id, to: null })
    await query(`update chore_instances set deleted_at = now() where id = $1`, [proof[0].id])
  })

  it('contributes nothing — read or write — when the chores module is off', async () => {
    const week = await currentWeekStart()
    const { rows: late } = await query(
      `insert into chore_instances (household_id, chore_id, due_on, status) values ($1,$2,$3::date,'pending') returning id`,
      [householdId, choreId, addDays(week, -7)]
    )
    expect((await read()).notDone.map((i) => i.id)).toContain(late[0].id)

    await setModules({ chores: false })
    expect((await read()).notDone.map((i) => i.id)).not.toContain(late[0].id)
    expect((await resolve({ kind: 'chore', id: late[0].id, action: 'done' })).statusCode).toBe(403)
    const { rows } = await query(`select status from chore_instances where id = $1`, [late[0].id])
    expect(rows[0].status).toBe('pending')

    await setModules({ chores: true })
    await query(`update chore_instances set deleted_at = now() where id = $1`, [late[0].id])
  })
})

// ── "Not done" · lists ────────────────────────────────────────────────────────
describe('loose ends · unchecked list items', () => {
  let listId: string
  let staleId: string

  beforeAll(async () => {
    const { rows } = await query(
      `insert into lists (household_id, name, list_type) values ($1,'Around the house','custom') returning id`,
      [householdId]
    )
    listId = rows[0].id
    const week = await currentWeekStart()
    const { rows: stale } = await query(
      `insert into list_items (household_id, list_id, name, created_at) values ($1,$2,'Return the library books', $3::date - interval '2 days') returning id`,
      [householdId, listId, week]
    )
    staleId = stale[0].id
  })

  it('surfaces an item that was already open before this week began', async () => {
    const item = (await read()).notDone.find((i) => i.id === staleId)
    expect(item).toBeTruthy()
    expect(item!.kind).toBe('list')
    expect(item!.title).toBe('Return the library books')
    expect(item!.detail).toContain('Around the house')
    expect(item!.actions).toEqual(['done'])
  })

  // The anchor is the household's CURRENT week, not the planned one: the planned week is
  // always today or later, so anchoring there would flood the step.
  it('does NOT surface something typed THIS week — that is not a leftover, it is the week', async () => {
    const { rows } = await query(
      `insert into list_items (household_id, list_id, name) values ($1,$2,'Bought this morning') returning id`,
      [householdId, listId]
    )
    expect((await read()).notDone.map((i) => i.id)).not.toContain(rows[0].id)
  })

  // The week-key guard: a row keyed to the week being planned (or later) is that week's
  // work. `week_start` is a grocery concept, so the clause now guards future surfaces
  // only.
  it('does NOT surface a checked item, a suggestion, or a row keyed to the week being planned', async () => {
    const week = await currentWeekStart()
    const planned = await plannedWeekStart()
    const mk = async (cols: string, vals: unknown[]) => {
      const { rows } = await query(
        `insert into list_items (household_id, list_id, name, created_at${cols}) values ($1,$2,$3, $4::date - interval '3 days'${vals.map((_, i) => `, $${i + 5}`).join('')}) returning id`,
        [householdId, listId, 'x', week, ...vals]
      )
      return rows[0].id as string
    }
    const checked = await mk(', checked', [true])
    const suggested = await mk(', status', ['suggested'])
    const thisWeeksShop = await mk(', week_start', [planned])
    const ids = (await read()).notDone.map((i) => i.id)
    expect(ids).not.toContain(checked)
    expect(ids).not.toContain(suggested)
    expect(ids).not.toContain(thisWeeksShop)
  })

  it('routes without touching the row, and "it’s done already" checks it off', async () => {
    const before = await query(`select checked, week_start from list_items where id = $1`, [staleId])
    expect((await route({ sessionId, kind: 'list', id: staleId, title: 'Return the library books', source: 'notDone', to: 'tasks' })).statusCode).toBe(200)
    const after = await query(`select checked, week_start from list_items where id = $1`, [staleId])
    expect(after.rows[0]).toEqual(before.rows[0])
    await route({ sessionId, kind: 'list', id: staleId, to: null })

    expect((await resolve({ kind: 'list', id: staleId, action: 'done' })).statusCode).toBe(200)
    const { rows } = await query(`select checked, checked_by from list_items where id = $1`, [staleId])
    expect(rows[0].checked).toBe(true)
    expect(rows[0].checked_by).toBe(ownerId)
  })

  it('contributes nothing when the lists module is off', async () => {
    const week = await currentWeekStart()
    const { rows } = await query(
      `insert into list_items (household_id, list_id, name, created_at) values ($1,$2,'Fix the gate', $3::date - interval '1 day') returning id`,
      [householdId, listId, week]
    )
    expect((await read()).notDone.map((i) => i.id)).toContain(rows[0].id)
    await setModules({ lists: false })
    expect((await read()).notDone.map((i) => i.id)).not.toContain(rows[0].id)
    expect((await resolve({ kind: 'list', id: rows[0].id, action: 'done' })).statusCode).toBe(403)
    await setModules({ lists: true })
    await query(`update list_items set deleted_at = now() where id = $1`, [rows[0].id])
  })
})

// ── "Not done" · which LISTS even count ───────────────────────────────────────
// Only the lists a person actually keeps: `list_type = 'custom'`. GROCERY rebuilds itself
// from the meal plan every week, so an unchecked row there is shopping, not a loose end
// (a hand-typed grocery row for the same reason). TEMPLATES store items checked=false
// permanently (0072) and aren't in the Lists rail, so the flood would be invisible.
describe('loose ends · which lists count', () => {
  let groceryAutoId: string
  let groceryTypedId: string
  let templateItemId: string
  let customItemId: string

  beforeAll(async () => {
    const week = await currentWeekStart()
    const mkList = async (name: string, type: string, autoBuilt = false) => {
      const { rows } = await query(
        `insert into lists (household_id, name, list_type, is_auto_built) values ($1,$2,$3,$4) returning id`,
        [householdId, name, type, autoBuilt]
      )
      return rows[0].id as string
    }
    // Seeded so every OTHER clause in the read passes them — `week_start` NULL,
    // `created_at` well before the current week — or an existing filter would take the
    // credit.
    const mkItem = async (listId: string, name: string, source = 'manual') => {
      const { rows } = await query(
        `insert into list_items (household_id, list_id, name, source, created_at)
         values ($1,$2,$3,$4, $5::date - interval '9 days') returning id`,
        [householdId, listId, name, source, week]
      )
      return rows[0].id as string
    }
    const grocery = await mkList('Grocery', 'grocery', true)
    groceryAutoId = await mkItem(grocery, 'Whole milk', 'auto')
    groceryTypedId = await mkItem(grocery, 'Marble rye', 'manual')
    const template = await mkList('Camping trip', 'template')
    templateItemId = await mkItem(template, 'Sleeping bags')
    const custom = await mkList('Garage', 'custom')
    customItemId = await mkItem(custom, 'Patch the drywall')
  })

  it('leaves the grocery list out of "not done" — it rebuilds itself from the meal plan', async () => {
    const ids = (await read()).notDone.map((i) => i.id)
    expect(ids).not.toContain(groceryAutoId)
    expect(ids).not.toContain(groceryTypedId)
  })

  it('leaves list templates out — their items are unchecked BY DESIGN', async () => {
    expect((await read()).notDone.map((i) => i.id)).not.toContain(templateItemId)
  })

  it('still surfaces an ordinary custom list, and counts only what it shows', async () => {
    const view = await read()
    expect(view.notDone.map((i) => i.id)).toContain(customItemId)
    // The switch and both see-all headers render this tally, so nothing excluded from the
    // rows may still be inside the number.
    expect(view.counts.notDone).toBe(view.notDone.length)
    expect(view.notDone.filter((i) => i.kind === 'list').map((i) => i.id)).toContain(customItemId)
  })
})

// A household gets to say which of its lists this step is even about — only lists,
// because an overdue chore and a late rhythm are late BY DEFINITION and a habit is short
// or it isn't, while an unchecked row on "Someday" is the list working as intended.
//
// OPT-OUT, not opt-in: absent means relevant, so a household that never opens the setting
// sees what it saw before.
describe('loose ends · which lists the household wants asked about', () => {
  let keptId: string
  let mutedId: string
  let keptItemId: string
  let mutedItemId: string

  const config = async () => json(await call('GET', '/api/weekly-planning/config', kevin))
  const setLists = (lists: Record<string, boolean>) =>
    call('PUT', '/api/weekly-planning/config', kevin, { lists })

  beforeAll(async () => {
    const week = await currentWeekStart()
    const mkList = async (name: string, type = 'custom') => {
      const { rows } = await query(
        `insert into lists (household_id, name, list_type) values ($1,$2,$3) returning id`,
        [householdId, name, type]
      )
      return rows[0].id as string
    }
    const mkItem = async (listId: string, name: string) => {
      const { rows } = await query(
        `insert into list_items (household_id, list_id, name, source, created_at)
         values ($1,$2,$3,'manual', $4::date - interval '9 days') returning id`,
        [householdId, listId, name, week]
      )
      return rows[0].id as string
    }
    keptId = await mkList('Repairs')
    keptItemId = await mkItem(keptId, 'Fix the gate latch')
    mutedId = await mkList('Someday')
    mutedItemId = await mkItem(mutedId, 'Learn the banjo')
  })

  // Every custom list in the household, including ones other suites created — "none left
  // to check" means none at all.
  const allCandidates = async () =>
    ((await config()).lists as { id: string }[]).map((l) => l.id)
  const setAll = async (relevant: boolean) => {
    const ids = await allCandidates()
    await setLists(Object.fromEntries(ids.map((id) => [id, relevant])))
  }

  // Every test here leaves the household exactly as it found it: earlier suites assert on
  // `sources` and on the full "not done" deck, and a stray mute would rewrite what they
  // see.
  afterEach(async () => { await setAll(true) })

  it('says nothing about a list nobody has ruled on — absent means relevant', async () => {
    const ids = (await read()).notDone.map((i) => i.id)
    expect(ids).toContain(keptItemId)
    expect(ids).toContain(mutedItemId)
  })

  it('stops asking about a list that was ruled out, and leaves the others alone', async () => {
    await setLists({ [mutedId]: false })
    const view = await read()
    const ids = view.notDone.map((i) => i.id)
    expect(ids).not.toContain(mutedItemId)
    expect(ids).toContain(keptItemId)
    expect(view.counts.notDone).toBe(view.notDone.length)
  })

  it('asks again the moment the list is ruled back in', async () => {
    await setLists({ [mutedId]: false })
    expect((await read()).notDone.map((i) => i.id)).not.toContain(mutedItemId)
    await setLists({ [mutedId]: true })
    expect((await read()).notDone.map((i) => i.id)).toContain(mutedItemId)
  })

  it('merges the ruling rather than replacing it — one switch is not all of them', async () => {
    await setLists({ [mutedId]: false })
    await setLists({ [keptId]: false })
    const c = (await config()).config
    expect(c.lists[mutedId]).toBe(false)
    expect(c.lists[keptId]).toBe(false)
  })

  // The cleared state says "we checked chores, lists, rhythms and goals". With every list
  // ruled out that is not true.
  it('stops claiming it checked the lists once there are none left to check', async () => {
    expect((await read()).sources).toContain('lists')
    await setAll(false)
    const view = await read()
    expect(view.sources).not.toContain('lists')
    expect(view.sources).toEqual(['chores', 'rhythms', 'goals'])
  })

  // The STEP gets them on its own read: a step that had to fetch the config as well would
  // be two reads describing one thing. Same server-side helper as the config read, so
  // they can't disagree.
  it('rides along with the step’s own read, so the step needn’t ask twice', async () => {
    const view = await read()
    const names = (view.lists ?? []).map((l) => l.name)
    expect(names).toContain('Someday')
    expect(names).not.toContain('Grocery')
    expect(view.sources).toContain('lists')
  })

  it('reports a ruled-out list to the step as ruled out', async () => {
    await setLists({ [mutedId]: false })
    const row = ((await read()).lists ?? []).find((l) => l.id === mutedId)
    expect(row?.relevant).toBe(false)
  })

  it('offers the lists it could ask about, and no list it would never have asked about', async () => {
    const c = await config()
    const names = (c.lists as { id: string; name: string; relevant: boolean }[]).map((l) => l.name)
    expect(names).toContain('Repairs')
    expect(names).toContain('Someday')
    expect(names).not.toContain('Grocery')
    expect(names).not.toContain('Camping trip')
  })

  it('reports each list as it currently stands', async () => {
    await setLists({ [mutedId]: false })
    const rows = (await config()).lists as { id: string; relevant: boolean }[]
    expect(rows.find((l) => l.id === mutedId)?.relevant).toBe(false)
    expect(rows.find((l) => l.id === keptId)?.relevant).toBe(true)
  })

  it('ignores junk rather than storing it', async () => {
    await call('PUT', '/api/weekly-planning/config', kevin, { lists: { 'ruled-by-nobody': 'nope', '': true } })
    const c = (await config()).config
    expect(c.lists['ruled-by-nobody']).toBeUndefined()
    expect(Object.keys(c.lists)).not.toContain('')
  })
})

// WHO EACH THING ALREADY BELONGS TO. Routing something to Tasks when it already has an
// owner is a different decision from routing something nobody has picked up.
//
// Resolved from ONE person map in `getLooseEnds` rather than joined per source: two of
// the four sources come back through another module's reader and own no SQL to join, and
// one payload with two mechanisms for the same field is how they drift.
describe('loose ends · who each thing already belongs to', () => {
  let ownedInstance = ''
  let unownedInstance = ''
  let ownedRhythm = ''
  let soloGoal = ''
  let familyGoal = ''
  let elaineId = ''

  // Its own fixtures throughout. The other suites in this file RESOLVE what they create,
  // so leaning on their rows for an owner assertion passes right up until it has nothing
  // left to assert on.
  beforeAll(async () => {
    const week = await currentWeekStart()
    const { rows: p } = await query(
      `insert into persons (household_id, name, member_type, color_hex, avatar_emoji)
       values ($1,'Elaine','adult','#7fc1e8','🧣') returning id`,
      [householdId]
    )
    elaineId = p[0].id

    const chore = async (title: string, personId: string | null) => {
      const { rows: c } = await query(
        `insert into chores (household_id, title, person_id, is_active) values ($1,$2,$3,true) returning id`,
        [householdId, title, personId]
      )
      const { rows: i } = await query(
        `insert into chore_instances (household_id, chore_id, person_id, due_on, status)
         values ($1,$2,$3,$4::date,'pending') returning id`,
        [householdId, c[0].id, personId, addDays(week, -4)]
      )
      return i[0].id as string
    }
    ownedInstance = await chore('Elaine has this one', elaineId)
    unownedInstance = await chore('Nobody has this', null)

    const { rows: r } = await query(
      `insert into rhythms (household_id, title, person_id, satisfied_by, every, next_due_at, is_active)
       values ($1,'Elaine’s air filter',$2,'completion','3 months', now() - interval '20 days', true)
       returning id`,
      [householdId, elaineId]
    )
    ownedRhythm = r[0].id

    const habit = async (title: string, basis: string, people: string[]) => {
      const { rows: g } = await query(
        `insert into goals (household_id, title, goal_type, tracking_mode, habit_period,
                            habit_target_per_period, target_basis, is_active)
         values ($1,$2,'habit','each_tracks','week',3,$3,true) returning id`,
        [householdId, title, basis]
      )
      for (const pid of people) {
        await query(
          `insert into goal_participants (household_id, goal_id, person_id) values ($1,$2,$3)`,
          [householdId, g[0].id, pid]
        )
      }
      return g[0].id as string
    }
    soloGoal = await habit('Elaine runs', 'per_person', [elaineId])
    familyGoal = await habit('Everybody walks', 'family', [elaineId, ownerId])
  })

  it('names the person an overdue chore is assigned to', async () => {
    const item = (await read()).notDone.find((x) => x.id === ownedInstance)
    expect(item).toBeTruthy()
    const owner = item!.owner!
    expect(owner.id).toBe(elaineId)
    expect(owner.name).toBe('Elaine')
    // The colour and avatar travel with the name so a client renders the person the way
    // the rest of the app does.
    expect(owner.colorHex).toBe('#7fc1e8')
    expect(owner.avatarEmoji).toBe('🧣')
  })

  it('names the person a rhythm belongs to', async () => {
    const item = (await read()).notDone.find((x) => x.id === ownedRhythm)
    expect(item).toBeTruthy()
    expect(item!.owner?.name).toBe('Elaine')
  })

  // A habit with exactly one participant is that person's. A FAMILY habit belongs to
  // everybody, and inventing an owner would be worse than an empty slot.
  it('names the one person a habit goal is for, and nobody for the family’s', async () => {
    const view = await read()
    expect(view.notDone.find((x) => x.id === soloGoal)?.owner?.name).toBe('Elaine')
    expect(view.notDone.find((x) => x.id === familyGoal)?.owner ?? null).toBeNull()
  })

  it('leaves an unassigned chore ownerless rather than guessing', async () => {
    const item = (await read()).notDone.find((x) => x.id === unownedInstance)
    expect(item).toBeTruthy()
    expect(item!.owner ?? null).toBeNull()
  })

  it('says nothing for an unchecked list item — a list has no owner', async () => {
    const rows = (await read()).notDone.filter((x) => x.kind === 'list')
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.owner ?? null).toBeNull()
  })
})

// ── "Not done" · rhythms ──────────────────────────────────────────────────────
describe('loose ends · rhythms past due', () => {
  let rhythmId: string

  beforeAll(async () => {
    const res = await call('POST', '/api/rhythms', kevin, {
      title: 'Change the air filter',
      satisfiedBy: 'completion',
      every: '3 months',
      nextDueAt: new Date(Date.now() - 20 * 864e5).toISOString(),
    })
    rhythmId = json(res).rhythm.id
  })

  it('surfaces a completion rhythm whose date has passed', async () => {
    const item = (await read()).notDone.find((i) => i.id === rhythmId)
    expect(item).toBeTruthy()
    expect(item!.kind).toBe('rhythm')
    expect(item!.title).toBe('Change the air filter')
    expect(item!.actions).toEqual(['done'])
  })

  it('resolving "it’s done already" re-anchors the rhythm clock in the rhythms module', async () => {
    expect((await resolve({ kind: 'rhythm', id: rhythmId, action: 'done' })).statusCode).toBe(200)
    const { rows } = await query(`select last_completed_at, next_due_at from rhythms where id = $1`, [rhythmId])
    expect(rows[0].last_completed_at).toBeTruthy()
    expect(new Date(rows[0].next_due_at).getTime()).toBeGreaterThan(Date.now())
    expect((await read()).notDone.map((i) => i.id)).not.toContain(rhythmId)
  })

  it('settles an unbooked scheduling period by skipping the SERVER-derived period', async () => {
    const res = await call('POST', '/api/rhythms', kevin, {
      title: 'Book the dentist',
      satisfiedBy: 'scheduling',
      every: '6 months',
      // 170 days into a ~182-day period: the booking runway (period_end - lead_time) is
      // already open, which is what makes an unbooked period a loose end today.
      startsOn: new Date(Date.now() - 170 * 864e5).toISOString().slice(0, 10),
      leadTime: '30 days',
    })
    const id = json(res).rhythm.id
    const item = (await read()).notDone.find((i) => i.id === id)
    expect(item).toBeTruthy()
    expect(item!.detail).toMatch(/nothing booked/i)

    // No periodStart in the request: a client echo of a boundary that has since moved
    // would insert happily and silence nothing, so the server re-derives it.
    expect((await resolve({ kind: 'rhythm', id, action: 'done' })).statusCode).toBe(200)
    const { rows } = await query(`select period_start::text as period_start from rhythm_skips where rhythm_id = $1`, [id])
    expect(rows).toHaveLength(1)
    expect(rows[0].period_start).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect((await read()).notDone.map((i) => i.id)).not.toContain(id)
  })

  it('contributes nothing when the rhythms module is off', async () => {
    await query(`update rhythms set next_due_at = now() - interval '5 days' where id = $1`, [rhythmId])
    expect((await read()).notDone.map((i) => i.id)).toContain(rhythmId)
    await setModules({ rhythms: false })
    expect((await read()).notDone.map((i) => i.id)).not.toContain(rhythmId)
    expect((await resolve({ kind: 'rhythm', id: rhythmId, action: 'done' })).statusCode).toBe(403)
    await setModules({ rhythms: true })
    await query(`update rhythms set deleted_at = now() where household_id = $1`, [householdId])
  })
})

// ── "Not done" · goals ────────────────────────────────────────────────────────
describe('loose ends · habit goals short for the week', () => {
  let goalId: string

  beforeAll(async () => {
    const { rows } = await query(
      `insert into goals (household_id, title, goal_type, tracking_mode, habit_period, habit_target_per_period, is_active)
       values ($1,'Run three times','habit','shared_total','week',3,true) returning id`,
      [householdId]
    )
    goalId = rows[0].id
  })

  it('surfaces a weekly habit that is short of its target, and says by how much', async () => {
    const item = (await read()).notDone.find((i) => i.id === goalId)
    expect(item).toBeTruthy()
    expect(item!.kind).toBe('goal')
    expect(item!.detail).toMatch(/0 of 3/)
    expect(item!.actions).toEqual(['done'])
  })

  it('resolving "it’s done already" logs one against the goal, and the shortfall shrinks', async () => {
    expect((await resolve({ kind: 'goal', id: goalId, action: 'done' })).statusCode).toBe(200)
    const { rows } = await query(`select count(*)::int as n from goal_logs where goal_id = $1 and deleted_at is null`, [goalId])
    expect(rows[0].n).toBe(1)
    expect((await read()).notDone.find((i) => i.id === goalId)!.detail).toMatch(/1 of 3/)
  })

  it('stops asking once the target is met, and ignores a habit on another period', async () => {
    await query(`update goals set habit_target_per_period = 1 where id = $1`, [goalId])
    expect((await read()).notDone.map((i) => i.id)).not.toContain(goalId)

    const { rows } = await query(
      `insert into goals (household_id, title, goal_type, tracking_mode, habit_period, habit_target_per_period, is_active)
       values ($1,'Floss daily','habit','shared_total','day',1,true) returning id`,
      [householdId]
    )
    expect((await read()).notDone.map((i) => i.id)).not.toContain(rows[0].id)
    await query(`update goals set is_active = false where id = $1`, [rows[0].id])
  })

  it('contributes nothing when the goals module is off', async () => {
    await query(`update goals set habit_target_per_period = 5 where id = $1`, [goalId])
    expect((await read()).notDone.map((i) => i.id)).toContain(goalId)
    await setModules({ goals: false })
    expect((await read()).notDone.map((i) => i.id)).not.toContain(goalId)
    expect((await resolve({ kind: 'goal', id: goalId, action: 'done' })).statusCode).toBe(403)
    await setModules({ goals: true })
    await query(`update goals set is_active = false where household_id = $1`, [householdId])
  })
})

// ── "Parked" ──────────────────────────────────────────────────────────────────
describe('loose ends · parked items', () => {
  let parkedId: string

  it('parks a note from the capture bar — the one group with a table', async () => {
    const res = await park({ note: 'Ask about the school trip', sessionId })
    expect(res.statusCode).toBe(200)
    parkedId = json(res).item.id
    const p = await read()
    const item = p.parked.find((i) => i.id === parkedId)
    expect(item).toBeTruthy()
    expect(item!.kind).toBe('parked')
    expect(item!.title).toBe('Ask about the school trip')
    expect(item!.actions.sort()).toEqual(['done', 'drop'])
    expect(item!.detail).toMatch(/^Parked by Kevin · today$/)
    expect(p.counts.parked).toBe(1)
  })

  it('counts how many finished sessions have passed a note over', async () => {
    await call('POST', `/api/weekly-planning/session/${sessionId}/complete`, kevin)
    expect((await read()).parked.find((i) => i.id === parkedId)!.detail).toMatch(/passed over once$/)
    await call('PATCH', `/api/weekly-planning/session/${sessionId}`, kevin, { status: 'active' })
  })

  it('keeps the optional step tag step 3 parks notes with, and the session that parked it', async () => {
    const res = await park({ note: 'The dentist is somewhere in March', stepKey: 'horizon', sessionId })
    expect(res.statusCode).toBe(200)
    const { rows } = await query(
      `select step_key, session_id, created_by, status from planning_parked_items where id = $1`,
      [json(res).item.id]
    )
    expect(rows[0]).toMatchObject({ step_key: 'horizon', session_id: sessionId, created_by: ownerId, status: 'open' })
    await resolve({ kind: 'parked', id: json(res).item.id, action: 'drop' })
  })

  it('refuses an empty note and a step tag that is not in the catalog', async () => {
    expect((await park({ note: '   ' })).statusCode).toBe(400)
    expect((await park({ note: 'ok', stepKey: 'lobby' })).statusCode).toBe(400)
  })

  // Routing a note is the other half of what step_key is for: it names the step that will
  // look at the note, whichever end of the session wrote it.
  it('routing a note sets its step_key, and stays "open" until somebody answers it', async () => {
    const res = await route({ sessionId, kind: 'parked', id: parkedId, title: 'Ask about the school trip', source: 'parked', to: 'tasks' })
    expect(res.statusCode).toBe(200)
    const { rows } = await query(`select step_key, status from planning_parked_items where id = $1`, [parkedId])
    expect(rows[0]).toMatchObject({ step_key: 'tasks', status: 'open' })
    expect((await routesFromSessionView()).find((r) => r.id === parkedId)!.source).toBe('parked')

    await route({ sessionId, kind: 'parked', id: parkedId, to: null })
    const { rows: after } = await query(`select step_key from planning_parked_items where id = $1`, [parkedId])
    expect(after[0].step_key).toBe(null)
  })

  it('survives its session being discarded — the session goes, what it produced stays', async () => {
    const s = json(await call('POST', '/api/weekly-planning/session', kevin, { weekStart: addDays(await plannedWeekStart(), 21) })).session
    const id = json(await park({ note: 'Outlives the session', sessionId: s.id })).item.id
    expect((await call('DELETE', `/api/weekly-planning/session/${s.id}`, kevin)).statusCode).toBe(200)
    const { rows } = await query(`select status, session_id from planning_parked_items where id = $1`, [id])
    expect(rows[0].status).toBe('open')
    expect(rows[0].session_id).toBe(null)
    expect((await read()).parked.map((i) => i.id)).toContain(id)
    await resolve({ kind: 'parked', id, action: 'drop' })
  })

  it('"talk about it now" resolves it and "drop it" drops it, stamping who answered', async () => {
    expect((await resolve({ kind: 'parked', id: parkedId, action: 'done' })).statusCode).toBe(200)
    const { rows } = await query(`select status, resolved_at, resolved_by from planning_parked_items where id = $1`, [parkedId])
    expect(rows[0]).toMatchObject({ status: 'resolved', resolved_by: ownerId })
    expect(rows[0].resolved_at).toBeTruthy()
    expect((await read()).parked.map((i) => i.id)).not.toContain(parkedId)

    const dropMe = json(await park({ note: 'Never mind' })).item.id
    expect((await resolve({ kind: 'parked', id: dropMe, action: 'drop' })).statusCode).toBe(200)
    const { rows: after } = await query(`select status from planning_parked_items where id = $1`, [dropMe])
    expect(after[0].status).toBe('dropped')
    expect((await read()).parked.map((i) => i.id)).not.toContain(dropMe)
  })
})

// ── The two contracts ─────────────────────────────────────────────────────────
describe('loose ends · the route contract', () => {
  it('refuses a step that is not in the catalog, the step it came from, and a step that is off', async () => {
    const base = { sessionId, kind: 'parked' as const, title: 'x', source: 'parked' as const }
    const id = json(await park({ note: 'contract' })).item.id
    expect((await route({ ...base, id, to: 'lobby' })).statusCode).toBe(400)
    expect((await route({ ...base, id, to: 'looseEnds' })).statusCode).toBe(400)
    await setModules({ familyNight: false })
    expect((await route({ ...base, id, to: 'familyNight' })).statusCode).toBe(400)
    expect((await route({ sessionId, kind: 'parked', id, source: 'parked', title: '  ', to: 'tasks' })).statusCode).toBe(400)
    await resolve({ kind: 'parked', id, action: 'drop' })
  })

  it('404s on a session that is not this household’s, and 400s on a bad id', async () => {
    expect((await route({ sessionId: '11111111-1111-1111-1111-111111111111', kind: 'parked', id: ownerId, title: 'x', to: 'tasks' })).statusCode).toBe(404)
    expect((await route({ sessionId: 'nope', kind: 'parked', id: ownerId, title: 'x', to: 'tasks' })).statusCode).toBe(400)
    expect((await route({ sessionId, kind: 'parked', id: 'nope', title: 'x', to: 'tasks' })).statusCode).toBe(400)
    expect((await route({ sessionId, kind: 'nonsense', id: ownerId, title: 'x', to: 'tasks' })).statusCode).toBe(400)
    expect((await route({ sessionId, kind: 'parked', id: '11111111-1111-1111-1111-111111111111', title: 'x', to: 'tasks' })).statusCode).toBe(404)
  })
})

// THE READ IS HOUSEHOLD-SCOPED. `?sessionId=` makes step 1's read self-contained, and
// `listRoutes` selects from `planning_session_steps`, which has no `household_id` of its
// own — it is scoped only through `planning_sessions`. Unguarded, a foreign session id
// reads another household's routes, and every route entry carries a `title`: the wording
// of another family's chores, list items and notes.
describe('loose ends · the read cannot see another household', () => {
  let theirSession = ''

  beforeAll(async () => {
    const { rows: h } = await query(
      `insert into households (name, timezone) values ('Costanzas','America/Chicago') returning id`
    )
    const { rows: se } = await query(
      `insert into planning_sessions (household_id, week_start, status, current_step)
       values ($1, date_trunc('week', now())::date, 'active', 'looseEnds') returning id`,
      [h[0].id]
    )
    theirSession = se[0].id
    await query(
      `insert into planning_session_steps (session_id, step_key, status, data)
       values ($1,'looseEnds','pending',$2::jsonb)`,
      [theirSession, JSON.stringify({
        routes: [{ kind: 'chore', id: '22222222-2222-4222-8222-222222222222', title: 'THEIR PRIVATE CHORE', source: 'notDone', to: 'tasks' }],
      })]
    )
  })

  it('returns no routes for a session belonging to someone else', async () => {
    const view = await read(`?sessionId=${theirSession}`)
    expect(view.routes).toEqual([])
    expect(JSON.stringify(view)).not.toContain('THEIR PRIVATE CHORE')
  })

  it('still reads our OWN session normally — the guard is scoping, not a blanket refusal', async () => {
    const view = await read(`?sessionId=${sessionId}`)
    expect(Array.isArray(view.routes)).toBe(true)
    expect(view.weekStart).toBeTruthy()
  })

  // A malformed id would reach Postgres as `uuid = 'nope'` → 22P02 → 500. It is simply
  // "no session", the same answer `horizon.ts` gives.
  it('treats a malformed session id as no session rather than a 500', async () => {
    const r = await call('GET', '/api/weekly-planning/loose-ends?sessionId=nope', kevin)
    expect(r.statusCode).toBe(200)
    expect(json(r).routes).toEqual([])
  })
})

describe('loose ends · the resolve contract', () => {
  it('refuses an unknown kind or action rather than guessing', async () => {
    expect((await resolve({ kind: 'nonsense', id: ownerId, action: 'done' })).statusCode).toBe(400)
    expect((await resolve({ kind: 'parked', id: ownerId, action: 'burn' })).statusCode).toBe(400)
    expect((await resolve({ kind: 'chore', id: ownerId, action: 'move' })).statusCode).toBe(400)
  })

  it('404s on an id that is not this household’s', async () => {
    for (const kind of ['chore', 'list', 'rhythm', 'goal', 'parked']) {
      const res = await resolve({ kind, id: '11111111-1111-1111-1111-111111111111', action: 'done' })
      expect(res.statusCode, kind).toBe(404)
    }
  })

  it('rejects an id that is not a uuid with a 400, not a database error', async () => {
    expect((await resolve({ kind: 'parked', id: 'not-a-uuid', action: 'done' })).statusCode).toBe(400)
  })
})
