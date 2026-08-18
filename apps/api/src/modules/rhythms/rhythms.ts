// Rhythms — the things that should keep happening. See docs/product/rhythms-plan.md.
//
// Two shapes, and the difference is what closes out a period:
//   'completion' — you did the thing. The clock restarts from when you ACTUALLY did it,
//                  so being late shifts the next one instead of stacking misses up.
//   'scheduling' — a calendar event exists for the period. We never ask whether it
//                  happened; getting the opportunity on the calendar IS the outcome.
//                  That last sentence is the whole line between a rhythm and a goal.
import { query } from '../../platform/db'
import { InvalidReferenceError } from '../../platform/household-refs'

export type SatisfiedBy = 'completion' | 'scheduling'

export interface Rhythm {
  id: string
  title: string
  emoji: string | null
  notes: string | null
  personId: string | null
  satisfiedBy: SatisfiedBy
  every: string
  startsOn: string | null
  currentPeriodStart: string | null
  autoSchedule: boolean
  rrule: string | null
  leadTime: string
  lastCompletedAt: string | null
  nextDueAt: string | null
  isActive: boolean
}

interface Row {
  id: string
  title: string
  emoji: string | null
  notes: string | null
  person_id: string | null
  satisfied_by: SatisfiedBy
  every: string
  starts_on: string | null
  current_period_start: string | null
  auto_schedule: boolean
  rrule: string | null
  lead_time: string
  last_completed_at: Date | null
  next_due_at: Date | null
  is_active: boolean
}

// Postgres hands back `interval` as an object under some driver configs and a string
// under others; normalise to the ISO-ish text form the API contract uses.
function intervalText(v: unknown): string {
  return typeof v === 'string' ? v : String(v ?? '')
}

// node-postgres parses a `date` column into a JS Date at LOCAL midnight, so toISOString()
// can slip a day backwards west of UTC. Read the local components instead.
function dateText(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'string') return v.slice(0, 10)
  if (v instanceof Date) {
    const m = String(v.getMonth() + 1).padStart(2, '0')
    const d = String(v.getDate()).padStart(2, '0')
    return `${v.getFullYear()}-${m}-${d}`
  }
  return String(v).slice(0, 10)
}

function toRhythm(r: Row): Rhythm {
  return {
    id: r.id,
    title: r.title,
    emoji: r.emoji,
    notes: r.notes,
    personId: r.person_id,
    satisfiedBy: r.satisfied_by,
    every: intervalText(r.every),
    startsOn: dateText(r.starts_on),
    currentPeriodStart: dateText(r.current_period_start),
    autoSchedule: r.auto_schedule,
    rrule: r.rrule,
    leadTime: intervalText(r.lead_time),
    lastCompletedAt: r.last_completed_at ? r.last_completed_at.toISOString() : null,
    nextDueAt: r.next_due_at ? r.next_due_at.toISOString() : null,
    isActive: r.is_active,
  }
}

const SELECT = `
  select id, title, emoji, notes, person_id, satisfied_by, every::text as every,
         starts_on, current_period_start, auto_schedule, rrule, lead_time::text as lead_time,
         last_completed_at, next_due_at, is_active
    from rhythms`

export async function listRhythms(householdId: string): Promise<Rhythm[]> {
  const { rows } = await query<Row>(
    `${SELECT} where household_id = $1 and deleted_at is null order by title`,
    [householdId]
  )
  return rows.map(toRhythm)
}

async function readOne(householdId: string, id: string): Promise<Rhythm | null> {
  const { rows } = await query<Row>(
    `${SELECT} where household_id = $1 and id = $2 and deleted_at is null`,
    [householdId, id]
  )
  return rows[0] ? toRhythm(rows[0]) : null
}

export interface CreateRhythmInput {
  title?: unknown
  emoji?: unknown
  notes?: unknown
  personId?: unknown
  satisfiedBy?: unknown
  every?: unknown
  startsOn?: unknown
  autoSchedule?: unknown
  rrule?: unknown
  leadTime?: unknown
  nextDueAt?: unknown
}

// Validation lives here rather than in the route so the shape rules sit next to the
// schema constraint they mirror — a mismatch between the two would surface as a 500.
export async function createRhythm(householdId: string, input: CreateRhythmInput): Promise<Rhythm> {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) throw new InvalidReferenceError('title is required')

  const satisfiedBy = input.satisfiedBy
  if (satisfiedBy !== 'completion' && satisfiedBy !== 'scheduling') {
    throw new InvalidReferenceError("satisfiedBy must be 'completion' or 'scheduling'")
  }
  const every = typeof input.every === 'string' ? input.every.trim() : ''
  if (!every) throw new InvalidReferenceError('every is required')

  const personId = typeof input.personId === 'string' ? input.personId : null
  if (personId) await assertPersonInHousehold(householdId, personId)

  const leadTime = typeof input.leadTime === 'string' && input.leadTime.trim() ? input.leadTime.trim() : '14 days'

  if (satisfiedBy === 'completion') {
    // A never-done item still needs a first due date, so the caller seeds it.
    const nextDueAt = typeof input.nextDueAt === 'string' ? input.nextDueAt : null
    if (!nextDueAt) throw new InvalidReferenceError('nextDueAt is required for a completion rhythm')
    const { rows } = await query<Row>(
      `insert into rhythms (household_id, title, emoji, notes, person_id, satisfied_by, every, lead_time, next_due_at)
       values ($1,$2,$3,$4,$5,'completion',$6::interval,$7::interval,$8::timestamptz)
       returning id, title, emoji, notes, person_id, satisfied_by, every::text as every,
                 starts_on, current_period_start, auto_schedule, rrule, lead_time::text as lead_time,
                 last_completed_at, next_due_at, is_active`,
      [householdId, title, str(input.emoji), str(input.notes), personId, every, leadTime, nextDueAt]
    )
    return toRhythm(rows[0])
  }

  // scheduling: starts_on anchors the period grid. Without it "which period are we in?"
  // has no answer, and both the attention query and rhythm_skips depend on one.
  const startsOn = typeof input.startsOn === 'string' ? input.startsOn : null
  if (!startsOn) throw new InvalidReferenceError('startsOn is required for a scheduling rhythm')
  const autoSchedule = input.autoSchedule === true
  const rrule = typeof input.rrule === 'string' && input.rrule.trim() ? input.rrule.trim() : null
  if (autoSchedule && !rrule) throw new InvalidReferenceError('rrule is required when autoSchedule is true')

  const { rows } = await query<Row>(
    `insert into rhythms (household_id, title, emoji, notes, person_id, satisfied_by, every, lead_time,
                          starts_on, current_period_start, auto_schedule, rrule)
     values ($1,$2,$3,$4,$5,'scheduling',$6::interval,$7::interval,$8::date,$8::date,$9,$10)
     returning id, title, emoji, notes, person_id, satisfied_by, every::text as every,
               starts_on, current_period_start, auto_schedule, rrule, lead_time::text as lead_time,
               last_completed_at, next_due_at, is_active`,
    [householdId, title, str(input.emoji), str(input.notes), personId, every, leadTime, startsOn, autoSchedule, rrule]
  )
  return toRhythm(rows[0])
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

async function assertPersonInHousehold(householdId: string, personId: string): Promise<void> {
  const { rows } = await query<{ id: string }>(
    `select id from persons where id = $1 and household_id = $2`,
    [personId, householdId]
  )
  if (!rows[0]) throw new InvalidReferenceError('invalid person id')
}

// Completing re-anchors the clock to when it was ACTUALLY done — the load-bearing
// behaviour of the completion shape. One transaction: log it, then advance.
export async function completeRhythm(
  householdId: string,
  id: string,
  personId: string | null,
  completedAt: string | null,
  notes: string | null
): Promise<Rhythm | null> {
  const existing = await readOne(householdId, id)
  if (!existing) return null
  if (existing.satisfiedBy !== 'completion') {
    throw new InvalidReferenceError('only a completion rhythm can be completed — a scheduling rhythm is satisfied by an event existing')
  }

  await query(
    `insert into rhythm_completions (household_id, rhythm_id, person_id, completed_at, notes)
     values ($1,$2,$3, coalesce($4::timestamptz, now()), $5)`,
    [householdId, id, personId, completedAt, notes]
  )
  const { rows } = await query<Row>(
    `update rhythms
        set last_completed_at = coalesce($3::timestamptz, now()),
            next_due_at = coalesce($3::timestamptz, now()) + every
      where household_id = $1 and id = $2 and deleted_at is null
      returning id, title, emoji, notes, person_id, satisfied_by, every::text as every,
                starts_on, current_period_start, auto_schedule, rrule, lead_time::text as lead_time,
                last_completed_at, next_due_at, is_active`,
    [householdId, id, completedAt]
  )
  return rows[0] ? toRhythm(rows[0]) : null
}

export interface Completion {
  id: string
  personId: string | null
  completedAt: string
  notes: string | null
}

export async function listCompletions(householdId: string, id: string): Promise<Completion[]> {
  const { rows } = await query<{ id: string; person_id: string | null; completed_at: Date; notes: string | null }>(
    `select id, person_id, completed_at, notes
       from rhythm_completions
      where household_id = $1 and rhythm_id = $2
      order by completed_at desc`,
    [householdId, id]
  )
  return rows.map((r) => ({
    id: r.id,
    personId: r.person_id,
    completedAt: r.completed_at.toISOString(),
    notes: r.notes,
  }))
}

export async function skipPeriod(
  householdId: string,
  id: string,
  periodStart: string,
  personId: string | null
): Promise<boolean> {
  const existing = await readOne(householdId, id)
  if (!existing) return false
  if (existing.satisfiedBy !== 'scheduling') {
    throw new InvalidReferenceError('only a scheduling rhythm has periods to skip')
  }
  await query(
    `insert into rhythm_skips (household_id, rhythm_id, period_start, skipped_by)
     values ($1,$2,$3::date,$4)
     on conflict (rhythm_id, period_start) do nothing`,
    [householdId, id, periodStart, personId]
  )
  return true
}

export type AttentionItem =
  | { kind: 'due'; rhythm: Rhythm; dueAt: string; overdue: boolean }
  | { kind: 'unscheduled'; rhythm: Rhythm; periodStart: string; periodEnd: string }

// The one question every surface asks: what needs attention in this window? Today passes
// a one-day window, the weekly planner passes a week.
//
// Note that satisfaction for the scheduling shape is DERIVED — "does an event with this
// rhythm_id fall inside the period?" — rather than stored. That question is idempotent by
// nature, so a materialised copy would buy nothing and drift whenever an event is edited,
// moved, or deleted.
export async function listAttention(householdId: string, from: string, to: string): Promise<AttentionItem[]> {
  const out: AttentionItem[] = []

  // Completion shape: inside its lead time at any point in the window. An overdue item
  // keeps surfacing indefinitely — that is the point of a maintenance register — so there
  // is no lower bound on next_due_at.
  const due = await query<Row & { due_at: Date; overdue: boolean }>(
    `select id, title, emoji, notes, person_id, satisfied_by, every::text as every,
            starts_on, current_period_start, auto_schedule, rrule, lead_time::text as lead_time,
            last_completed_at, next_due_at, is_active,
            next_due_at as due_at, (next_due_at <= $2::date) as overdue
       from rhythms
      where household_id = $1
        and deleted_at is null and is_active
        and satisfied_by = 'completion'
        and next_due_at - lead_time <= $2::date`,
    [householdId, to]
  )
  for (const r of due.rows) {
    out.push({ kind: 'due', rhythm: toRhythm(r), dueAt: r.due_at.toISOString(), overdue: r.overdue })
  }

  // Scheduling shape: the period covering the window, unsatisfied and not skipped, and
  // only once the booking runway has opened (period_end - lead_time).
  const unscheduled = await query<Row & { period_start: string; period_end: string }>(
    `with periods as (
       select r.*,
              -- The period covering the window: the latest boundary at or before its end.
              -- generate_series with an interval step tiles TRUE calendar periods, so
              -- '3 months' lands on real month boundaries. Doing this by epoch division
              -- would treat a month as 30 days and drift a little further every quarter.
              (select max(gs)::date
                 from generate_series(r.starts_on::timestamp, $2::timestamp, r.every) gs
              ) as period_start
         from rhythms r
        where r.household_id = $1
          and r.deleted_at is null and r.is_active
          and r.satisfied_by = 'scheduling'
          and r.starts_on <= $2::date
     )
     select p.id, p.title, p.emoji, p.notes, p.person_id, p.satisfied_by, p.every::text as every,
            p.starts_on, p.current_period_start, p.auto_schedule, p.rrule, p.lead_time::text as lead_time,
            p.last_completed_at, p.next_due_at, p.is_active,
            p.period_start, (p.period_start + p.every)::date as period_end
       from periods p
      where (p.period_start + p.every)::date - p.lead_time <= $2::date
        and not exists (
          select 1 from rhythm_skips s
           where s.rhythm_id = p.id and s.period_start = p.period_start
        )
        and not exists (
          select 1 from events e
           where e.rhythm_id = p.id
             and e.deleted_at is null
             and e.starts_at >= p.period_start::timestamptz
             and e.starts_at < (p.period_start + p.every)::timestamptz
        )`,
    [householdId, to]
  )
  for (const r of unscheduled.rows) {
    out.push({
      kind: 'unscheduled',
      rhythm: toRhythm(r),
      periodStart: dateText(r.period_start)!,
      periodEnd: dateText(r.period_end)!,
    })
  }

  return out
}
