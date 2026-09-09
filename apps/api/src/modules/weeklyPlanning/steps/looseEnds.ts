// Weekly Planning · step 1 "Loose ends" — service logic. See
// docs/product/weekly-planning-plan.md § "Step 1 routes; it does not resolve".
//
// STEP 1 IS INTAKE, NOT REPAIR: it ROUTES items to the steps that will handle them and
// writes nothing to any module, bar "It's done already" and (for a parked note) "Drop
// it". A source module that is off contributes nothing, read AND write. The CROSS-STEP
// CONTRACT later steps read: `planning_session_steps.data` for `looseEnds` holds `{
// routes: [{ kind, id, title, source, to }] }`, filtered by each step to its own `to`.
import { query } from '../../../platform/db'
import { moduleEnabled, type ModuleKey } from '../../../platform/modules'
import type { Tenant } from '../../households/households'
import { earliestWeekStart, isStepKey, resolveSteps, STEPS, getSessionById, getConfig } from '../weeklyPlanning'
import { completeInstance, ProofRequiredError } from '../../chores/chores.service'
import { setItemChecked, softDeleteItem } from '../../lists/lists.service'
import { listAttention, completeRhythm, skipPeriod } from '../../rhythms/rhythms'
import { listGoals, logProgress } from '../../goals/goals.service'

// ─── The shape the step reads ───────────────────────────────────────────────

// WHO A LOOSE END ALREADY BELONGS TO. Routing something that already has an owner is a
// different decision from routing something nobody picked up. Colour and avatar travel
// WITH the name.
export interface LooseEndOwner {
  id: string
  name: string
  colorHex: string | null
  avatarEmoji: string | null
}

export type LooseEndKind = 'chore' | 'list' | 'rhythm' | 'goal' | 'parked'
export type LooseEndGroup = 'notDone' | 'parked'

// The two answers that actually WRITE (routing goes to the session, not to a module).
// Which of them an item offers is decided here per item rather than guessed from `kind`:
// a photo-proof chore can't be completed from a camera-less session, and only a parked
// note can be dropped. "Leave it open" writes nothing and lives entirely in the client.
export type LooseEndAction = 'done' | 'drop'

export interface LooseEnd {
  // Stable across refetches and unique across kinds — the client's list key, and what the
  // deck remembers as answered.
  key: string
  kind: LooseEndKind
  id: string
  title: string
  emoji: string | null
  // Null means "nobody has this" — a real state, and exactly the row worth routing.
  // Always null for a list item and a parked note.
  owner: LooseEndOwner | null
  // The one line under the title (how late, which list, who wrote it). Composed here so
  // web and iOS say the same thing.
  detail: string | null
  actions: LooseEndAction[]
}

// A destination is a STEP, and the catalog is server-owned for the same reason the step
// catalog is: a client copy would drift the moment one platform reworded it. A step whose
// module is off is filtered out here.
export interface LooseEndDestination {
  to: string
  label: string
  hint: string
  primary?: boolean
}

// What step 1 routed, and where. Persisted on the session; the shape later steps read.
export interface LooseEndRoute {
  kind: LooseEndKind
  id: string
  // The title AS IT READ WHEN ROUTED, so a later step needn't re-read four modules. A
  // label, never a source of truth.
  title: string
  source: LooseEndGroup
  // The step that will handle it: a key from the server-owned catalog.
  to: string
}

export interface LooseEndsView {
  // The week being planned (already snapped and floored by the caller).
  weekStart: string
  notDone: LooseEnd[]
  parked: LooseEnd[]
  counts: { notDone: number; parked: number }
  // Where each group's card can send an item, filtered to steps this household runs.
  destinations: { notDone: LooseEndDestination[]; parked: LooseEndDestination[] }
  // What has been routed in THIS session so far (empty without a session).
  routes: LooseEndRoute[]
  // Modules actually read, for the cleared state's "we checked…" line — so it never
  // claims a module that is off.
  sources: string[]
  // The lists this step COULD ask about. Same helper the config read uses, so the two
  // cannot disagree.
  lists: PlanningListCandidate[]
}

// What a source returns before owners are resolved. Two of the four come back through
// another module's reader and own no SQL to join `persons`, so ownership is resolved once
// in `getLooseEnds`.
type SourceEnd = Omit<LooseEnd, 'owner'> & { ownerId: string | null }

/// The household's people, by id. Small by construction: a household, not a table scan.
async function peopleById(householdId: string): Promise<Map<string, LooseEndOwner>> {
  const { rows } = await query<{ id: string; name: string; color_hex: string | null; avatar_emoji: string | null }>(
    `select id, name, color_hex, avatar_emoji
       from persons where household_id = $1 and deleted_at is null`,
    [householdId]
  )
  return new Map(rows.map((r) => [r.id, {
    id: r.id, name: r.name, colorHex: r.color_hex, avatarEmoji: r.avatar_emoji,
  }]))
}

const withOwners = (items: SourceEnd[], people: Map<string, LooseEndOwner>): LooseEnd[] =>
  items.map(({ ownerId, ...rest }) => ({ ...rest, owner: (ownerId && people.get(ownerId)) || null }))

// A defensive ceiling per source: the step is a deck with a see-all escape hatch, so
// twenty items is by design.
const PER_SOURCE_LIMIT = 200

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function householdSettings(householdId: string): Promise<unknown> {
  const { rows } = await query<{ settings: unknown }>(`select settings from households where id = $1`, [householdId])
  return rows[0]?.settings
}

const enabled = (settings: unknown, key: ModuleKey) => moduleEnabled(settings, key)

// Today, in the household's own zone. Every "is it late?" below compares against this,
// never the server's date.
async function todayLocal(householdId: string): Promise<string> {
  const { rows } = await query<{ today: string }>(
    `select (now() at time zone timezone)::date::text as today from households where id = $1`,
    [householdId]
  )
  return rows[0]?.today ?? new Date().toISOString().slice(0, 10)
}

const daysBetween = (fromIso: string, toIso: string) =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000)

const lateBy = (n: number) => (n <= 0 ? 'Due today' : n === 1 ? '1 day late' : `${n} days late`)

function agoLabel(days: number): string {
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  const weeks = Math.floor(days / 7)
  return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`
}

// ─── Destinations ──────────────────────────────────────────────────────────

// Same card, different verbs: group A is triage, group B is a note that might be nothing,
// so two of its choices settle it here.
const DESTINATIONS: Record<LooseEndGroup, LooseEndDestination[]> = {
  notDone: [
    { to: 'tasks', label: 'Tasks', hint: 'Give it an owner and a day', primary: true },
    { to: 'calendar', label: 'Calendar', hint: 'It needs an appointment slot' },
    { to: 'kids', label: 'Kids', hint: "It's really one of the kids'" },
    { to: 'goals', label: 'Goals', hint: 'It belongs to a goal' },
  ],
  parked: [
    { to: 'tasks', label: 'Make it a task', hint: 'Someone owns it this week', primary: true },
    { to: 'calendar', label: 'Put it on the calendar', hint: 'A date to look, or a deadline' },
  ],
}

// Only steps this household runs — a destination pointing at a skipped step would route
// things into a void.
async function availableDestinations(
  householdId: string
): Promise<{ notDone: LooseEndDestination[]; parked: LooseEndDestination[] }> {
  const steps = await resolveSteps(householdId, null)
  const live = new Set(steps.filter((s) => s.available).map((s) => s.key))
  return {
    notDone: DESTINATIONS.notDone.filter((d) => live.has(d.to)),
    parked: DESTINATIONS.parked.filter((d) => live.has(d.to)),
  }
}

// ─── "Not done" · the four reads ───────────────────────────────────────────

// Overdue chore instances. `awaiting` is excluded on purpose: it is the approver's
// business, not the week's.
async function overdueChores(householdId: string, today: string): Promise<SourceEnd[]> {
  const { rows } = await query<{
    id: string
    due_on: string
    requires_photo: boolean
    title: string
    emoji: string | null
    person_id: string | null
  }>(
    // `ci.person_id`, not the chore's: an instance can be reassigned for the day, and the
    // instance is what is late.
    `select ci.id, ci.due_on::text as due_on, ci.requires_photo, c.title, c.emoji, ci.person_id
       from chore_instances ci
       join chores c on c.id = ci.chore_id and c.deleted_at is null
      where ci.household_id = $1
        and ci.deleted_at is null
        and ci.status in ('pending','expired')
        and ci.due_on < $2::date
      order by ci.due_on
      limit ${PER_SOURCE_LIMIT}`,
    [householdId, today]
  )
  return rows.map((r) => ({
    key: `chore:${r.id}`,
    kind: 'chore' as const,
    id: r.id,
    title: r.title,
    emoji: r.emoji,
    ownerId: r.person_id,
    detail: lateBy(daysBetween(r.due_on, today)),
    // No "it's done already" when the chore demands a photo: no camera in a planning
    // session, so route it instead.
    actions: (r.requires_photo ? [] : ['done']) as LooseEndAction[],
  }))
}

// Unchecked items on the lists a person actually KEEPS, already open before this week
// began.
//
// ONLY `list_type = 'custom'` — an allowlist, so a new list kind has to argue its way in.
// GROCERY rebuilds itself from the meal plan every week, so an unchecked "Whole milk"
// says nothing about the week that ended (and, being the biggest list in the house, would
// crowd out the real leftovers under PER_SOURCE_LIMIT). TEMPLATES keep every item
// `checked = false` by design (0072) and are hidden from the Lists rail, so they would
// flood forever from somewhere the user cannot see.
//
// The age anchor is the household's CURRENT week start, not the week being planned: the
// planned week is always today or later, so anchoring there filters nothing at all. The
// lists this step COULD ask about — the same allowlist the read below applies, lifted out
// so the setting is offered over exactly the same set.
export interface PlanningListCandidate {
  id: string
  name: string
  emoji: string | null
  // How it currently stands: false only when the household has ruled it out.
  relevant: boolean
}

export async function planningListCandidates(householdId: string): Promise<PlanningListCandidate[]> {
  const [{ rows }, config] = await Promise.all([
    query<{ id: string; name: string; emoji: string | null }>(
      `select id, name, emoji
         from lists
        where household_id = $1 and deleted_at is null and list_type = 'custom'
        order by lower(name)`,
      [householdId]
    ),
    getConfig(householdId),
  ])
  return rows.map((r) => ({ ...r, relevant: config.lists[r.id] !== false }))
}

async function staleListItems(
  householdId: string, currentWeek: string, plannedWeek: string, listIds: string[]
): Promise<SourceEnd[]> {
  const { rows } = await query<{
    id: string
    name: string
    week_start: string | null
    list_name: string
    emoji: string | null
  }>(
    `select li.id, li.name, li.week_start::text as week_start, l.name as list_name, l.emoji
       from list_items li
       join lists l on l.id = li.list_id and l.deleted_at is null
       join households h on h.id = li.household_id
      where li.household_id = $1
        and li.deleted_at is null
        -- The allowlist. Grocery rebuilds itself; a template is unchecked by design.
        and l.list_type = 'custom'
        -- …and of those, only the lists this household wants asked about. Never called
        -- with an empty array: the caller skips the read instead, because matching
        -- against an empty array is an expensive way to select nothing.
        and l.id = any($4::uuid[])
        and li.checked = false
        -- 'suggested' rows are a proposal nobody has accepted; they are not open work.
        and li.status = 'active'
        and li.created_at < ($2::date::timestamp at time zone h.timezone)
        -- A row keyed to the week being planned (or a later one) is that week's work,
        -- not last week's leftover. NULL = a row that belongs to no week, judged on
        -- its age alone — which is every custom-list row today, since week_start is a
        -- grocery column. The clause stays as the guard for any future surface that
        -- keys a custom row to a week.
        and (li.week_start is null or li.week_start < $3::date)
      order by li.created_at
      limit ${PER_SOURCE_LIMIT}`,
    [householdId, currentWeek, plannedWeek, listIds]
  )
  return rows.map((r) => ({
    key: `list:${r.id}`,
    kind: 'list' as const,
    id: r.id,
    title: r.name,
    emoji: r.emoji,
    // A LIST HAS NO OWNER. `list_items.created_by` is provenance, not ownership.
    ownerId: null,
    detail: `on ${r.list_name}`,
    actions: ['done'] as LooseEndAction[],
  }))
}

// Rhythms past due, straight off the rhythms module's own attention query — the one place
// that knows how period boundaries tile. The horizon is today: a rhythm not late yet is
// next week's problem.
async function rhythmsPastDue(householdId: string, today: string): Promise<SourceEnd[]> {
  const attention = await listAttention(householdId, today)
  const out: SourceEnd[] = []
  for (const item of attention) {
    if (item.kind === 'due') {
      if (!item.overdue) continue
      out.push({
        key: `rhythm:${item.rhythm.id}`,
        kind: 'rhythm',
        id: item.rhythm.id,
        title: item.rhythm.title,
        emoji: item.rhythm.emoji,
        ownerId: item.rhythm.personId,
        detail: lateBy(daysBetween(item.dueAt.slice(0, 10), today)),
        actions: ['done'],
      })
    } else {
      out.push({
        key: `rhythm:${item.rhythm.id}`,
        kind: 'rhythm',
        id: item.rhythm.id,
        title: item.rhythm.title,
        emoji: item.rhythm.emoji,
        ownerId: item.rhythm.personId,
        detail: 'Nothing booked for this period',
        // "It's done already" on an unbooked period means the period is settled — in the
        // rhythms module, a skip.
        actions: ['done'],
      })
    }
  }
  return out.slice(0, PER_SOURCE_LIMIT)
}

// `periodDone` is the goals module's read of the CURRENT period — a habit is this
// period's count, never a lifetime.
async function shortHabits(householdId: string): Promise<SourceEnd[]> {
  const goals = await listGoals(householdId)
  return goals
    .filter((g) => g.goalType === 'habit' && g.habitPeriod === 'week')
    .filter((g) => g.periodDone < Math.max(1, g.habitTargetPerPeriod ?? 1))
    .slice(0, PER_SOURCE_LIMIT)
    .map((g) => ({
      key: `goal:${g.id}`,
      kind: 'goal' as const,
      id: g.id,
      title: g.title,
      emoji: g.emoji,
      // ONE participant and a per-person basis ⇒ it is theirs. A family habit belongs to
      // everybody.
      ownerId: g.targetBasis !== 'family' && g.participants?.length === 1
        ? (g.participants[0] as { personId: string }).personId
        : null,
      detail: `${g.periodDone} of ${Math.max(1, g.habitTargetPerPeriod ?? 1)} this week`,
      actions: ['done'] as LooseEndAction[],
    }))
}

// ─── "Parked" · the one group with a table ─────────────────────────────────

export interface ParkedItem {
  id: string
  note: string
  stepKey: string | null
  status: 'open' | 'resolved' | 'dropped'
  sessionId: string | null
  createdAt: string
}

interface ParkedRow {
  id: string
  note: string
  step_key: string | null
  status: string
  session_id: string | null
  created_at: Date
}

const toParked = (r: ParkedRow): ParkedItem => ({
  id: r.id,
  note: r.note,
  stepKey: r.step_key,
  status: r.status === 'resolved' ? 'resolved' : r.status === 'dropped' ? 'dropped' : 'open',
  sessionId: r.session_id,
  createdAt: r.created_at.toISOString(),
})

export async function listParked(householdId: string): Promise<LooseEnd[]> {
  const { rows } = await query<ParkedRow & { parker: string | null; age_days: number; passed_over: number }>(
    `select pi.id, pi.note, pi.step_key, pi.status, pi.session_id, pi.created_at,
            p.name as parker,
            greatest(0, (now()::date - pi.created_at::date)) as age_days,
            -- "Passed over N times": how many planning sessions have FINISHED since
            -- somebody wrote this down. Derived rather than counted into a column —
            -- a counter would need something to advance it, and nothing here runs on
            -- a timer (the same reasoning as the rhythms period grid).
            (select count(*) from planning_sessions s
              where s.household_id = pi.household_id
                and s.status = 'completed'
                and s.completed_at > pi.created_at) as passed_over
       from planning_parked_items pi
       left join persons p on p.id = pi.created_by and p.deleted_at is null
      where pi.household_id = $1 and pi.status = 'open'
      order by pi.created_at
      limit ${PER_SOURCE_LIMIT}`,
    [householdId]
  )
  return rows.map((r) => {
    const bits = [r.parker ? `Parked by ${r.parker}` : 'Parked', agoLabel(Number(r.age_days))]
    const passed = Number(r.passed_over)
    // The line has to earn the "Drop it" underneath it: a note three sessions have walked
    // past was never really a thing.
    if (passed > 0) bits.push(passed === 1 ? 'passed over once' : `passed over ${passed} times`)
    return {
      key: `parked:${r.id}`,
      kind: 'parked' as const,
      id: r.id,
      title: r.note,
      emoji: null,
      owner: null,
      detail: bits.join(' · '),
      // 'done' is "Talk about it now"; 'drop' is the answer only this group can take,
      // because the note exists nowhere else.
      actions: ['done', 'drop'] as LooseEndAction[],
    }
  })
}

export interface ParkInput {
  note?: unknown
  // Optional tag naming the step that should ACT on this note — always a destination,
  // never the step that wrote it. Step 1's capture bar leaves it null; routing sets it;
  // step 3 sets it when somebody parks against a tag, writing the SAME values so
  // consumers can't tell the producers apart. Step 10 reads a null tag as "nobody said
  // yet".
  stepKey?: unknown
  // The session it was parked during, if any. The row survives that session being
  // discarded (on delete set null).
  sessionId?: unknown
}

export type ParkResult =
  | { ok: true; item: ParkedItem }
  | { ok: false; status: 400; error: string; message: string }

const MAX_NOTE = 500

// Park a note. Step 1's capture bar writes here, and so does step 3 from the month view.
// The table and this function are deliberately general so a later surface needs no
// migration.
export async function parkItem(tenant: Tenant, input: ParkInput): Promise<ParkResult> {
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (!note) return { ok: false, status: 400, error: 'BadRequest', message: 'a parked item needs a note' }
  if (note.length > MAX_NOTE) {
    return { ok: false, status: 400, error: 'BadRequest', message: `a note is at most ${MAX_NOTE} characters` }
  }
  let stepKey: string | null = null
  if (input.stepKey !== undefined && input.stepKey !== null) {
    if (!isStepKey(input.stepKey)) return { ok: false, status: 400, error: 'BadRequest', message: 'unknown step' }
    stepKey = input.stepKey
  }
  let sessionId: string | null = null
  if (input.sessionId !== undefined && input.sessionId !== null) {
    if (typeof input.sessionId !== 'string' || !UUID_RE.test(input.sessionId)) {
      return { ok: false, status: 400, error: 'BadRequest', message: 'sessionId must be a session id' }
    }
    // Household-scoped: a session id from somewhere else must not be recorded here.
    if (!(await getSessionById(tenant.householdId, input.sessionId))) {
      return { ok: false, status: 400, error: 'BadRequest', message: 'session not found' }
    }
    sessionId = input.sessionId
  }
  const { rows } = await query<ParkedRow>(
    `insert into planning_parked_items (household_id, note, step_key, session_id, created_by)
     values ($1, $2, $3, $4, $5)
     returning id, note, step_key, status, session_id, created_at`,
    [tenant.householdId, note, stepKey, sessionId, tenant.personId]
  )
  return { ok: true, item: toParked(rows[0]) }
}

// ─── Routes — the cross-step contract ──────────────────────────────────────

const isRoute = (v: unknown): v is LooseEndRoute => {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return typeof r.kind === 'string' && typeof r.id === 'string' && typeof r.to === 'string'
}

// Later steps get the same array off the session view; this exists so step 1's own read
// is self-contained.
export async function listRoutes(sessionId: string): Promise<LooseEndRoute[]> {
  const { rows } = await query<{ data: { routes?: unknown } | null }>(
    `select data from planning_session_steps where session_id = $1 and step_key = 'looseEnds'`,
    [sessionId]
  )
  const raw = rows[0]?.data?.routes
  return Array.isArray(raw) ? raw.filter(isRoute) : []
}

// Replace the whole array on the step's `data`, preserving any other key the shell put
// there. Single-driver by design, so a read-modify-write is safe; `driver_person_id` is
// the seam if that changes.
async function writeRoutes(sessionId: string, routes: LooseEndRoute[]): Promise<void> {
  await query(
    `insert into planning_session_steps (session_id, step_key, status, data, decided_at)
     values ($1, 'looseEnds', 'pending', jsonb_build_object('routes', $2::jsonb), now())
     on conflict (session_id, step_key)
       -- Only the routes key. The step's STATUS is the shell's to set when somebody
       -- answers the step, and clobbering it here would mark a step decided that
       -- nobody has finished.
       do update set data = coalesce(planning_session_steps.data, '{}'::jsonb)
                            || jsonb_build_object('routes', $2::jsonb)`,
    [sessionId, JSON.stringify(routes)]
  )
}

export interface RouteInput {
  sessionId?: unknown
  kind?: unknown
  id?: unknown
  title?: unknown
  source?: unknown
  // The step that will handle it — or null to undo the routing.
  to?: unknown
}

export type RouteResult =
  | { ok: true; routes: LooseEndRoute[] }
  | { ok: false; status: 400 | 404; error: string; message: string }

const KINDS: LooseEndKind[] = ['chore', 'list', 'rhythm', 'goal', 'parked']
const GROUPS: LooseEndGroup[] = ['notDone', 'parked']

// Route an item to the step that will handle it — or un-route it (`to: null`), which the
// undo trail under the card calls.
//
// THIS WRITES NOTHING TO ANY MODULE; all that changes is which step will be looking at
// the item. The one exception is a PARKED note, whose `step_key` is set here.
export async function routeLooseEnd(tenant: Tenant, input: RouteInput): Promise<RouteResult> {
  const bad400 = (message: string): RouteResult => ({ ok: false, status: 400, error: 'BadRequest', message })

  if (typeof input.sessionId !== 'string' || !UUID_RE.test(input.sessionId)) return bad400('sessionId must be a session id')
  const session = await getSessionById(tenant.householdId, input.sessionId)
  if (!session) return { ok: false, status: 404, error: 'NotFound', message: 'session not found' }

  const kind = KINDS.find((k) => k === input.kind)
  if (!kind) return bad400('kind must be one of chore, list, rhythm, goal, parked')
  if (typeof input.id !== 'string' || !UUID_RE.test(input.id)) return bad400('id must be a uuid')
  const id = input.id

  const routes = (await listRoutes(session.id)).filter((r) => !(r.kind === kind && r.id === id))

  if (input.to === null || input.to === undefined) {
    await writeRoutes(session.id, routes)
    if (kind === 'parked') await setParkedStepKey(tenant.householdId, id, null)
    return { ok: true, routes }
  }

  const problem = await destinationProblem(tenant.householdId, input.to)
  if (problem) return bad400(problem)
  const to = input.to as string
  const source = GROUPS.find((g) => g === input.source) ?? (kind === 'parked' ? 'parked' : 'notDone')
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, MAX_NOTE) : ''
  if (!title) return bad400('a route needs the title it was routed under')

  if (kind === 'parked' && !(await setParkedStepKey(tenant.householdId, id, to))) {
    return { ok: false, status: 404, error: 'NotFound', message: 'loose end not found' }
  }

  const next = [...routes, { kind, id, title, source, to }]
  await writeRoutes(session.id, next)
  return { ok: true, routes: next }
}

// IS THIS A STEP A NOTE MAY BE ADDRESSED TO? One answer, two callers — `routeLooseEnd`
// and `updateParkedItem` — because a tag set by editing must be exactly as restricted as
// one set by routing. Returns the sentence to refuse with, or null when the step is fair.
//
// WHICH TRAILS QUOTE THIS NOTE. Not "the current session": sessions are per WEEK and
// several can be open at once, so the query asks for every open trail that would be left
// saying something the note no longer says. Completed sessions are excluded — their
// record is what the family decided that evening and stands as history.
async function sessionsQuoting(householdId: string, id: string): Promise<string[]> {
  const { rows } = await query<{ session_id: string }>(
    `select ss.session_id
       from planning_session_steps ss
       join planning_sessions s on s.id = ss.session_id
      where s.household_id = $1 and s.status = 'active'
        and ss.step_key = 'looseEnds'
        and ss.data -> 'routes' @> $2::jsonb`,
    [householdId, JSON.stringify([{ kind: 'parked', id }])]
  )
  return rows.map((r) => r.session_id)
}

async function destinationProblem(householdId: string, to: unknown): Promise<string | null> {
  if (!isStepKey(to)) return 'unknown step'
  if (to === 'looseEnds') return 'a loose end cannot be routed to the step it came from'
  const steps = await resolveSteps(householdId, null)
  if (!steps.some((s) => s.key === to && s.available)) {
    return `the ${to} step is not running in this household`
  }
  return null
}

async function setParkedStepKey(householdId: string, id: string, stepKey: string | null): Promise<boolean> {
  const { rowCount } = await query(
    `update planning_parked_items set step_key = $3 where household_id = $1 and id = $2 and status = 'open'`,
    [householdId, id, stepKey]
  )
  return !!rowCount
}

// ─── Editing a note that is already parked ─────────────────────────────────

export interface UpdateParkedInput {
  // ABSENT MEANS "LEAVE IT ALONE" for both fields, which is why they are read for
  // PRESENCE: `stepKey: null` is a real answer ("No tag") and has to be tellable from
  // "only fixing the words".
  note?: unknown
  stepKey?: unknown
  // The session being planned, if any. Used for one thing: keeping its route trail
  // agreeing with the tag.
  sessionId?: unknown
}

export type UpdateParkedResult =
  | { ok: true; item: ParkedItem; routes: LooseEndRoute[] | null }
  | { ok: false; status: 400 | 404; error: string; message: string }

/**
 * Fix a parked note's words, or re-address it to a different step.
 *
 * THE COLUMN IS THE EASY HALF. A tag lives in two places at once whenever step 1 put it
 * there: `planning_parked_items.step_key`, and a `{ kind:'parked', id, title, to }` entry
 * on the looseEnds step's `data.routes` (see `routeLooseEnd`). Change one without the
 * other and the note's badge says Meals while step 1's trail says Tasks. So:
 *
 *   · the words change   → the route entry's `title`, which QUOTED them, changes too
 *   · the tag moves      → the route entry's `to` moves with it
 *   · the tag is cleared → the route entry is RETIRED, converging with `routeLooseEnd`'s undo
 *   · there is no entry  → nothing is written to the session; inventing an entry would
 *                          manufacture a state parking itself can never produce
 *
 * `sessionId` is OPTIONAL because the gold box is not session-scoped. Without one the
 * trail is still repaired: `sessionsQuoting` finds every OPEN session whose trail names
 * this note. A named session is repaired even if it holds no entry, and is the one echoed
 * back.
 */
export async function updateParkedItem(
  tenant: Tenant,
  id: unknown,
  input: UpdateParkedInput
): Promise<UpdateParkedResult> {
  const bad400 = (message: string): UpdateParkedResult => ({ ok: false, status: 400, error: 'BadRequest', message })
  if (typeof id !== 'string' || !UUID_RE.test(id)) return bad400('id must be a uuid')

  const touchNote = input.note !== undefined
  const touchTag = input.stepKey !== undefined
  if (!touchNote && !touchTag) return bad400('nothing to change')

  // Same cap and trim as `parkItem`: an edit must not store a note the bar could never
  // have parked.
  let note: string | null = null
  if (touchNote) {
    if (typeof input.note !== 'string') return bad400('a parked item needs a note')
    note = input.note.trim()
    if (!note) return bad400('a parked item needs a note')
    if (note.length > MAX_NOTE) return bad400(`a note is at most ${MAX_NOTE} characters`)
  }

  let stepKey: string | null = null
  if (touchTag && input.stepKey !== null) {
    const problem = await destinationProblem(tenant.householdId, input.stepKey)
    if (problem) return bad400(problem)
    stepKey = input.stepKey as string
  }

  // `status = 'open'`: a note that has been talked through or dropped is answered, and
  // answered is not editable.
  const { rows } = await query<ParkedRow>(
    `update planning_parked_items
        set note = coalesce($3::text, note),
            step_key = case when $4::boolean then $5::text else step_key end
      where household_id = $1 and id = $2 and status = 'open'
      returning id, note, step_key, status, session_id, created_at`,
    [tenant.householdId, id, note, touchTag, stepKey]
  )
  const row = rows[0]
  if (!row) return { ok: false, status: 404, error: 'NotFound', message: 'loose end not found' }

  // The other half of the tag, scoped to the session we were handed — the same shape as
  // `resolveLooseEnd`'s `retire()`.
  const named =
    typeof input.sessionId === 'string' && UUID_RE.test(input.sessionId)
      ? (await getSessionById(tenant.householdId, input.sessionId))?.id ?? null
      : null
  // The caller's own session first (its trail is repaired even when it holds no entry),
  // then every other open trail.
  const targets = new Set(named ? [named] : [])
  for (const s of await sessionsQuoting(tenant.householdId, id)) targets.add(s)

  let routes: LooseEndRoute[] | null = null
  for (const sessionId of targets) {
    const current = await listRoutes(sessionId)
    const entry = current.find((r) => r.kind === 'parked' && r.id === id)
    let next = current
    // NO ENTRY, NO WRITE — inventing one would manufacture a state parking itself cannot
    // produce.
    if (entry) {
      next =
        touchTag && row.step_key === null
          ? current.filter((r) => r !== entry)
          : current.map((r) =>
              r === entry ? { ...r, title: row.note, ...(row.step_key ? { to: row.step_key } : {}) } : r
            )
      await writeRoutes(sessionId, next)
    }
    // The answer echoes the trail the CALLER asked about; the rest are repaired quietly.
    if (sessionId === named) routes = next
  }

  return { ok: true, item: toParked(row), routes }
}

// ─── The read ──────────────────────────────────────────────────────────────

const SOURCE_LABELS: [ModuleKey, string][] = [
  ['chores', 'chores'],
  ['lists', 'lists'],
  ['rhythms', 'rhythms'],
  ['goals', 'goals'],
]

export async function getLooseEnds(householdId: string, weekStart: string, sessionId?: string | null): Promise<LooseEndsView> {
  const [settings, today, currentWeek, destinations] = await Promise.all([
    householdSettings(householdId),
    todayLocal(householdId),
    earliestWeekStart(householdId),
    availableDestinations(householdId),
  ])
  // Which lists count is a second gate BEHIND the module toggle: the module being on says
  // the household keeps lists, this says which of them the step is about. CANDIDATES and
  // ASKABLE are kept apart because the `sources` line below must tell "no custom lists
  // yet" (vacuous) from "ruled them all out" (the setting being used).
  const listCandidates = enabled(settings, 'lists') ? await planningListCandidates(householdId) : []
  const askableLists = listCandidates.filter((l) => l.relevant).map((l) => l.id)
  const [chores, lists, rhythms, goals, parked, routes, people] = await Promise.all([
    enabled(settings, 'chores') ? overdueChores(householdId, today) : Promise.resolve([]),
    askableLists.length ? staleListItems(householdId, currentWeek, weekStart, askableLists) : Promise.resolve([]),
    enabled(settings, 'rhythms') ? rhythmsPastDue(householdId, today) : Promise.resolve([]),
    enabled(settings, 'goals') ? shortHabits(householdId) : Promise.resolve([]),
    listParked(householdId),
    sessionId ? listRoutes(sessionId) : Promise.resolve([]),
    peopleById(householdId),
  ])
  // Chores, lists, slow-burning maintenance, then habits: most-urgent to least, the order
  // the deck walks.
  const notDone = withOwners([...chores, ...lists, ...rhythms, ...goals], people)
  return {
    weekStart,
    notDone,
    parked,
    counts: { notDone: notDone.length, parked: parked.length },
    destinations,
    routes,
    // "We checked chores, lists, rhythms and goals" has to be true: a household that
    // ruled every list out was not asking about lists. Having NO custom lists is vacuous
    // rather than false, so it keeps the word.
    sources: SOURCE_LABELS
      .filter(([k]) => enabled(settings, k)
        && (k !== 'lists' || listCandidates.length === 0 || askableLists.length > 0))
      .map(([, label]) => label),
    lists: listCandidates,
  }
}

// ─── The two answers that write ────────────────────────────────────────────

export interface ResolveInput {
  kind?: unknown
  id?: unknown
  action?: unknown
  // Keeps the routes contract honest: a settled item must not stay in `data.routes`, or a
  // later step would render a row its own module considers done. Given a session, its
  // route entry is retired here.
  sessionId?: unknown
}

export type ResolveResult =
  | { ok: true; kind: LooseEndKind; id: string; action: LooseEndAction }
  | { ok: false; status: 400 | 403 | 404; error: string; message: string }

const ACTIONS: LooseEndAction[] = ['done', 'drop']

// Which optional module owns each kind. `parked` has none — it is ours, and needs no
// second gate.
const OWNER: Record<LooseEndKind, ModuleKey | null> = {
  chore: 'chores',
  list: 'lists',
  rhythm: 'rhythms',
  goal: 'goals',
  parked: null,
}

const bad = (message: string): ResolveResult => ({ ok: false, status: 400, error: 'BadRequest', message })
const missing = (): ResolveResult => ({ ok: false, status: 404, error: 'NotFound', message: 'loose end not found' })
const wrongAction = (kind: string, action: string): ResolveResult =>
  ({ ok: false, status: 400, error: 'BadRequest', message: `a ${kind} cannot be resolved with "${action}"` })

// The exceptions to "step 1 changes nothing": `done`, and `drop` on a parked note. Both
// write into the owner.
export async function resolveLooseEnd(tenant: Tenant, input: ResolveInput): Promise<ResolveResult> {
  const kind = KINDS.find((k) => k === input.kind)
  if (!kind) return bad('kind must be one of chore, list, rhythm, goal, parked')
  const action = ACTIONS.find((a) => a === input.action)
  if (!action) return bad('action must be one of done, drop')
  if (typeof input.id !== 'string' || !UUID_RE.test(input.id)) return bad('id must be a uuid')
  const id = input.id
  if (action === 'drop' && kind !== 'parked') {
    // Dropping a computed item would mean deleting another module's data, which is what
    // routing exists to avoid.
    return wrongAction(kind, 'drop')
  }

  // `moduleRoutes('weeklyPlanning')` says only that planning is on, so without this a
  // session could write into a disabled module.
  const owner = OWNER[kind]
  if (owner && !enabled(await householdSettings(tenant.householdId), owner)) {
    return { ok: false, status: 403, error: 'Forbidden', message: `The ${owner} module is not enabled` }
  }

  // A settled item stops being routed anywhere. Doing it on the WRITE side is why routes
  // is a decision log, not a queue.
  const retire = async (): Promise<ResolveResult> => {
    if (typeof input.sessionId === 'string' && UUID_RE.test(input.sessionId)) {
      const session = await getSessionById(tenant.householdId, input.sessionId)
      if (session) {
        const routes = await listRoutes(session.id)
        const next = routes.filter((r) => !(r.kind === kind && r.id === id))
        if (next.length !== routes.length) await writeRoutes(session.id, next)
      }
    }
    return { ok: true, kind, id, action }
  }

  switch (kind) {
    case 'chore':
      return (await resolveChore(tenant, id)) ?? (await retire())
    case 'list':
      return (await resolveListItem(tenant, id)) ?? (await retire())
    case 'rhythm':
      return (await resolveRhythm(tenant, id)) ?? (await retire())
    case 'goal':
      return (await resolveGoal(tenant, id)) ?? (await retire())
    case 'parked':
      return (await resolveParked(tenant, id, action)) ?? (await retire())
  }
}

// Each helper returns a ResolveResult only on failure; null means the module took the
// write.

async function resolveChore(tenant: Tenant, id: string): Promise<ResolveResult | null> {
  const { rows } = await query<{ id: string }>(
    `select id from chore_instances where household_id = $1 and id = $2 and deleted_at is null`,
    [tenant.householdId, id]
  )
  if (!rows[0]) return missing()
  try {
    return (await completeInstance(tenant, id)) ? null : missing()
  } catch (err) {
    // No camera in a planning session. The read withholds the answer; this is the honest
    // reply if something asks anyway.
    if (err instanceof ProofRequiredError) {
      return { ok: false, status: 400, error: 'ProofRequired', message: 'this chore needs a photo — complete it on the Tasks board' }
    }
    throw err
  }
}

async function resolveListItem(tenant: Tenant, id: string): Promise<ResolveResult | null> {
  return (await setItemChecked(tenant, id, true)) ? null : missing()
}

async function resolveRhythm(tenant: Tenant, id: string): Promise<ResolveResult | null> {
  const { rows } = await query<{ satisfied_by: string }>(
    `select satisfied_by from rhythms where household_id = $1 and id = $2 and deleted_at is null`,
    [tenant.householdId, id]
  )
  if (!rows[0]) return missing()
  if (rows[0].satisfied_by === 'completion') {
    return (await completeRhythm(tenant.householdId, id, tenant.personId, null, null)) ? null : missing()
  }

  // A scheduling rhythm is satisfied by an event existing, so "it's done already" on an
  // unbooked period is a skip. The period start is re-derived from the rhythms module's
  // own tiling and never taken from a client, whose boundary may be a render old —
  // `skipPeriod` reports success on a non-boundary date while silencing nothing.
  const today = await todayLocal(tenant.householdId)
  const attention = await listAttention(tenant.householdId, today)
  const item = attention.find((a) => a.kind === 'unscheduled' && a.rhythm.id === id)
  if (!item || item.kind !== 'unscheduled') {
    return { ok: false, status: 400, error: 'nothing-to-settle', message: 'this rhythm has no open period to settle' }
  }
  await skipPeriod(tenant.householdId, id, item.periodStart, tenant.personId)
  return null
}

async function resolveGoal(tenant: Tenant, id: string): Promise<ResolveResult | null> {
  const { rows } = await query<{ id: string }>(
    `select id from goals where household_id = $1 and id = $2 and deleted_at is null and is_active`,
    [tenant.householdId, id]
  )
  if (!rows[0]) return missing()
  // One, against the household — what a habit tick is worth anywhere else. `source` marks
  // it as a planning catch-up.
  await logProgress(tenant, id, 1, [null], null, { source: 'weekly_planning' })
  return null
}

async function resolveParked(tenant: Tenant, id: string, action: LooseEndAction): Promise<ResolveResult | null> {
  const status = action === 'done' ? 'resolved' : 'dropped'
  const { rowCount } = await query(
    `update planning_parked_items
        set status = $3, resolved_at = now(), resolved_by = $4
      where household_id = $1 and id = $2 and status = 'open'`,
    [tenant.householdId, id, status, tenant.personId]
  )
  return rowCount ? null : missing()
}
