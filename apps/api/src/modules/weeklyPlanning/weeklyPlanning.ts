// Weekly Planning — the session that walks a household through deciding its week.
//
// The module owns almost no data: nine of its ten steps read existing modules and write
// their decisions back into them, so `planning_sessions` records only which week was
// planned, where the driver is, what each step answered and when it finished. Config
// lives in households.settings.weeklyPlanning. See docs/product/weekly-planning-plan.md.
import { query } from '../../platform/db'
import { moduleEnabled, type ModuleKey } from '../../platform/modules'
import { householdWeekStart, snapToWeekStart, parseWeekStartParam, type FirstDayOfWeek } from '../lists/lists.service'
import type { Tenant } from '../households/households'

// THE definition of the session: order, titles, acts and the single question each step
// asks. Server-owned on purpose — a client-side copy would drift the moment one platform
// reworded a question. Steps that aren't built yet are simply absent.
export interface StepDef {
  key: string
  title: string
  ask: string
  primary: string
  act: string
  requiresModule?: ModuleKey
}

export const STEPS: StepDef[] = [
  { key: 'looseEnds', title: 'Loose ends', ask: 'Anything still open from last week?', primary: 'All handled', act: 'Intake' },
  { key: 'calendar', title: 'Calendar', ask: 'Here’s your week. Anything missing?', primary: 'Looks right', act: 'Frame the week' },
  { key: 'horizon', title: 'Horizon scan', ask: 'Anything further out you should see now?', primary: 'Nothing missing', act: 'Frame the week' },
  { key: 'familyNight', title: 'Family night', ask: 'Accept the rotation, or change it?', primary: 'Accept', act: 'Claim the good', requiresModule: 'familyNight' },
  { key: 'connection', title: 'Connection', ask: 'Who gets time with whom?', primary: 'Done', act: 'Claim the good' },
  { key: 'goals', title: 'Goals', ask: 'What’s each group’s focus this week?', primary: 'Done', act: 'Claim the good', requiresModule: 'goals' },
  { key: 'meals', title: 'Meals', ask: 'What’s planned, and what’s still open?', primary: 'Done', act: 'Run the household', requiresModule: 'meals' },
  { key: 'tasks', title: 'Tasks', ask: 'Who’s doing what?', primary: 'Handed out', act: 'Run the household', requiresModule: 'chores' },
  { key: 'kids', title: 'Kids', ask: 'What’s your week about?', primary: 'Done', act: 'Run the household' },
  { key: 'recap', title: 'Recap', ask: 'Here’s the week you just decided.', primary: 'Save the week', act: 'Close' },
]

const STEP_KEYS = new Set(STEPS.map((s) => s.key))
export const isStepKey = (k: unknown): k is string => typeof k === 'string' && STEP_KEYS.has(k)

export interface WeeklyPlanningConfig {
  // 0=Sunday … 6=Saturday. Drives the "session due" prompt only; it does NOT decide
  // which week is planned (see plannedWeekStart).
  dayOfWeek: number
  time: string // 'HH:MM' local
  // Per-step opt-out, keyed by catalog key. Absent ⇒ on. A step whose module is off is
  // unavailable regardless.
  steps: Record<string, boolean>
  showOnToday: boolean
  // Which lists step 1 is about, keyed by list id. Absent ⇒ relevant (the same sparse
  // opt-out shape as `steps`, so a household that never opens the setting sees no change).
  // Only LISTS get this: an unchecked row on a long-lived list is that list working as
  // intended, whereas an overdue chore or late rhythm is late by definition.
  lists: Record<string, boolean>
}

const DEFAULT_CONFIG: WeeklyPlanningConfig = {
  dayOfWeek: 0, // Sunday — the session plans the week ahead
  time: '17:00',
  steps: {},
  showOnToday: true,
  lists: {},
}

const clampDow = (n: number) => ((Math.trunc(n) % 7) + 7) % 7

export async function getConfig(householdId: string): Promise<WeeklyPlanningConfig> {
  const { rows } = await query<{ settings: { weeklyPlanning?: Partial<WeeklyPlanningConfig> } | null }>(
    `select settings from households where id = $1`,
    [householdId]
  )
  const c = rows[0]?.settings?.weeklyPlanning ?? {}
  const steps: Record<string, boolean> = {}
  if (c.steps && typeof c.steps === 'object') {
    for (const [k, v] of Object.entries(c.steps)) if (isStepKey(k) && typeof v === 'boolean') steps[k] = v
  }
  // A list key is a row id, not a catalog key, so the guard is only that it LOOKS like one
  // and carries a boolean. A key for a deleted list is harmless (the read joins `lists`).
  const lists: Record<string, boolean> = {}
  if (c.lists && typeof c.lists === 'object') {
    for (const [k, v] of Object.entries(c.lists)) if (k && typeof v === 'boolean') lists[k] = v
  }
  return {
    dayOfWeek: typeof c.dayOfWeek === 'number' ? clampDow(c.dayOfWeek) : DEFAULT_CONFIG.dayOfWeek,
    time: typeof c.time === 'string' && /^\d{2}:\d{2}$/.test(c.time) ? c.time : DEFAULT_CONFIG.time,
    steps,
    showOnToday: typeof c.showOnToday === 'boolean' ? c.showOnToday : DEFAULT_CONFIG.showOnToday,
    lists,
  }
}

export async function setConfig(householdId: string, patch: Partial<WeeklyPlanningConfig>): Promise<WeeklyPlanningConfig> {
  await query(
    `update households
        set settings = coalesce(settings, '{}'::jsonb)
                       || jsonb_build_object('weeklyPlanning', coalesce(settings->'weeklyPlanning', '{}'::jsonb) || $2::jsonb)
      where id = $1`,
    [householdId, JSON.stringify(patch)]
  )
  return getConfig(householdId)
}

// The SERVER owns this boundary (household first-day-of-week + timezone), as it does for
// grocery weeks and the meal planner. The rule: if today IS the household's week start,
// plan the week beginning today; otherwise plan the next one.
export async function plannedWeekStart(householdId: string): Promise<string> {
  const thisWeek = await householdWeekStart(householdId)
  const { firstDay, todayLocal } = await weekPrefs(householdId)
  if (snapToWeekStart(todayLocal, firstDay) === todayLocal) return thisWeek
  return addDays(thisWeek, 7)
}

async function weekPrefs(householdId: string): Promise<{ firstDay: FirstDayOfWeek; todayLocal: string }> {
  const { rows } = await query<{ week_start: string; timezone: string | null }>(
    `select week_start, timezone from households where id = $1`,
    [householdId]
  )
  const firstDay: FirstDayOfWeek = rows[0]?.week_start === 'monday' ? 'monday' : 'sunday'
  const tz = (rows[0]?.timezone ?? '').trim() || 'UTC'
  return {
    firstDay,
    todayLocal: new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
  }
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// The earliest week a session may plan: the household's CURRENT week. Clients show this
// as the floor of the week stepper.
export const earliestWeekStart = (householdId: string) => householdWeekStart(householdId)

// The ONE gate in front of a wire-supplied week, so everything downstream gets a real
// household week: reject nonsense → the default week; SNAP a mid-week date to its week
// start (a session keyed to a day would never be read again); clamp to the floor.
export async function resolveWeekStart(householdId: string, raw: unknown): Promise<string> {
  const parsed = parseWeekStartParam(raw)
  if (!parsed) return plannedWeekStart(householdId)
  const { firstDay } = await weekPrefs(householdId)
  const snapped = snapToWeekStart(parsed, firstDay)
  const floor = await earliestWeekStart(householdId)
  return snapped < floor ? floor : snapped
}

export interface StepHandoff {
  id: string
  note: string
  byline: string | null
}

export interface SessionStep extends StepDef {
  // 1-based position in the CATALOG, unavailable steps included. NOT the "2 of 9"
  // counter — clients derive that from the runnable list.
  number: number
  // False ⇒ module off or household opted out; the session steps over it.
  available: boolean
  status: 'pending' | 'done' | 'skipped'
  data: Record<string, unknown>
  decidedAt: string | null
  /**
   * Open parked notes TAGGED FOR THIS STEP: `planning_parked_items.step_key` names a
   * DESTINATION ("which step will look at this"), so a note tagged for Meals surfaces
   * there rather than waiting for the recap. On the SESSION VIEW rather than each step's
   * own read, because the shell refetches after every write.
   */
  parked: StepHandoff[]
}

export interface Session {
  id: string
  weekStart: string
  status: 'active' | 'completed'
  currentStep: string | null
  driverPersonId: string | null
  startedAt: string
  completedAt: string | null
}

export interface WeeklyPlanningView {
  config: WeeklyPlanningConfig
  weekStart: string
  defaultWeekStart: string
  minWeekStart: string
  session: Session | null
  steps: SessionStep[]
}

interface SessionRow {
  id: string
  week_start: string | Date
  status: string
  current_step: string | null
  driver_person_id: string | null
  started_at: Date
  completed_at: Date | null
}

const isoDate = (v: string | Date) => (typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10))

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  weekStart: isoDate(r.week_start),
  status: r.status === 'completed' ? 'completed' : 'active',
  currentStep: r.current_step,
  driverPersonId: r.driver_person_id,
  startedAt: r.started_at.toISOString(),
  completedAt: r.completed_at ? r.completed_at.toISOString() : null,
})

async function findSession(householdId: string, weekStart: string): Promise<Session | null> {
  const { rows } = await query<SessionRow>(
    `select * from planning_sessions where household_id = $1 and week_start = $2`,
    [householdId, weekStart]
  )
  return rows[0] ? toSession(rows[0]) : null
}

export async function getSessionById(householdId: string, id: string): Promise<Session | null> {
  const { rows } = await query<SessionRow>(
    `select * from planning_sessions where household_id = $1 and id = $2`,
    [householdId, id]
  )
  return rows[0] ? toSession(rows[0]) : null
}

export async function resolveSteps(householdId: string, sessionId: string | null): Promise<SessionStep[]> {
  const [config, settingsRow, decisions, parked] = await Promise.all([
    getConfig(householdId),
    query<{ settings: unknown }>(`select settings from households where id = $1`, [householdId]).then((r) => r.rows[0]?.settings),
    sessionId
      ? query<{ step_key: string; status: string; data: Record<string, unknown>; decided_at: Date }>(
          `select step_key, status, data, decided_at from planning_session_steps where session_id = $1`,
          [sessionId]
        ).then((r) => r.rows)
      : Promise.resolve([]),
    parkedByStep(householdId),
  ])
  const byKey = new Map(decisions.map((d) => [d.step_key, d]))
  return STEPS.map((s, i) => {
    const moduleOn = s.requiresModule ? moduleEnabled(settingsRow, s.requiresModule) : true
    const turnedOff = config.steps[s.key] === false
    const d = byKey.get(s.key)
    return {
      ...s,
      number: i + 1,
      available: moduleOn && !turnedOff,
      status: d ? (d.status as SessionStep['status']) : 'pending',
      data: d?.data ?? {},
      decidedAt: d ? d.decided_at.toISOString() : null,
      parked: parked.get(s.key) ?? [],
    }
  })
}

/**
 * Open parked notes grouped by the step each was tagged for. NOT scoped to the session:
 * the point of parking is that a note survives the session that wrote it.
 *
 * Two step keys are deliberately excluded: `looseEnds` (step 1 already draws the whole
 * board, so it would double every row) and a NULL tag (that is the recap's "last call",
 * not every step's banner).
 */
const HANDOFF_CAP = 6

export async function parkedByStep(householdId: string): Promise<Map<string, StepHandoff[]>> {
  const { rows } = await query<{ step_key: string; id: string; note: string; by_name: string | null; created_at: Date }>(
    `select pi.step_key, pi.id, pi.note, p.name as by_name, pi.created_at
       from planning_parked_items pi
       left join persons p on p.id = pi.created_by and p.deleted_at is null
      where pi.household_id = $1
        and pi.status = 'open'
        and pi.step_key is not null
        and pi.step_key <> 'looseEnds'
      order by pi.created_at`,
    [householdId]
  )
  const out = new Map<string, StepHandoff[]>()
  for (const r of rows) {
    const list = out.get(r.step_key) ?? out.set(r.step_key, []).get(r.step_key)!
    if (list.length >= HANDOFF_CAP) continue
    list.push({ id: r.id, note: r.note, byline: byline(r.by_name, r.created_at) })
  }
  return out
}

function byline(name: string | null, at: Date): string | null {
  const days = Math.floor((Date.now() - at.getTime()) / 86400000)
  const age = days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 14 ? `${days} days ago` : `${Math.floor(days / 7)} weeks ago`
  return name ? `${name} · ${age}` : age
}

export const firstAvailableStep = (steps: SessionStep[]): string | null => steps.find((s) => s.available)?.key ?? null

export async function getView(householdId: string, rawWeekStart?: unknown): Promise<WeeklyPlanningView> {
  const [week, defaultWeekStart, minWeekStart] = await Promise.all([
    resolveWeekStart(householdId, rawWeekStart),
    plannedWeekStart(householdId),
    earliestWeekStart(householdId),
  ])
  const session = await findSession(householdId, week)
  const [config, steps] = await Promise.all([getConfig(householdId), resolveSteps(householdId, session?.id ?? null)])
  return { config, weekStart: week, defaultWeekStart, minWeekStart, session, steps }
}

// Idempotent on purpose: "run the session" is a button somebody taps twice, and a second
// row for the same seven days would split the week's record.
export async function startSession(tenant: Tenant, rawWeekStart?: unknown): Promise<Session> {
  const week = await resolveWeekStart(tenant.householdId, rawWeekStart)
  const existing = await findSession(tenant.householdId, week)
  if (existing) return existing
  const steps = await resolveSteps(tenant.householdId, null)
  const { rows } = await query<SessionRow>(
    `insert into planning_sessions (household_id, week_start, current_step, driver_person_id)
     values ($1, $2, $3, $4)
     on conflict (household_id, week_start) do update set current_step = planning_sessions.current_step
     returning *`,
    [tenant.householdId, week, firstAvailableStep(steps), tenant.personId]
  )
  return toSession(rows[0])
}

export interface SessionPatch {
  currentStep?: string
  status?: 'active' | 'completed'
}

export async function patchSession(householdId: string, id: string, patch: SessionPatch): Promise<Session | null> {
  const sets: string[] = []
  const params: unknown[] = [householdId, id]
  if (patch.currentStep !== undefined) {
    params.push(patch.currentStep)
    sets.push(`current_step = $${params.length}`)
  }
  if (patch.status !== undefined) {
    params.push(patch.status)
    sets.push(`status = $${params.length}`)
    sets.push(patch.status === 'completed' ? `completed_at = coalesce(completed_at, now())` : `completed_at = null`)
  }
  if (!sets.length) return getSessionById(householdId, id)
  const { rows } = await query<SessionRow>(
    `update planning_sessions set ${sets.join(', ')} where household_id = $1 and id = $2 returning *`,
    params
  )
  return rows[0] ? toSession(rows[0]) : null
}

export interface StepDecision {
  stepKey: string
  status: 'pending' | 'done' | 'skipped'
  data?: Record<string, unknown>
}

export async function decideStep(householdId: string, sessionId: string, input: StepDecision): Promise<SessionStep[] | null> {
  const session = await getSessionById(householdId, sessionId)
  if (!session) return null
  await query(
    `insert into planning_session_steps (session_id, step_key, status, data, decided_at)
     values ($1, $2, $3, $4::jsonb, now())
     on conflict (session_id, step_key)
       do update set status = excluded.status, data = excluded.data, decided_at = now()`,
    [sessionId, input.stepKey, input.status, JSON.stringify(input.data ?? {})]
  )
  return resolveSteps(householdId, sessionId)
}

export async function completeSession(householdId: string, id: string): Promise<Session | null> {
  return patchSession(householdId, id, { status: 'completed' })
}

// Throw the session away and put the week back to its lobby.
//
// This discards the SESSION only: everything it decided lives in the module that owns it
// and stays exactly as it is. The step rows go with it (on delete cascade), so nothing is
// left claiming a week was decided when its record is gone.
export async function deleteSession(householdId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(`delete from planning_sessions where household_id = $1 and id = $2`, [householdId, id])
  return (rowCount ?? 0) > 0
}
