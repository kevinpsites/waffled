// Weekly Planning · step 10 "Recap" — read the week back, then it's over.
//
// THIS STEP STORES NOTHING: every line is resolved on read out of the module that owns
// the decision, so a decision undone elsewhere changes the line instead of making the
// record lie. Session-relative counts come from provenance (`created_at >= started_at`).
// Full rationale: docs/product/weekly-planning-plan.md § "The recap stores nothing".
import { query } from '../../../platform/db'
import { moduleEnabled, type ModuleKey } from '../../../platform/modules'
import { visibleTo } from '../../events/events'
import type { Tenant } from '../../households/households'
import { STEPS, resolveSteps, type Session } from '../weeklyPlanning'
import { mealsStepView, addDays } from './meals'
import { getTasksBoard } from './tasks'
import { getGoalsStepView } from './goals'
import { getFamilyNightBoard } from './familyNight'
import { listParked } from './looseEnds'

// Capped because an uncapped column grows past its grid box and paints over the card
// under it.
const DAY_CAP = 4
const DETAIL_CAP = 6
// The last call is a prompt, not an inbox. `listParked` itself caps at 200.
const LAST_CALL_CAP = 6
// Meal-plan mirrors: planning a dinner writes a real event, so anything reading `events`
// naively reports the meal plan twice. The exclusion meals/kids/goal-calendar make too.
const MIRROR_ORIGINS = ['meal_plan', 'meal_prep']

export interface RecapDay {
  date: string
  // Null when the meals module is off too — a week of events, not a row of blanks.
  meal: string | null
  cook: string | null
  // The inputs the CLIENT's own `eventColor` needs, so the week strip is tinted by the
  // same rule as the month view. The colour is deliberately not resolved here.
  events: {
    id: string
    title: string
    when: string
    personId: string | null
    personName: string | null
    personColor: string | null
    participantIds: string[]
  }[]
  more: number
}

export interface RecapGroup {
  key: string
  label: string
  headline: string
  detail: string
  count: number
  stepKey: string | null
}

export interface RecapLastCall {
  id: string
  note: string
  // Composed by listParked, so this line reads identically in step 1's deck and here.
  detail: string | null
}

export interface RecapLeftAlone {
  key: string
  label: string
  detail: string
  // 'skipped' — the step was passed over on purpose; 'none' — it was answered and the
  // answer was "nothing"; 'parked' — notes waiting for a step that will look at them.
  badge: 'skipped' | 'none' | 'parked'
  stepKey: string | null
}

export interface RecapView {
  weekStart: string
  savedAt: string | null
  days: RecapDay[]
  groups: RecapGroup[]
  lastCall: RecapLastCall[]
  lastCallMore: number
  leftAlone: RecapLeftAlone[]
  // Derived on every read — never stored, never added up on the client, so the header
  // and the cards cannot disagree.
  counts: { decisions: number; deferred: number; parked: number }
}

// ─── Small shared bits ─────────────────────────────────────────────────────

const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const weekdayOf = (iso: string) => WD[new Date(`${iso.slice(0, 10)}T00:00:00Z`).getUTCDay()]
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const join = (bits: (string | null | undefined)[]) => bits.filter(Boolean).join(' · ')

function whenLabel(at: Date | string, allDay: boolean, tz: string): string {
  const d = new Date(at)
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(d)
  if (allDay) return `${day}, all day`
  return `${day} ${new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d)}`
}

const householdRow = async (householdId: string) => {
  const { rows } = await query<{ settings: unknown; timezone: string | null }>(
    `select settings, timezone from households where id = $1`,
    [householdId]
  )
  return { settings: rows[0]?.settings ?? null, tz: (rows[0]?.timezone ?? '').trim() || 'UTC' }
}

const stepTitle = (key: string) => STEPS.find((s) => s.key === key)?.title ?? key

// ─── Provenance: what THIS session changed ─────────────────────────────────

interface AddedEvent { id: string; title: string; when: string }

// PROVENANCE, NOT A COPY. `created_at >= started_at` answers "did this appear during the
// session?" every time it is asked, so deleting the event takes the line away with it,
// where a count written down at decision time would claim it forever. It credits
// anything added during the window, including from another screen — the deliberate
// trade against a crumb, which silently forgets. Recurring events are matched through
// their occurrences too: a weekly thing added on Sunday for Tuesdays has no `starts_at`.
async function eventsAddedSince(
  householdId: string,
  since: string,
  weekStart: string,
  viewerPersonId: string | null,
  tz: string
): Promise<AddedEvent[]> {
  const { rows } = await query<{ id: string; title: string; starts_at: Date; all_day: boolean }>(
    `select e.id, e.title, e.starts_at, e.all_day
       from events e
       join households h on h.id = e.household_id
      where e.household_id = $1
        and e.deleted_at is null
        and e.created_at >= $2
        and coalesce(e.origin, 'manual') <> all($5::text[])
        ${visibleTo('e', '$6')}
        and (
          (e.starts_at at time zone h.timezone)::date between $3::date and $4::date
          or exists (
            select 1 from event_occurrences o
             where o.event_id = e.id and o.deleted_at is null
               and (o.starts_at at time zone h.timezone)::date between $3::date and $4::date
          )
        )
      order by e.starts_at
      limit 50`,
    [householdId, since, weekStart, addDays(weekStart, 6), MIRROR_ORIGINS, viewerPersonId]
  )
  return rows.map((r) => ({ id: r.id, title: r.title, when: whenLabel(r.starts_at, r.all_day, tz) }))
}

// Same provenance rule on meal_plan_entries: un-plan the night and the line goes too.
async function dinnersPlannedSince(householdId: string, since: string, weekStart: string): Promise<{ date: string; title: string | null }[]> {
  const { rows } = await query<{ date: string | Date; title: string | null }>(
    `select e.date, coalesce(r.title, m.name, e.title) as title
       from meal_plan_entries e
       left join recipes r on r.id = e.recipe_id and r.deleted_at is null
       left join meals m on m.id = e.meal_id and m.deleted_at is null
      where e.household_id = $1
        and e.deleted_at is null
        -- 'dinner' mirrors meals.ts's own (unexported) MEAL_TYPE. CHANGE BOTH TOGETHER:
        -- a step counting suppers while the meals step plans dinners would report a
        -- number nobody could find on the board.
        and e.meal_type = 'dinner'
        and e.created_at >= $2
        and e.date between $3::date and $4::date
      order by e.date`,
    [householdId, since, weekStart, addDays(weekStart, 6)]
  )
  return rows.map((r) => ({ date: typeof r.date === 'string' ? r.date.slice(0, 10) : r.date.toISOString().slice(0, 10), title: r.title }))
}

// Both a completion and a deliberate skip carry their own `created_at`, so both are
// provenance rather than bookkeeping.
async function rhythmsSettledSince(householdId: string, since: string): Promise<string[]> {
  const { rows } = await query<{ title: string }>(
    `select r.title
       from rhythm_completions c
       join rhythms r on r.id = c.rhythm_id and r.deleted_at is null
      where c.household_id = $1 and c.created_at >= $2
     union
     select r.title
       from rhythm_skips s
       join rhythms r on r.id = s.rhythm_id and r.deleted_at is null
      where s.household_id = $1 and s.created_at >= $2
      limit 50`,
    [householdId, since]
  )
  return rows.map((r) => r.title)
}

// ─── The parking lot ───────────────────────────────────────────────────────

// Which open notes nobody has tagged. Two reads on purpose: `listParked` composes the
// history line and this says which rows are untagged, so the sentence stays step 1's.
// `step_key` is always a DESTINATION step, never the step that wrote the note (see
// 0101), so "untagged" is exactly "nobody has said which step will look at this".
async function parkedKeys(householdId: string): Promise<Map<string, string | null>> {
  const { rows } = await query<{ id: string; step_key: string | null }>(
    `select id, step_key from planning_parked_items where household_id = $1 and status = 'open'`,
    [householdId]
  )
  return new Map(rows.map((r) => [r.id, r.step_key]))
}

// ─── The read ──────────────────────────────────────────────────────────────

// Which module has to be on for a group to exist, and which step owns it.
interface GroupSpec {
  key: string
  stepKey: string
  requires?: ModuleKey
}
const GROUP_SPECS: GroupSpec[] = [
  { key: 'calendar', stepKey: 'calendar' },
  { key: 'meals', stepKey: 'meals', requires: 'meals' },
  { key: 'tasks', stepKey: 'tasks', requires: 'chores' },
  { key: 'goals', stepKey: 'goals', requires: 'goals' },
  { key: 'familyNight', stepKey: 'familyNight', requires: 'familyNight' },
  { key: 'kids', stepKey: 'kids' },
]

export async function getRecap(tenant: Tenant, weekStart: string, session: Session | null): Promise<RecapView> {
  const householdId = tenant.householdId
  const { settings, tz } = await householdRow(householdId)
  const on = (k: ModuleKey) => moduleEnabled(settings, k)
  // No session ⇒ every provenance window is empty. The week strip still reads, which is
  // what makes the step renderable before a session exists.
  const since = session?.startedAt ?? null

  const steps = await resolveSteps(householdId, session?.id ?? null)
  const byKey = new Map(steps.map((s) => [s.key, s]))

  const [week, tasks, goals, night, kids, parked, parkedTags] = await Promise.all([
    // The seven columns come from the MEALS step's own read: the one place that already
    // buckets a household-local day and drops the mirrors. A second read would drift.
    mealsStepView(tenant, weekStart),
    on('chores') ? getTasksBoard(householdId, weekStart) : null,
    on('goals') && session ? getGoalsStepView(tenant, session.id) : null,
    on('familyNight') ? getFamilyNightBoard(householdId, weekStart) : null,
    session ? kidsReadBack(householdId, session.id) : Promise.resolve([]),
    listParked(householdId),
    parkedKeys(householdId),
  ])

  const [addedEvents, plannedNights, rhythms] = since
    ? await Promise.all([
        eventsAddedSince(householdId, since, weekStart, tenant.personId ?? null, tz),
        on('meals') ? dinnersPlannedSince(householdId, since, weekStart) : Promise.resolve([]),
        on('rhythms') ? rhythmsSettledSince(householdId, since) : Promise.resolve([]),
      ])
    : [[], [], []]

  const mealsOn = on('meals')
  const days: RecapDay[] = week.nights.map((n) => ({
    date: n.date,
    meal: mealsOn ? (n.dinner?.title ?? null) : null,
    cook: mealsOn ? (n.dinner?.cookName ?? null) : null,
    events: n.events.slice(0, DAY_CAP).map((e) => ({
      id: e.id,
      title: e.title,
      when: whenLabel(e.startsAt, e.allDay, tz),
      personId: e.personId,
      personName: e.personName,
      personColor: e.personColor,
      participantIds: e.participantIds,
    })),
    more: Math.max(0, n.events.length - DAY_CAP),
  }))

  const groups: RecapGroup[] = []
  const leftAlone: RecapLeftAlone[] = []

  const weekEvents = week.nights.reduce((n, d) => n + d.events.length, 0)
  if (addedEvents.length) {
    groups.push({
      key: 'calendar',
      label: 'Calendar',
      headline: join([`${plural(addedEvents.length, 'event')} added`, `${weekEvents} on the week now`]),
      detail: addedEvents.slice(0, DETAIL_CAP).map((e) => `${e.title} ${e.when}`).join(' · '),
      count: addedEvents.length,
      stepKey: 'calendar',
    })
  }

  if (mealsOn) {
    const planned = 7 - week.emptyDates.length
    const trip = week.shopping
    const count = plannedNights.length + (trip ? 1 : 0)
    if (count) {
      const tripLine = trip
        ? `${trip.personName ?? 'Nobody yet'} shops ${weekdayOf(trip.dueOn)}${trip.dueTime ? ` ${trip.dueTime}` : ''}`
        : null
      groups.push({
        key: 'meals',
        label: 'Meals + Lists',
        headline: join([
          `${planned} of 7 nights planned`,
          week.groceries ? plural(week.groceries.items, 'grocery', 'groceries') : null,
        ]),
        detail: join([
          ...plannedNights.slice(0, DETAIL_CAP).map((n) => `${weekdayOf(n.date)} · ${n.title ?? 'planned'}`),
          tripLine,
        ]),
        count,
        stepKey: 'meals',
      })
    }
  }

  if (tasks) {
    // A chore is a decision when it has BOTH an owner and a day in the week. A carried-over
    // one-off counts: it arrives without belonging to a day in the week, and somebody owns it.
    const owned = tasks.people.flatMap((p) => p.chores.filter((c) => c.days.length > 0 || c.carriedOver))
    const grabs = tasks.unassigned.filter((c) => c.days.length > 0 || c.carriedOver).length
    const count = owned.length + rhythms.length
    if (count) {
      groups.push({
        key: 'tasks',
        // With rhythms off there is no rhythm line, and the label must not promise one.
        label: on('rhythms') ? 'Chores + Rhythms' : 'Chores',
        headline: join([
          `${plural(owned.length, 'task')} with an owner and a day`,
          rhythms.length ? `${plural(rhythms.length, 'rhythm')} settled` : null,
          grabs ? `${grabs} still up for grabs` : null,
        ]),
        detail: [...owned.map((c) => c.title), ...rhythms].slice(0, DETAIL_CAP).join(' · '),
        count,
        stepKey: 'tasks',
      })
    }
  }

  if (goals) {
    // `settled` is THIS session's answer. A group carrying `focusGoalId` without it is
    // showing an already-featured goal so nobody re-picks it — a flag, not a decision.
    const withFocus = goals.groups.filter((g) => g.settled && g.focusGoalId)
    const noFocus = goals.groups.filter((g) => g.settled && !g.focusGoalId)
    if (withFocus.length) {
      groups.push({
        key: 'goals',
        label: 'Goals',
        headline: `${plural(withFocus.length, 'group')} ${withFocus.length === 1 ? 'has' : 'have'} a focus`,
        detail: withFocus
          .slice(0, DETAIL_CAP)
          .map((g) => `${g.name} · ${g.goals.find((x) => x.id === g.focusGoalId)?.title ?? 'a goal'}`)
          .join(' · '),
        count: withFocus.length,
        stepKey: 'goals',
      })
    }
    for (const g of noFocus) {
      leftAlone.push({
        key: `goal:${g.listId}`,
        label: g.name,
        detail: join([
          g.goals.length ? `${plural(g.goals.length, 'goal')} on the list` : 'nothing tracked yet',
          'no focus needed this week',
        ]),
        badge: 'none',
        stepKey: 'goals',
      })
    }
  }

  if (night) {
    // Calling the GATHERING off and skipping the STEP are independent; do both and this
    // card would say "Family night" twice and count it twice in `deferred`. The step's own
    // skip wins, because the loop below already renders it.
    if (night.status === 'skipped' && byKey.get('familyNight')?.status !== 'skipped') {
      // The rotation is positional — it counts occurrences, not who did what — so a skipped
      // week does NOT hold anybody's turn (see familyNight.ts).
      leftAlone.push({
        key: 'familyNight:skipped',
        label: stepTitle('familyNight'),
        detail: night.onCalendar
          ? 'Called off for this week — the gathering stays on the calendar'
          : 'Called off for this week',
        badge: 'none',
        stepKey: 'familyNight',
      })
    } else {
      const pinned = night.parts.filter((p) => p.pinned && p.personName)
      const rotating = night.parts.filter((p) => !p.pinned && p.rotates).length
      if (pinned.length) {
        groups.push({
          key: 'familyNight',
          label: 'Family Night',
          headline: join([`${weekdayOf(night.date)} ${night.time}`, night.theme]),
          detail: join([
            ...pinned.slice(0, DETAIL_CAP).map((p) => `${p.label} · ${p.personName}`),
            rotating ? `${plural(rotating, 'part')} left on rotation` : null,
          ]),
          count: pinned.length,
          stepKey: 'familyNight',
        })
      }
    }
  }

  if (kids.length) {
    groups.push({
      key: 'kids',
      label: 'Kids',
      headline: `${plural(kids.length, 'kid')} read back`,
      detail: kids.slice(0, DETAIL_CAP).map((k) => `${k.name}: ${k.line}`).join(' · '),
      count: kids.length,
      stepKey: 'kids',
    })
  }

  // A SKIPPED step is a decision and belongs on the record. A PENDING one is simply
  // unreached, and an unavailable one was never part of this household's session.
  for (const s of steps) {
    if (!s.available || s.key === 'recap') continue
    if (s.status !== 'skipped') continue
    leftAlone.push({
      key: `skip:${s.key}`,
      label: s.title,
      detail: 'Skipped — a real answer, and nothing here was changed',
      badge: 'skipped',
      stepKey: s.key,
    })
  }

  // Only checked for steps that HAVE a group — for intake, the horizon scan and connection
  // there is no honest way to say "nothing changed", so nothing is said.
  const has = new Set(groups.map((g) => g.key))
  for (const spec of GROUP_SPECS) {
    if (has.has(spec.key)) continue
    if (spec.requires && !on(spec.requires)) continue
    const s = byKey.get(spec.stepKey)
    if (!s?.available || s.status !== 'done') continue
    if (leftAlone.some((l) => l.stepKey === spec.stepKey && l.badge !== 'skipped')) continue
    leftAlone.push({
      key: `none:${spec.key}`,
      label: s.title,
      detail: NOTHING_CHANGED[spec.key] ?? 'Read back as it stood — nothing was changed',
      badge: 'none',
      stepKey: spec.stepKey,
    })
  }

  const tagged = new Map<string, number>()
  for (const key of parkedTags.values()) if (key) tagged.set(key, (tagged.get(key) ?? 0) + 1)
  for (const [key, n] of tagged) {
    const s = byKey.get(key)
    // A note whose step has gone by (or isn't running) waits for the next session.
    const passed = !s?.available || s.status !== 'pending'
    leftAlone.push({
      key: `parked:${key}`,
      label: stepTitle(key),
      detail: `${plural(n, 'note')} parked for ${stepTitle(key)}${passed ? ' — waiting for the next session' : ' — still ahead of you'}`,
      badge: 'parked',
      stepKey: s?.available ? key : null,
    })
  }

  const untagged = parked.filter((p) => parkedTags.get(p.id) === null)
  const lastCall = untagged.slice(0, LAST_CALL_CAP).map((p) => ({ id: p.id, note: p.title, detail: p.detail }))

  return {
    weekStart,
    savedAt: session?.completedAt ?? null,
    days,
    groups,
    lastCall,
    lastCallMore: Math.max(0, untagged.length - lastCall.length),
    leftAlone,
    counts: {
      decisions: groups.reduce((n, g) => n + g.count, 0),
      deferred: leftAlone.length,
      parked: parkedTags.size,
    },
  }
}

const NOTHING_CHANGED: Record<string, string> = {
  calendar: 'Read back as it stands — nothing was added',
  meals: 'Nothing new planned tonight, and no shopping trip claimed',
  tasks: 'Nobody was given anything new — the week already had its owners',
  goals: 'No group singled out a focus',
  familyNight: 'Nobody was pinned — the rotation’s turn stands',
  kids: 'Nobody was read back tonight',
}

// ─── Kids ──────────────────────────────────────────────────────────────────

// Read out of the KIDS step's own `data.kids`: the answers refer to a goal, a chore or
// free text, so they have no module row of their own.
//
// Deliberately NOT `getKidsStepView`: that builds every card's option lists to hand back
// the same two fields, and it keeps an answer whose referent has gone. Joining `persons`
// here is what stops a child who has left the household being read back.
async function kidsReadBack(householdId: string, sessionId: string): Promise<{ name: string; line: string }[]> {
  const { rows } = await query<{ data: { kids?: unknown } | null }>(
    `select data from planning_session_steps where session_id = $1 and step_key = 'kids'`,
    [sessionId]
  )
  const raw = rows[0]?.data?.kids
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const answers = raw as Record<string, { focus?: { label?: unknown } | null; forward?: { label?: unknown } | null }>
  // Both halves, or it isn't a read-back (the kids step's own `settled` rule).
  const settled = Object.entries(answers).filter(
    ([, v]) => typeof v?.focus?.label === 'string' && typeof v?.forward?.label === 'string'
  )
  if (!settled.length) return []
  const { rows: people } = await query<{ id: string; name: string }>(
    `select id, name from persons
      where household_id = $1 and deleted_at is null and id = any($2::uuid[])
      order by sort_order, created_at`,
    [householdId, settled.map(([id]) => id)]
  )
  const byId = new Map(settled)
  return people.map((p) => {
    const a = byId.get(p.id)!
    return { name: p.name, line: `${String(a.focus!.label)}, ${String(a.forward!.label)}` }
  })
}

// The crumb the recap hands the session record when the week is saved.
//
// INTEGERS ONLY: the receipt may freeze how MANY decisions were made tonight — a
// statement about the session, which stays true — but never WHAT they were, because the
// modules own those. A title stored here goes stale the moment somebody edits it.
export const recapCrumb = (v: RecapView) => ({ counts: v.counts })
