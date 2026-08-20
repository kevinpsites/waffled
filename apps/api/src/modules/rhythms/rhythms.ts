// Rhythms — the things that should keep happening. See docs/product/rhythms-plan.md.
//
// Two shapes, and the difference is what closes out a period:
//   'completion' — you did the thing. The clock restarts from when you ACTUALLY did it,
//                  so being late shifts the next one instead of stacking misses up.
//   'scheduling' — a calendar event exists for the period. We never ask whether it
//                  happened; getting the opportunity on the calendar IS the outcome.
//                  That last sentence is the whole line between a rhythm and a goal.
import { query } from '../../platform/db'
import { log } from '../../platform/logger'
import { InvalidReferenceError } from '../../platform/household-refs'
import { createEvent, type EventRow } from '../events/events'
import { type Tenant } from '../households/households'

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
  autoSchedule: boolean
  rrule: string | null
  leadTime: string
  lastCompletedAt: string | null
  nextDueAt: string | null
  isActive: boolean
}

// A rhythm plus where it stands right now. Only the list returns this; the single-row
// reads stay lean.
export interface RhythmWithPeriod extends Rhythm {
  // Null for the completion shape, which has no fixed period boundaries by design.
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  satisfied: boolean
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
         starts_on, auto_schedule, rrule, lead_time::text as lead_time,
         last_completed_at, next_due_at, is_active
    from rhythms`

// The list the management screen reads. It carries current-period state as well as the
// row, because /rhythms/attention deliberately answers a narrower question ("what needs
// attention by <horizon>?") and a screen listing everything still has to say whether a
// quarterly rhythm two months from its runway is handled. The client can't work that out
// on its own either: stepping true calendar months from an interval like '3 mons' is the
// arithmetic this query already does.
export async function listRhythms(householdId: string): Promise<RhythmWithPeriod[]> {
  const { rows } = await query<Row & { period_start: string | null; period_end: string | null; satisfied: boolean }>(
    `with base as (
       select r.*,
              case when r.satisfied_by = 'scheduling' then
                (select max(gs)::date
                   from generate_series(r.starts_on::timestamp, now()::timestamp, r.every) gs)
              end as period_start
         from rhythms r
        where r.household_id = $1 and r.deleted_at is null
     )
     select b.id, b.title, b.emoji, b.notes, b.person_id, b.satisfied_by, b.every::text as every,
            b.starts_on, b.auto_schedule, b.rrule, b.lead_time::text as lead_time,
            b.last_completed_at, b.next_due_at, b.is_active,
            b.period_start,
            case when b.period_start is not null then (b.period_start + b.every)::date end as period_end,
            case
              -- Completion shape has no period grid at all: its clock restarts from
              -- whenever you actually did it, so "handled" just means not yet due.
              when b.satisfied_by = 'completion' then b.next_due_at > now()
              when b.period_start is null then false
              else exists (
                     select 1 from rhythm_skips s
                      where s.rhythm_id = b.id and s.period_start = b.period_start
                   )
                or exists (
                     select 1 from events e
                      where e.rhythm_id = b.id and e.deleted_at is null
                        and e.starts_at >= b.period_start::timestamptz
                        and e.starts_at < (b.period_start + b.every)::timestamptz
                   )
                or exists (
                     select 1 from event_occurrences o
                      join events m on m.id = o.event_id
                      where m.rhythm_id = b.id and m.deleted_at is null and o.deleted_at is null
                        and o.starts_at >= b.period_start::timestamptz
                        and o.starts_at < (b.period_start + b.every)::timestamptz
                   )
            end as satisfied
       from base b
      order by b.title`,
    [householdId]
  )
  return rows.map((r) => ({
    ...toRhythm(r),
    currentPeriodStart: dateText(r.period_start),
    currentPeriodEnd: dateText(r.period_end),
    satisfied: r.satisfied ?? false,
  }))
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

// The hour an auto-scheduled series starts on its anchor date. The booking sheet on both
// clients already defaults to 6pm, so a rhythm the user never picked a time for lands
// where they'd have put it anyway.
const AUTO_SCHEDULE_HOUR = 18

// The first instant of an auto-scheduled series: the anchor date at `AUTO_SCHEDULE_HOUR`
// in the HOUSEHOLD's timezone. Resolved in Postgres against the households row rather
// than in JS, for the same reason the grocery week boundary is: a client (or a server
// running in another zone) computing a local wall-clock instant is exactly how a booking
// lands one day out and satisfies the wrong period.
async function anchorInstant(householdId: string, startsOn: string): Promise<string> {
  const { rows } = await query<{ at: Date }>(
    `select (($2::date + make_interval(hours => $3))
             at time zone (select timezone from households where id = $1)) as at`,
    [householdId, startsOn, AUTO_SCHEDULE_HOUR]
  )
  return rows[0].at.toISOString()
}

// Validation lives here rather than in the route so the shape rules sit next to the
// schema constraint they mirror — a mismatch between the two would surface as a 500.
export async function createRhythm(tenant: Tenant, input: CreateRhythmInput): Promise<Rhythm> {
  const householdId = tenant.householdId
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

  // The runway is clamped to half the cycle at insert time (`least(lead_time, every/2)`,
  // below) — a 14-day default on a 7-day cadence would put `next_due_at - lead_time`
  // permanently in the past, so weekly trash would never leave the attention list. Half a
  // period is the guarantee: every rhythm gets a stretch where it is genuinely quiet.
  // Stored rather than applied on read so the API echoes back what will actually happen;
  // an update path that changes `every` has to re-apply this.
  const leadTime = typeof input.leadTime === 'string' && input.leadTime.trim() ? input.leadTime.trim() : '14 days'

  if (satisfiedBy === 'completion') {
    // A never-done item still needs a first due date, so the caller seeds it.
    const nextDueAt = typeof input.nextDueAt === 'string' ? input.nextDueAt : null
    if (!nextDueAt) throw new InvalidReferenceError('nextDueAt is required for a completion rhythm')
    const { rows } = await query<Row>(
      `insert into rhythms (household_id, title, emoji, notes, person_id, satisfied_by, every, lead_time, next_due_at)
       values ($1,$2,$3,$4,$5,'completion',$6::interval,least($7::interval, $6::interval / 2),$8::timestamptz)
       returning id, title, emoji, notes, person_id, satisfied_by, every::text as every,
                 starts_on, auto_schedule, rrule, lead_time::text as lead_time,
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
                          starts_on, auto_schedule, rrule)
     values ($1,$2,$3,$4,$5,'scheduling',$6::interval,least($7::interval, $6::interval / 2),$8::date,$9,$10)
     returning id, title, emoji, notes, person_id, satisfied_by, every::text as every,
               starts_on, auto_schedule, rrule, lead_time::text as lead_time,
               last_completed_at, next_due_at, is_active`,
    [householdId, title, str(input.emoji), str(input.notes), personId, every, leadTime, startsOn, autoSchedule, rrule]
  )
  const rhythm = toRhythm(rows[0])

  // "Put it on the calendar automatically" has to actually put it there. Without this the
  // toggle inserted a row and stopped, so a brand-new rhythm's first act was to appear in
  // the register offering "Put it back on the calendar" — a button that both denies the
  // rhythm is new and is the only way to honour the promise the toggle just made.
  //
  // Routed through scheduleRhythm rather than a second createEvent call: the events write
  // path can blank `rhythm_id` (see the PowerSync sink), and a parallel booking path is
  // precisely how the two drift apart.
  if (autoSchedule) {
    try {
      await scheduleRhythm(tenant, rhythm.id, { startsAt: await anchorInstant(householdId, startsOn) })
    } catch (e) {
      // The rhythm itself is saved and valid, so a failed booking must not 500 the
      // creation and strand the row. Degrading to "not on the calendar yet" is a state
      // the register already knows how to explain and offer a fix for — which is exactly
      // what that branch is for.
      log.warn('auto-scheduled rhythm created but its series could not be booked', {
        rhythmId: rhythm.id,
        err: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return rhythm
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
                starts_on, auto_schedule, rrule, lead_time::text as lead_time,
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
// Takes only the window's END. The caller validates `from` too, but the question both
// shapes answer is "will this need attention by <horizon>?", which the far edge decides on
// its own — a one-day Today window and a week-long planner window differ only in how far
// out they look. Deliberately no lower bound: an overdue filter should keep surfacing
// however long it has been overdue, which is the entire point of a maintenance register.
export async function listAttention(householdId: string, horizon: string): Promise<AttentionItem[]> {
  const to = horizon
  const out: AttentionItem[] = []

  // Completion shape: inside its lead time at any point in the window. An overdue item
  // keeps surfacing indefinitely — that is the point of a maintenance register — so there
  // is no lower bound on next_due_at.
  const due = await query<Row & { due_at: Date; overdue: boolean }>(
    `select id, title, emoji, notes, person_id, satisfied_by, every::text as every,
            starts_on, auto_schedule, rrule, lead_time::text as lead_time,
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
            p.starts_on, p.auto_schedule, p.rrule, p.lead_time::text as lead_time,
            p.last_completed_at, p.next_due_at, p.is_active,
            p.period_start, (p.period_start + p.every)::date as period_end
       from periods p
      where (p.period_start + p.every)::date - p.lead_time <= $2::date
        and not exists (
          select 1 from rhythm_skips s
           where s.rhythm_id = p.id and s.period_start = p.period_start
        )
        -- Satisfied by a booking landing in the period — either a one-off event, or one
        -- of the occurrences a recurring booking generates. The second half is what makes
        -- auto_schedule work at all: a series is a single master row with one starts_at,
        -- so matching on events alone would satisfy the month the outing was booked in and
        -- let every later month resurface as "needs scheduling" while the outing sits
        -- right there on the calendar.
        and not exists (
          select 1 from events e
           where e.rhythm_id = p.id
             and e.deleted_at is null
             and e.starts_at >= p.period_start::timestamptz
             and e.starts_at < (p.period_start + p.every)::timestamptz
        )
        and not exists (
          select 1 from event_occurrences o
           join events m on m.id = o.event_id
           where m.rhythm_id = p.id
             and m.deleted_at is null
             and o.deleted_at is null
             and o.starts_at >= p.period_start::timestamptz
             and o.starts_at < (p.period_start + p.every)::timestamptz
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

export interface UpdateRhythmInput {
  title?: unknown
  emoji?: unknown
  notes?: unknown
  personId?: unknown
  every?: unknown
  leadTime?: unknown
  isActive?: unknown
}

// Edit a rhythm. Deliberately covers only the fields that are safe to change in place:
// title/emoji/notes/assignee, the cadence, the runway, and active. `satisfiedBy`,
// `startsOn`, `autoSchedule` and `rrule` are not editable here — changing the shape or the
// period anchor of a live rhythm would silently re-interpret its existing skips (keyed on
// period_start) and re-point its bookings at periods that no longer exist. Retire it and
// make a new one instead.
export async function updateRhythm(
  householdId: string,
  id: string,
  input: UpdateRhythmInput
): Promise<Rhythm | null> {
  const existing = await readOne(householdId, id)
  if (!existing) return null

  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || !input.title.trim()) {
      throw new InvalidReferenceError('title cannot be blank')
    }
  }
  const personId = input.personId === undefined ? undefined : (typeof input.personId === 'string' ? input.personId : null)
  if (personId) await assertPersonInHousehold(householdId, personId)

  const { rows } = await query<Row>(
    `update rhythms set
       title      = coalesce($3, title),
       emoji      = case when $4::boolean then $5 else emoji end,
       notes      = case when $6::boolean then $7 else notes end,
       person_id  = case when $8::boolean then $9::uuid else person_id end,
       every      = coalesce($10::interval, every),
       -- Re-clamped on every write, against the cadence as it will be AFTER this update.
       -- Shortening a six-month rhythm to weekly would otherwise leave it a 14-day runway
       -- it can never close, and it would nag from then on.
       lead_time  = least(
                      coalesce($11::interval, lead_time),
                      coalesce($10::interval, every) / 2
                    ),
       is_active  = coalesce($12::boolean, is_active),
       updated_at = now()
     where household_id = $1 and id = $2 and deleted_at is null
     returning id, title, emoji, notes, person_id, satisfied_by, every::text as every,
               starts_on, auto_schedule, rrule, lead_time::text as lead_time,
               last_completed_at, next_due_at, is_active`,
    [
      householdId,
      id,
      typeof input.title === 'string' ? input.title.trim() : null,
      input.emoji !== undefined, str(input.emoji),
      input.notes !== undefined, str(input.notes),
      personId !== undefined, personId ?? null,
      typeof input.every === 'string' && input.every.trim() ? input.every.trim() : null,
      typeof input.leadTime === 'string' && input.leadTime.trim() ? input.leadTime.trim() : null,
      typeof input.isActive === 'boolean' ? input.isActive : null,
    ]
  )
  return rows[0] ? toRhythm(rows[0]) : null
}

// Soft delete, so the completion history a rhythm accumulated ("filter last changed Mar
// 12") survives being retired. Pausing via isActive is the reversible option; this one is
// for rhythms that were a mistake.
export async function deleteRhythm(householdId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `update rhythms set deleted_at = now(), updated_at = now()
      where household_id = $1 and id = $2 and deleted_at is null`,
    [householdId, id]
  )
  return !!rowCount
}

export interface ScheduleRhythmInput {
  startsAt?: unknown
  endsAt?: unknown
  allDay?: unknown
  title?: unknown
}

// Book a period: turn "this should happen" into an actual dated event.
//
// This is why rhythms generate real events rather than their own kind of calendar chip.
// A chip would have to reinvent reminders, notifications, the PowerSync mirror, Google
// push and every surface that already renders events — and on iOS, where local
// notifications are scheduled off the events mirror and nothing else, a chip could not be
// reminded about at all.
//
// Title and assignee default from the rhythm so booking is one tap: the whole complaint
// the scheduling shape answers is that these things never get onto the calendar, and
// making you retype the title is exactly the friction that keeps them off it.
export async function scheduleRhythm(
  tenant: Tenant,
  rhythmId: string,
  input: ScheduleRhythmInput
): Promise<EventRow | null> {
  const rhythm = await readOne(tenant.householdId, rhythmId)
  if (!rhythm) return null
  if (rhythm.satisfiedBy !== 'scheduling') {
    // A completion rhythm has no slot to book — an event here would satisfy nothing,
    // since its period closes on "I did it", not on "it's on the calendar".
    throw new InvalidReferenceError('only a scheduling rhythm can be booked')
  }

  const startsAt = typeof input.startsAt === 'string' ? input.startsAt : ''
  if (!startsAt || Number.isNaN(Date.parse(startsAt))) {
    throw new InvalidReferenceError('startsAt must be a valid timestamp')
  }
  const endsAt = typeof input.endsAt === 'string' && input.endsAt ? input.endsAt : null
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : rhythm.title

  return createEvent(tenant, {
    title,
    startsAt,
    endsAt,
    allDay: input.allDay === true,
    personId: rhythm.personId,
    rhythmId: rhythm.id,
    // An auto_schedule rhythm books its whole series at once — the rule already says when
    // it recurs, so asking the caller to restate it would just be a chance to disagree
    // with the rhythm. A booking-shape rhythm has no rule and books one slot.
    rrule: rhythm.autoSchedule ? rhythm.rrule : null,
  })
}
