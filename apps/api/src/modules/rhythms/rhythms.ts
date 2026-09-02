// Rhythms — the things that should keep happening. See docs/product/rhythms-plan.md.
//
// Two shapes, and the difference is what closes out a period:
//   'completion' — you did the thing. The clock restarts from when you ACTUALLY did it,
//                  so being late shifts the next one instead of stacking misses up.
//   'scheduling' — a calendar event exists for the period. We never ask whether it
//                  happened; getting the opportunity on the calendar IS the outcome.
//                  That last sentence is the whole line between a rhythm and a goal.
import { query, getPool } from '../../platform/db'
import { log } from '../../platform/logger'
import { InvalidReferenceError } from '../../platform/household-refs'
import { createEvent, type EventRow } from '../events/events'
import { firstSlotOnOrAfter, isValidRrule, slotsBetween } from '../calendar/recurrence'
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
  /**
   * How much of each period a booking counts in, measured from the period's start.
   *
   * Null — and null is what every rhythm written before this column has — means the whole
   * period, so `every` keeps doing both jobs exactly as it did. A value splits them: the
   * period still says how often and still owns the grid and the skips, while this says
   * where inside it a booking settles anything. "Date night, in the first week of the
   * month" is `every: '1 month', bookWithin: '7 days'`.
   */
  bookWithin: string | null
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
  /**
   * Where the current period stops accepting bookings — `currentPeriodStart + bookWithin`,
   * or the period's own end when there is no window.
   *
   * Carried beside `currentPeriodEnd` rather than replacing it because the two answer
   * different questions: the period end is where the NEXT period starts (and so what the
   * grid and the skips are keyed against), while this is the last moment a booking still
   * settles this one. Clients want this one for every "how long have I got" line and for
   * the booking picker's bounds; they want the other only to talk about the cadence.
   */
  currentWindowEnd: string | null
  satisfied: boolean
  /**
   * When the event that settles this period starts, or null.
   *
   * Null does NOT mean unsettled: a **skip** settles a period and has no time, and the
   * completion shape has no periods at all. `satisfied && bookedAt === null` on a
   * scheduling rhythm is precisely "skipped", which is what lets a row say *Booked · Sat
   * 2pm* without printing "Booked" over a period nobody intends to do anything in.
   */
  bookedAt: string | null
  bookedAllDay: boolean | null
  /**
   * Whether a live recurring event still exists for this rhythm.
   *
   * Only meaningful on an auto-scheduled one, where it separates two situations that
   * otherwise look identical from an empty period: the series is **gone** and needs
   * putting back, versus the series is **alive** and a single instance was cancelled.
   * Different sentences, different buttons — and only the server can see the difference.
   *
   * "Gone" means deleted **or capped**: "delete this and all following" sets
   * `recurrence_end_at` and deliberately leaves the master row alive with its rrule, so
   * testing `rrule is not null` alone reports a series that will never fire again. A rule
   * that ends *inside the string* (COUNT/UNTIL) would be a third way, invisible to SQL —
   * which is why the write paths refuse one on a rhythm.
   */
  hasSeries: boolean
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
  book_within: string | null
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
    bookWithin: r.book_within == null ? null : intervalText(r.book_within),
    leadTime: intervalText(r.lead_time),
    lastCompletedAt: r.last_completed_at ? r.last_completed_at.toISOString() : null,
    nextDueAt: r.next_due_at ? r.next_due_at.toISOString() : null,
    isActive: r.is_active,
  }
}

const SELECT = `
  select id, title, emoji, notes, person_id, satisfied_by, every::text as every,
         starts_on, auto_schedule, rrule, book_within::text as book_within, lead_time::text as lead_time,
         last_completed_at, next_due_at, is_active
    from rhythms`

// The list the management screen reads. It carries current-period state as well as the
// row, because /rhythms/attention deliberately answers a narrower question ("what needs
// attention by <horizon>?") and a screen listing everything still has to say whether a
// quarterly rhythm two months from its runway is handled. The client can't work that out
// on its own either: stepping true calendar months from an interval like '3 mons' is the
// arithmetic this query already does.
export async function listRhythms(householdId: string): Promise<RhythmWithPeriod[]> {
  const { rows } = await query<Row & {
    period_start: string | null
    period_end: string | null
    window_end: string | null
    satisfied: boolean
    booked_at: Date | null
    booked_all_day: boolean | null
    has_series: boolean
  }>(
    `with hh as (select timezone from households where id = $1),
          base as (
       select r.*,
              case when r.satisfied_by = 'scheduling' then
                -- Tiled up to the household's OWN today. Against a bare now() the grid
                -- rolls over at UTC midnight, so a household in Los Angeles watched its
                -- period advance at 5pm — while the evening it was still meant to be
                -- booking in was, locally, not over.
                -- Each boundary is computed FROM THE ANCHOR (starts_on + n × every),
                -- not by stepping from the previous one. generate_series with an interval
                -- step feeds each result into the next addition, so a single short month
                -- poisons the rest: Jan 31 → Feb 28 → Mar *28* → Apr 28, and a rhythm
                -- anchored on a month end silently becomes a 28th-of-the-month rhythm
                -- forever. From the anchor it is Jan 31 → Feb 28 → Mar 31 → Apr 30, which
                -- is what "monthly from the 31st" means to whoever set it.
                --
                -- n is bounded by the elapsed DAYS, which is safe because a cadence is
                -- refused below one day — so the series is never longer than the old one.
                (select max((r.starts_on + (n * r.every))::date)
                   from generate_series(0, greatest(0, ((now() at time zone hh.timezone)::date - r.starts_on))) n
                  where (r.starts_on + (n * r.every)) <= (now() at time zone hh.timezone))
              end as period_start
         from rhythms r, hh
        where r.household_id = $1 and r.deleted_at is null
     )
     select b.id, b.title, b.emoji, b.notes, b.person_id, b.satisfied_by, b.every::text as every,
            b.starts_on, b.auto_schedule, b.rrule, b.book_within::text as book_within, b.lead_time::text as lead_time,
            b.last_completed_at, b.next_due_at, b.is_active,
            b.period_start,
            case when b.period_start is not null then (b.period_start + b.every)::date end as period_end,
            -- Where the period stops accepting bookings. book_within is null on every
            -- rhythm that predates it, and coalescing to every is what makes those
            -- byte-for-byte unchanged: the window is the period, as it always was.
            case when b.period_start is not null
                 then (b.period_start + coalesce(b.book_within, b.every))::date end as window_end,
            bk.starts_at as booked_at,
            bk.all_day as booked_all_day,
            exists (
              select 1 from events e
               where e.rhythm_id = b.id and e.deleted_at is null and e.rrule is not null
                 -- Capped counts as gone. "Delete this and all following" sets
                 -- recurrence_end_at and leaves the master alive with its rrule, so rrule
                 -- alone reports a series that will never fire again. Alive means there is
                 -- still an occurrence to come: the cap has to be both in the future AND
                 -- at or after the series' own start, since capping from the FIRST
                 -- occurrence ends it before it ever began — a date still years away.
                 and (e.recurrence_end_at is null
                      or (e.recurrence_end_at > now() and e.recurrence_end_at >= e.starts_at))
            ) as has_series,
            case
              -- Completion shape has no period grid at all: its clock restarts from
              -- whenever you actually did it, so "handled" just means not yet due.
              when b.satisfied_by = 'completion' then b.next_due_at > now()
              when b.period_start is null then false
              -- A booking settles the period; so does a deliberate skip, which has no
              -- time and never will. Both are "handled", and the row can tell them apart
              -- by whether booked_at came back.
              else bk.starts_at is not null
                or exists (
                     select 1 from rhythm_skips s
                      where s.rhythm_id = b.id and s.period_start = b.period_start
                   )
            end as satisfied
       from base b
       -- The earliest thing on the calendar for this period, from either source: a
       -- one-off booking, or an occurrence of a recurring master (an auto-scheduled
       -- rhythm books a series, so its periods are settled by occurrences rather than by
       -- events). all_day is read off the OCCURRENCE, not the master — an override can
       -- move a single instance to all-day without touching the series.
       left join lateral (
         select starts_at, all_day from (
           select e.starts_at, e.all_day
             from events e, hh
            -- rrule is null matters here: a recurring master is a TEMPLATE, not an
            -- instance, and its own starts_at is not something on the calendar. Without
            -- this it settled whichever period contained the anchor — and cancelling
            -- that instance tombstones the OCCURRENCE while leaving the master alone, so
            -- the period reported itself booked with nothing on the calendar to show for
            -- it, and never surfaced for rebooking. The occurrence half below is what
            -- speaks for a series. Every other events/occurrences union in the codebase
            -- carries this filter for the same reason.
            where e.rhythm_id = b.id and e.deleted_at is null and e.rrule is null
              and e.starts_at >= (b.period_start::timestamp at time zone hh.timezone)
              -- The WINDOW, not the period. A dinner three weeks into the month is a real
              -- event on a real calendar, but it is not the first-week date night this
              -- rhythm is asking for, and counting it would settle a period nothing was
              -- booked in.
              and e.starts_at < ((b.period_start + coalesce(b.book_within, b.every))::timestamp at time zone hh.timezone)
           union all
           select o.starts_at, o.all_day
             from event_occurrences o
             join events m on m.id = o.event_id
             cross join hh
            where m.rhythm_id = b.id and m.deleted_at is null and o.deleted_at is null
              and o.starts_at >= (b.period_start::timestamp at time zone hh.timezone)
              and o.starts_at < ((b.period_start + coalesce(b.book_within, b.every))::timestamp at time zone hh.timezone)
         ) settling
          order by starts_at
          limit 1
       ) bk on true
      order by b.title`,
    [householdId]
  )
  return rows.map((r) => ({
    ...toRhythm(r),
    currentPeriodStart: dateText(r.period_start),
    currentPeriodEnd: dateText(r.period_end),
    currentWindowEnd: dateText(r.window_end),
    satisfied: r.satisfied ?? false,
    bookedAt: r.booked_at ? r.booked_at.toISOString() : null,
    bookedAllDay: r.booked_at ? (r.booked_all_day ?? false) : null,
    hasSeries: r.has_series ?? false,
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
  /** scheduling only: how much of each period a booking counts in. Null = the whole one. */
  bookWithin?: unknown
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
async function anchorInstant(householdId: string, startsOn: string, rrule: string | null): Promise<string> {
  const { rows } = await query<{ at: Date; tz: string }>(
    `select (($2::date + make_interval(hours => $3))
             at time zone h.timezone) as at,
            h.timezone as tz
       from households h where h.id = $1`,
    [householdId, startsOn, AUTO_SCHEDULE_HOUR]
  )
  const anchor = rows[0].at
  if (!rrule) return anchor.toISOString()
  // The anchor date and the repeat rule answer different questions, and nothing made
  // them agree: anchor a weekly rhythm on a Wednesday but pick Monday in the editor, and
  // the master landed on the Wednesday — contradicting the day the chips had just been
  // used to choose. Advance to the first slot the rule actually allows.
  return (firstSlotOnOrAfter(anchor, rrule, rows[0].tz) ?? anchor).toISOString()
}

// Validation lives here rather than in the route so the shape rules sit next to the
// schema constraint they mirror — a mismatch between the two would surface as a 500.
/**
 * Refuse a cadence the period grid cannot be built from.
 *
 * `every` reaches Postgres as an `interval` and is then handed to `generate_series` to
 * tile a rhythm's periods. A zero step raises "step size cannot equal zero" from inside
 * the LIST query rather than the write that caused it, and the routes only turn an
 * InvalidReferenceError into a 400 — so one bad row 500s the whole household's register
 * and Today card, for every member, until someone repairs it by hand. A value that is not
 * an interval at all fails at insert with a 500 where the sibling paths return 400.
 *
 * Validated by asking Postgres, which owns the grammar, rather than by a regex here that
 * would drift from it.
 */
async function assertUsableCadence(every: string): Promise<void> {
  let checks: { positive: boolean; atLeastADay: boolean; advances: boolean } | undefined
  try {
    const { rows } = await query<{ positive: boolean; at_least_a_day: boolean; advances: boolean }>(
      `select ($1::interval > interval '0')       as positive,
              ($1::interval >= interval '1 day')  as at_least_a_day,
              -- The property generate_series actually needs is that the step MOVES
              -- FORWARD from the anchor, which is not the same as being positive.
              -- Interval comparison normalizes a month to 30 days, so '1 mon -29 days'
              -- compares as +1 day and passes any nominal test — but date arithmetic
              -- applies the months FIRST and clamps to the short month: Jan 31 + 1 mon is
              -- Feb 28, and -29 days from there is Jan 30. The step lands a day earlier
              -- than it started, so the series never reaches its end and never returns.
              -- Jan 31 of a non-leap year is the largest clamp there is (3 days), which
              -- makes it the strictest probe.
              (('2026-01-31'::timestamp + $1::interval) > '2026-01-31'::timestamp) as advances`,
      [every]
    )
    const r = rows[0]
    checks = r && { positive: r.positive, atLeastADay: r.at_least_a_day, advances: r.advances }
  } catch {
    throw new InvalidReferenceError(`every must be an interval such as '3 months' — got '${every}'`)
  }
  if (!checks?.positive) {
    throw new InvalidReferenceError('every must be a positive interval — a rhythm with no cycle has no periods')
  }
  // Periods are dated — period_start is a date, and rhythm_skips is keyed on it — so a
  // sub-day cycle folds several periods onto one key and they stop being distinct. It is
  // also the difference between tiling hundreds of boundaries per read and hundreds of
  // millions of them.
  if (!checks.atLeastADay) {
    throw new InvalidReferenceError('every must be at least a day — periods are dated, so a shorter cycle would put several of them on one day')
  }
  // Worse than the zero step, which at least raises: a backwards step holds the connection
  // open forever. The pool is ten wide, so a handful of these takes the API down for every
  // household on the box, not just the one that owns the row.
  if (!checks.advances) {
    throw new InvalidReferenceError("every must move the calendar forward from any date — a mixed interval like '1 month -29 days' can land earlier than it started")
  }
}

/**
 * The runway, validated the same way the cadence is.
 *
 * It lands in `least($n::interval, every/2)` and was the one interval on these paths that
 * nothing checked — so `'soon'` came back as a 500 and a stack trace while `every: 'soon'`
 * came back as a sentence. Negative is refused too, and that one is a behaviour change
 * rather than a status-code change: `next_due_at - lead_time` with a negative runway moves
 * LATER than the due date, so the rhythm first asks for attention days after it was
 * already due. Zero is fine — it means "tell me on the day".
 */
async function assertUsableLeadTime(leadTime: string): Promise<void> {
  let nonNegative = false
  try {
    const { rows } = await query<{ ok: boolean }>(
      `select ($1::interval >= interval '0') as ok`, [leadTime]
    )
    nonNegative = rows[0]?.ok === true
  } catch {
    throw new InvalidReferenceError(`leadTime must be an interval such as '14 days' — got '${leadTime}'`)
  }
  if (!nonNegative) {
    throw new InvalidReferenceError('leadTime cannot be negative — the runway opens before the due date, never after it')
  }
}

/**
 * How many periods ahead the anchor check looks. A year of monthly periods, and rather
 * more of anything shorter — long enough for the drift below to show up, short enough
 * that the check is one query and one rule walk.
 */
const PERIODS_CHECKED = 12

/**
 * Refuse an auto-schedule rule that leaves a period with nothing in it.
 *
 * `starts_on` does double duty, and the two jobs quietly disagree. It anchors the period
 * grid — boundaries are `starts_on + n × every` — and it is also where the generated
 * series starts, which for a rule like `FREQ=MONTHLY;BYDAY=3SA` decides nothing at all
 * about where later occurrences fall. Third Saturdays wander over the 15th to the 21st,
 * so a rhythm anchored on the 19th tiles periods on the 19th: [Sep 19, Oct 19) holds two
 * of them and [Oct 19, Nov 19) holds none.
 *
 * A period with no occurrence can never be satisfied. Satisfaction is derived per period
 * from "does an event with this rhythm_id fall inside it?", so the register asks you to
 * book a period while the series sits on the calendar in plain sight, booking by hand
 * settles only the period the booking lands in, and the next empty period asks again. It
 * nags forever with nothing anywhere saying why — which is exactly the failure the whole
 * scheduling shape exists to prevent.
 *
 * Only EMPTINESS is refused, not doubling up. A rule that fires more than once a period
 * over-books but always settles it, and a household that writes one by hand in the raw
 * RRULE box may well mean it. An empty period is the one that cannot be recovered from.
 *
 * Create-only, which is complete coverage rather than a shortcut: `startsOn`, `rrule`,
 * `autoSchedule` are not editable, and a scheduling rhythm refuses a change to `every`.
 * A stored rhythm's grid and rule can never drift apart after this check passes.
 */
async function assertRuleFillsEveryPeriod(
  householdId: string,
  startsOn: string,
  every: string,
  rrule: string
): Promise<void> {
  // The true boundaries, from Postgres, for the same reason the list query computes them
  // there: interval addition tiles real calendar periods and is anchored rather than
  // cumulative, and re-deriving that in JS is how the check would come to disagree with
  // the queries it is protecting. Their local instants come back too — a boundary is a
  // date, and which side of it an evening booking falls on is a household-timezone
  // question, exactly as it is in listAttention.
  const { rows } = await query<{ boundary: string; at: Date; tz: string }>(
    `select (g.starts_on + (n * g.every))::date as boundary,
            ((g.starts_on + (n * g.every))::date::timestamp at time zone h.timezone) as at,
            h.timezone as tz
       from (select $2::date as starts_on, $3::interval as every) g,
            households h,
            generate_series(0, $4::int) n
      where h.id = $1
      order by n`,
    [householdId, startsOn, every, PERIODS_CHECKED]
  )
  if (rows.length < 2) return
  const tz = rows[0].tz || 'UTC'

  // The same DTSTART the booking will actually use, so the check and the series can't
  // answer differently. anchorInstant advances the anchor to the first slot the rule
  // allows, which is what a rhythm anchored on the 1st under BYDAY=3SA depends on.
  const dtstart = new Date(await anchorInstant(householdId, startsOn, rrule))
  const slots = slotsBetween(rrule, dtstart, tz, rows[0].at, rows[rows.length - 1].at)

  for (let i = 0; i < rows.length - 1; i++) {
    const from = rows[i].at
    const to = rows[i + 1].at
    if (slots.some((d) => d >= from && d < to)) continue
    const empty = dateText(rows[i].boundary)
    // Naming the fix matters as much as refusing: "the third Saturday of the month" is a
    // perfectly reasonable thing to want, and a bare "invalid" would read as the product
    // not supporting it. Anchoring on the 1st makes the periods calendar months, and each
    // calendar month holds exactly one of any nth weekday.
    const hint = /FREQ=MONTHLY/i.test(rrule)
      ? ' Start the first period on the first of the month and each period will hold exactly one.'
      : ' Move the first period so that each one contains a single occurrence of the rule.'
    throw new InvalidReferenceError(
      `that repeat rule skips whole periods — nothing it generates falls in the period beginning ${empty}, ` +
      `so that period could never be booked and would keep asking forever.${hint}`
    )
  }
}

/**
 * Refuse a booking window the period cannot hold.
 *
 * Positivity and the shape rules live in the CHECK constraint (0099); what has to happen
 * here is the comparison against `every`, because SQL cannot make it honestly. Interval
 * comparison normalises a month to 30 days, so `'30 days' <= '1 mon'` is true — and then
 * a 30-day window on a monthly rhythm overruns February by two days, putting bookings for
 * the NEXT period inside this one's window and settling the wrong period.
 *
 * So it is asked as a date question instead, over the same Jan-31 probe
 * `assertUsableCadence` uses: does the window still end on or before the period does, on
 * the shortest month there is?
 */
async function assertWindowFitsCadence(bookWithin: string, every: string): Promise<void> {
  let fits: boolean | undefined
  try {
    const { rows } = await query<{ fits: boolean; at_least_a_day: boolean }>(
      `select (('2026-01-31'::date + $1::interval) <= ('2026-01-31'::date + $2::interval)) as fits,
              ($1::interval >= interval '1 day') as at_least_a_day`,
      [bookWithin, every]
    )
    if (!rows[0]?.at_least_a_day) {
      throw new InvalidReferenceError(
        'bookWithin must be at least a day — periods are dated, and a window shorter than one could hold no booking at all'
      )
    }
    fits = rows[0]?.fits
  } catch (e) {
    if (e instanceof InvalidReferenceError) throw e
    throw new InvalidReferenceError(`bookWithin must be an interval such as '7 days' — got '${bookWithin}'`)
  }
  if (!fits) {
    throw new InvalidReferenceError(
      `bookWithin cannot be longer than the cadence — a window of '${bookWithin}' inside a cycle of '${every}' would still be open when the next period began, so a booking could settle two periods at once`
    )
  }
}

/** A real calendar date, not merely something shaped like one. */
function assertRealDate(value: string, field: string): void {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const d = m ? new Date(`${value}T00:00:00Z`) : null
  if (!m || !d || Number.isNaN(d.getTime()) ||
      d.getUTCFullYear() !== Number(m[1]) ||
      d.getUTCMonth() + 1 !== Number(m[2]) ||
      d.getUTCDate() !== Number(m[3])) {
    throw new InvalidReferenceError(`${field} must be a real date as YYYY-MM-DD — got '${value}'`)
  }
}

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
  await assertUsableCadence(every)

  const personId = typeof input.personId === 'string' ? input.personId : null
  if (personId) await assertPersonInHousehold(householdId, personId)

  // The runway is clamped at insert time, and the ceiling differs by shape — see the two
  // inserts below.
  //
  // A COMPLETION rhythm keeps half the cycle. Its feed has no upper bound, deliberately:
  // an overdue thing can still be done, so it keeps asking however late it is. Give it a
  // runway as long as its cycle and `next_due_at - lead_time` lands on the moment it was
  // last completed — it surfaces the instant you finish it and never goes quiet again,
  // which is exactly what this clamp was written to prevent. Half a period is what
  // guarantees every such rhythm a stretch of genuine quiet.
  //
  // Stored rather than applied on read so the API echoes back what will actually happen;
  // an update path that changes `every` has to re-apply this.
  // scheduling only, and validated before the shape branch so a completion rhythm
  // carrying one is refused with a sentence rather than by the CHECK constraint (which
  // surfaces as a 500 where every neighbouring field gets a 400).
  const bookWithin = typeof input.bookWithin === 'string' && input.bookWithin.trim() ? input.bookWithin.trim() : null
  if (bookWithin) {
    if (satisfiedBy !== 'scheduling') {
      throw new InvalidReferenceError(
        'only a scheduling rhythm can have a booking window; a completion rhythm has no periods for one to sit inside'
      )
    }
    await assertWindowFitsCadence(bookWithin, every)
  }

  // The runway defaults to the WINDOW when there is one, rather than to the flat
  // fortnight. "Book it in the first week" means being asked during that week — all of
  // it — and a 14-day default trimmed to the window's width would happen to be right at
  // seven days and wrong at twenty-one. Said explicitly so it is right at both.
  const leadTime = typeof input.leadTime === 'string' && input.leadTime.trim()
    ? input.leadTime.trim()
    : (bookWithin ?? '14 days')
  await assertUsableLeadTime(leadTime)

  if (satisfiedBy === 'completion') {
    // A never-done item still needs a first due date, so the caller seeds it.
    const nextDueAt = typeof input.nextDueAt === 'string' ? input.nextDueAt : null
    if (!nextDueAt) throw new InvalidReferenceError('nextDueAt is required for a completion rhythm')
    if (Number.isNaN(Date.parse(nextDueAt))) {
      throw new InvalidReferenceError('nextDueAt must be an ISO timestamp')
    }
    const { rows } = await query<Row>(
      `insert into rhythms (household_id, title, emoji, notes, person_id, satisfied_by, every, lead_time, next_due_at)
       values ($1,$2,$3,$4,$5,'completion',$6::interval,least($7::interval, $6::interval / 2),$8::timestamptz)
       returning id, title, emoji, notes, person_id, satisfied_by, every::text as every,
                 starts_on, auto_schedule, rrule, book_within::text as book_within, lead_time::text as lead_time,
                 last_completed_at, next_due_at, is_active`,
      [householdId, title, str(input.emoji), str(input.notes), personId, every, leadTime, nextDueAt]
    )
    return toRhythm(rows[0])
  }

  // scheduling: starts_on anchors the period grid. Without it "which period are we in?"
  // has no answer, and both the attention query and rhythm_skips depend on one.
  const startsOn = typeof input.startsOn === 'string' ? input.startsOn : null
  if (!startsOn) throw new InvalidReferenceError('startsOn is required for a scheduling rhythm')
  assertRealDate(startsOn, 'startsOn')
  const autoSchedule = input.autoSchedule === true
  const rrule = typeof input.rrule === 'string' && input.rrule.trim() ? input.rrule.trim() : null
  if (autoSchedule && !rrule) throw new InvalidReferenceError('rrule is required when autoSchedule is true')
  // Two answers to one question — "when inside the period does this happen?" — and the
  // rule is the one that actually creates the event. Allowed together, the rule can put
  // its occurrence outside the window and EVERY period becomes unsatisfiable while the
  // series sits on the calendar in plain sight: the failure assertRuleFillsEveryPeriod
  // exists to prevent, arriving through a different door. (The CHECK constraint refuses
  // it too; this is the sentence rather than the 500.)
  if (autoSchedule && bookWithin) {
    throw new InvalidReferenceError(
      'a rhythm that puts itself on the calendar cannot also have a booking window — its rule already decides which day inside the period, so there is nothing left to pick'
    )
  }
  // Both event write paths enforce this and this one didn't, so a rule the expander
  // cannot parse got stored. `FREQ=BANANA` then COMMITTED an event and threw on the way
  // to expanding it, leaving a permanently unexpandable master behind; on the create path
  // the same failure was swallowed, leaving a rhythm that can never book.
  if (rrule && !isValidRrule(rrule)) {
    throw new InvalidReferenceError('rrule is not a recurrence rule this calendar can expand')
  }
  // A rhythm is perpetual by definition — the cadence says how often, and this rule only
  // says WHICH DAY inside each period. A rule that stops of its own accord contradicts the
  // thing it is attached to, and it fails silently: once the last occurrence passes, every
  // later period surfaces as empty while the master row still carries an rrule, so the
  // register goes on offering "book this one" and never puts the series back. Refusing it
  // here is also what lets `hasSeries` mean what its doc comment says it means, since
  // COUNT and UNTIL live inside the rule string where no SQL predicate can see them.
  if (rrule && /(^|;)\s*(COUNT|UNTIL)=/i.test(rrule)) {
    throw new InvalidReferenceError('rrule must not end on its own (no COUNT or UNTIL) — a rhythm repeats for as long as it is active, and you stop it by pausing or retiring it')
  }
  // Last, because it walks the rule: everything above has already established that this
  // one parses, is open-ended, and belongs to a scheduling rhythm with a real anchor.
  // Only when a series will actually be generated — a rhythm booked by hand has no rule
  // to disagree with its grid, and its anchor is nobody's business but the person's.
  if (autoSchedule && rrule) {
    await assertRuleFillsEveryPeriod(householdId, startsOn, every, rrule)
  }

  const { rows } = await query<Row>(
    // The runway is clamped to the WINDOW where there is one, and to the whole cycle where
    // there isn't — not to half of it, as the completion shape still is.
    //
    // The two shapes can afford different ceilings because only one of them has a floor.
    // A scheduling rhythm's feed is bounded above: it stops asking when the window closes,
    // so a runway equal to the cycle opens on the period's first day and shuts on its
    // last. That is what makes "remind me at the start of the month to plan the outing,
    // and I'll book it for whenever suits" sayable at all — under a half-cycle cap a
    // monthly rhythm could not be asked before the 16th, and the booking window is the
    // wrong tool for it (it moves when a booking COUNTS, so an outing late in the month
    // would stop settling the period).
    //
    // Longer than the cycle is still refused, and that is the real rule: a runway that
    // outlives its own period never closes, and the thing is learned as noise.
    `insert into rhythms (household_id, title, emoji, notes, person_id, satisfied_by, every, lead_time,
                          starts_on, auto_schedule, rrule, book_within)
     values ($1,$2,$3,$4,$5,'scheduling',$6::interval,
             least($7::interval, coalesce($11::interval, $6::interval)),$8::date,$9,$10,$11::interval)
     returning id, title, emoji, notes, person_id, satisfied_by, every::text as every,
               starts_on, auto_schedule, rrule, book_within::text as book_within, lead_time::text as lead_time,
               last_completed_at, next_due_at, is_active`,
    [householdId, title, str(input.emoji), str(input.notes), personId, every, leadTime, startsOn, autoSchedule, rrule, bookWithin]
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
      await scheduleRhythm(tenant, rhythm.id, { startsAt: await anchorInstant(householdId, startsOn, rrule) })
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
  // A completion dated in the future would push `next_due_at` past a day that has not
  // happened and file history for a thing nobody has done — and because the clock restarts
  // from the completion date, the error compounds rather than washing out. The web form
  // already refuses it with `max` on the date input, but a guard only the browser enforces
  // is not a rule: iOS and the API go straight past it.
  //
  // The minute of slack is for clock skew between a client and the server, not for
  // backdating's sake — "I did it just now" must not become a 400 because a phone is
  // thirty seconds fast.
  if (completedAt !== null) {
    const at = Date.parse(completedAt)
    if (Number.isNaN(at)) {
      throw new InvalidReferenceError('completedAt must be an ISO timestamp')
    }
    if (at > Date.now() + 60_000) {
      throw new InvalidReferenceError('completedAt cannot be in the future — a rhythm is completed when you actually do it')
    }
  }

  const existing = await readOne(householdId, id)
  if (!existing) return null
  if (existing.satisfiedBy !== 'completion') {
    throw new InvalidReferenceError('only a completion rhythm can be completed — a scheduling rhythm is satisfied by an event existing')
  }

  // One completion per DAY, not one per tap. Completing something already completed today
  // is a person pressing a button that looked like it did nothing — not a second time they
  // changed the air filter — and the demo database had four rows for one filter change to
  // prove it. Folding the repeat into the existing row keeps the history answerable
  // ("when did we last change it?") instead of filling it with events that never happened.
  //
  // Same-day is judged on the HOUSEHOLD's clock: near midnight, UTC and local disagree
  // about which day it is, and the register is read in local terms.
  // One transaction, and actually one: these were two independent `query()` calls, each
  // taking whatever pooled connection was free. If the second failed, a completion row
  // existed while the rhythm's clock had not moved — the item stayed due, and the next tap
  // folded into a history row for a completion the register had never acknowledged.
  const client = await getPool().connect()
  try {
    await client.query('begin')
    await client.query(
    `with stamp as (select coalesce($4::timestamptz, now()) as at),
          zone as (select timezone from households where id = $1),
          upd as (
            update rhythm_completions c
               set completed_at = stamp.at,
                   -- First name on the row keeps it. The fold means two taps the same day
                   -- become one row, and this used to hand that row to whoever tapped
                   -- last, so a second person took credit for the first one's work. It
                   -- also erased the name entirely when the second tap came from a kiosk,
                   -- which has no person at all — the tenant's personId is null there.
                   -- Filling in a blank is still right, which is why this is coalesce and
                   -- not a flat refusal to change.
                   person_id = coalesce(c.person_id, $3),
                   notes = coalesce($5, c.notes)
              from stamp, zone
             where c.household_id = $1 and c.rhythm_id = $2
               and (c.completed_at at time zone zone.timezone)::date
                   = (stamp.at at time zone zone.timezone)::date
            returning c.id
          )
     insert into rhythm_completions (household_id, rhythm_id, person_id, completed_at, notes)
     select $1, $2, $3, stamp.at, $5 from stamp
      where not exists (select 1 from upd)`,
      [householdId, id, personId, completedAt, notes]
    )
    const { rows } = await client.query<Row>(
      `update rhythms
          set last_completed_at = coalesce($3::timestamptz, now()),
              next_due_at = coalesce($3::timestamptz, now()) + every
        where household_id = $1 and id = $2 and deleted_at is null
        returning id, title, emoji, notes, person_id, satisfied_by, every::text as every,
                  starts_on, auto_schedule, rrule, book_within::text as book_within, lead_time::text as lead_time,
                  last_completed_at, next_due_at, is_active`,
      [householdId, id, completedAt]
    )
    await client.query('commit')
    return rows[0] ? toRhythm(rows[0]) : null
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

export interface Completion {
  id: string
  personId: string | null
  completedAt: string
  notes: string | null
}

export interface CompletionHistory {
  completions: Completion[]
  /** How many there are in total, which is usually more than were returned. */
  total: number
  /**
   * The mean gap between consecutive completions, in days — what actually happens, as
   * against the cadence the rhythm claims. Null from fewer than two: one date is not an
   * interval, and reporting 0 would read as "you do this every day".
   */
  averageIntervalDays: number | null
}

/** Bigger than any history panel shows and small enough to stay a cheap read. */
const COMPLETIONS_MAX = 200
const COMPLETIONS_DEFAULT = 50

/**
 * A page of history, newest first, plus a statistic taken over ALL of it.
 *
 * The two halves are deliberately scoped differently. Returning every row was fine for a
 * quarterly rhythm and unbounded for a weekly one — years of history on a screen that
 * shows a handful. But the average has to be computed over the whole table rather than
 * over the page: a "real average" derived from the most recent 50 rows is a *recent*
 * average wearing the wrong label, and the mislabelling only becomes visible to someone
 * who has been using the thing for years. So the server does that arithmetic once, rather
 * than each client doing it over whatever subset it happens to hold — which is exactly how
 * the two surfaces ended up with two spellings of the nudge clamp.
 */
export async function listCompletions(
  householdId: string,
  id: string,
  limit?: number
): Promise<CompletionHistory> {
  const take = Math.min(
    COMPLETIONS_MAX,
    Math.max(1, Number.isFinite(limit) ? Math.floor(limit as number) : COMPLETIONS_DEFAULT)
  )
  const { rows } = await query<{ id: string; person_id: string | null; completed_at: Date; notes: string | null }>(
    `select id, person_id, completed_at, notes
       from rhythm_completions
      where household_id = $1 and rhythm_id = $2
      order by completed_at desc
      limit $3`,
    [householdId, id, take]
  )
  // The span between the first and last completion divided by the gaps between them —
  // the same answer as averaging each interval, in one pass and without pulling the rows.
  const { rows: agg } = await query<{ total: string; avg_days: string | null }>(
    `select count(*)::text as total,
            case when count(*) > 1 then
              (extract(epoch from (max(completed_at) - min(completed_at)))
                 / 86400 / (count(*) - 1))::text
            end as avg_days
       from rhythm_completions
      where household_id = $1 and rhythm_id = $2`,
    [householdId, id]
  )
  return {
    completions: rows.map((r) => ({
      id: r.id,
      personId: r.person_id,
      completedAt: r.completed_at.toISOString(),
      notes: r.notes,
    })),
    total: Number(agg[0]?.total ?? 0),
    averageIntervalDays: agg[0]?.avg_days == null ? null : Number(agg[0].avg_days),
  }
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
  // The skip is keyed on period_start, and every reader matches it against a boundary the
  // SERVER computed. A date that isn't one inserts happily, returns ok, and silences
  // nothing — the row goes on asking and the only evidence the skip existed is a row
  // nobody will ever join to. That is the worst shape a write can have: it reports
  // success and does nothing. A client rendering a period whose boundary has since moved
  // is exactly how it happens.
  //
  // Tiling up to the offered date, the last boundary at or before it IS that date only if
  // the date is itself a boundary.
  const { rows: grid } = await query<{ ok: boolean }>(
    `select (select max((r.starts_on + (n * r.every))::date)
               from generate_series(0, greatest(0, ($2::date - r.starts_on))) n
              where (r.starts_on + (n * r.every)) <= $2::timestamp) = $2::date
              as ok
       from rhythms r where r.id = $1`,
    [id, periodStart]
  )
  if (grid[0]?.ok !== true) {
    throw new InvalidReferenceError(
      `periodStart must be the start of one of this rhythm's periods — '${periodStart}' is not a boundary of its cycle`
    )
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
  // `hasSeries` separates the two ways an auto-scheduled period comes up empty: the
  // series is gone and needs putting back, or it is alive and one instance was cancelled.
  // See the note on RhythmWithPeriod.hasSeries.
  | {
      kind: 'unscheduled'
      rhythm: Rhythm
      periodStart: string
      /** The next period's start — the grid's boundary, and what skips are keyed on. */
      periodEnd: string
      /** Where this period stops accepting bookings; equals `periodEnd` without a window. */
      windowEnd: string
      hasSeries: boolean
    }

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
    `with hh as (select timezone from households where id = $1)
     select r.id, r.title, r.emoji, r.notes, r.person_id, r.satisfied_by, r.every::text as every,
            r.starts_on, r.auto_schedule, r.rrule, r.book_within::text as book_within, r.lead_time::text as lead_time,
            r.last_completed_at, r.next_due_at, r.is_active,
            r.next_due_at as due_at,
            -- Late means LATE, so it is measured against now and nothing else. It used to
            -- be measured against the window's far edge, which made the answer depend on
            -- how far ahead the caller happened to be looking: the weekly planner asks a
            -- week out, so everything due this week came back late, and both clients sort
            -- those first, paint them red and label them "N days late".
            (r.next_due_at < now()) as overdue
       from rhythms r, hh
      where r.household_id = $1
        and r.deleted_at is null and r.is_active
        and r.satisfied_by = 'completion'
        -- "Is the runway open by the END of the horizon day, locally?" next_due_at is a
        -- timestamptz, so comparing it to a bare $2::date resolved at the SESSION zone
        -- (Etc/UTC in the shipped image) and against the START of that day — the only day
        -- boundary in this module that wasn't the household's. For a household behind UTC
        -- that hid a rhythm for its whole first day.
        and (r.next_due_at - r.lead_time) < ((($2::date + 1)::timestamp) at time zone hh.timezone)`,
    [householdId, to]
  )
  for (const r of due.rows) {
    out.push({ kind: 'due', rhythm: toRhythm(r), dueAt: r.due_at.toISOString(), overdue: r.overdue })
  }

  // Scheduling shape: the period covering the window, unsatisfied and not skipped, and
  // only once the booking runway has opened (period_end - lead_time).
  const unscheduled = await query<Row & {
    period_start: string
    period_end: string
    window_end: string
    has_series: boolean
  }>(
    `with hh as (select timezone from households where id = $1),
          periods as (
       select r.*,
              -- The period covering the window: the latest boundary at or before its end.
              -- Interval addition tiles TRUE calendar periods, so '3 months' steps by real
              -- months. Doing it by epoch division would treat a month as 30 days and drift
              -- a little further every quarter.
              --
              -- Tiled to the LATER of the horizon and the household's own now. The horizon
              -- has to stay authoritative for looking ahead — that is what makes a weekly
              -- planner window mean anything — but on its own it let a client's clock name
              -- a current period the household is already past, so the Today card and the
              -- register (which tiles to household-now) could disagree about which period
              -- a rhythm is in. The server owns the period; a client may only ask it to
              -- look further forward, never further back.
              -- Anchored, not cumulative — see the note in listRhythms.
              (select max((r.starts_on + (n * r.every))::date)
                 from generate_series(0, greatest(0,
                        (greatest($2::timestamp, (now() at time zone hh.timezone))::date - r.starts_on))) n
                where (r.starts_on + (n * r.every))
                        <= greatest($2::timestamp, (now() at time zone hh.timezone))
              ) as period_start
         from rhythms r, hh
        where r.household_id = $1
          and r.deleted_at is null and r.is_active
          and r.satisfied_by = 'scheduling'
          and r.starts_on <= $2::date
     )
     select p.id, p.title, p.emoji, p.notes, p.person_id, p.satisfied_by, p.every::text as every,
            p.starts_on, p.auto_schedule, p.rrule, p.book_within::text as book_within, p.lead_time::text as lead_time,
            p.last_completed_at, p.next_due_at, p.is_active,
            p.period_start, (p.period_start + p.every)::date as period_end,
            (p.period_start + coalesce(p.book_within, p.every))::date as window_end,
            exists (
              select 1 from events e
               where e.rhythm_id = p.id and e.deleted_at is null and e.rrule is not null
                 and (e.recurrence_end_at is null
                      or (e.recurrence_end_at > now() and e.recurrence_end_at >= e.starts_at))
            ) as has_series
       from periods p
      -- The runway opens against the WINDOW's end, which is the whole reason the column
      -- exists. Measured from the period's end instead, a monthly rhythm could not be
      -- asked about before mid-month (the runway is clamped to half the cycle), so "book
      -- it in the first week" could not be asked about during the week it means.
      --
      -- ...and it CLOSES there too. Note this is an upper bound on an otherwise unbounded
      -- feed: the completion shape deliberately has none, because an overdue item can
      -- still be done and should keep asking however late it is. A closed booking window
      -- is not that. The week is over; there is nothing left to book, and asking about it
      -- for the remaining three weeks of the month is precisely the nagging that trains
      -- someone to stop reading this list.
      --
      -- It changes nothing for a rhythm without a window, which is all of them before this
      -- column: the window ends where the period does, and the horizon is always inside
      -- the period it was tiled from, so the bound is true by construction. What is missed
      -- is still visible — the register reads listRhythms, not this, and reports the period
      -- unsatisfied and late for as long as it stays that way. This list is for what can be
      -- acted on now; that one is for what is true.
      where (p.period_start + coalesce(p.book_within, p.every))::date - p.lead_time <= $2::date
        and $2::date < (p.period_start + coalesce(p.book_within, p.every))::date
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
          select 1 from events e, hh
           -- A recurring master is a template, not an instance — see the same filter in
           -- the list query. Without it, cancelling the anchor instance left this period
           -- silently absent from the attention feed forever.
           where e.rhythm_id = p.id
             and e.deleted_at is null
             and e.rrule is null
             -- Local midnights, like the list query: a period boundary resolved in the
             -- server's zone puts a 6pm booking west of UTC in the NEXT period.
             and e.starts_at >= (p.period_start::timestamp at time zone hh.timezone)
             and e.starts_at < ((p.period_start + coalesce(p.book_within, p.every))::timestamp at time zone hh.timezone)
        )
        and not exists (
          select 1 from event_occurrences o
           join events m on m.id = o.event_id
           cross join hh
           where m.rhythm_id = p.id
             and m.deleted_at is null
             and o.deleted_at is null
             and o.starts_at >= (p.period_start::timestamp at time zone hh.timezone)
             and o.starts_at < ((p.period_start + coalesce(p.book_within, p.every))::timestamp at time zone hh.timezone)
        )`,
    [householdId, to]
  )
  for (const r of unscheduled.rows) {
    out.push({
      kind: 'unscheduled',
      rhythm: toRhythm(r),
      periodStart: dateText(r.period_start)!,
      periodEnd: dateText(r.period_end)!,
      windowEnd: dateText(r.window_end)!,
      hasSeries: r.has_series ?? false,
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
  /**
   * The booking window, editable in place — unlike everything else about WHEN.
   *
   * The cadence and the anchor are refused because they ARE the period grid: moving
   * either re-reads every boundary, so `rhythm_skips` rows (keyed on period_start) stop
   * matching and existing bookings get re-attributed. A window moves no boundary and
   * re-keys no skip. Narrowing one can leave a booking outside it, which puts that period
   * back to asking — visible, explicable, and undone by widening it again.
   */
  bookWithin?: unknown
  isActive?: unknown
  /** completion shape only — see the note below on why the anchor rule splits by shape. */
  nextDueAt?: unknown
}

// Edit a rhythm. Deliberately covers only the fields that are safe to change in place:
// title/emoji/notes/assignee, the cadence, the runway, active, and — for the completion
// shape only — the due date. `satisfiedBy`, `startsOn`, `autoSchedule` and `rrule` are not
// editable here: changing the shape or the period anchor of a live rhythm would silently
// re-interpret its existing skips (keyed on period_start) and re-point its bookings at
// periods that no longer exist. Retire it and make a new one instead.
//
// `nextDueAt` is the exception to that rule, and the split is by shape rather than by
// taste. A scheduling rhythm's periods ARE its anchor — the grid is generated from
// starts_on, so moving anything re-reads every skip. A completion rhythm has no grid at
// all: next_due_at is a single date saying when it next asks, and nothing else is keyed on
// it. Moving it is "push it out a week", and it is one period's reprieve rather than a
// permanent shift — the next completion re-anchors from when you actually did it.
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

  let nextDueAt: string | null = null
  if (input.nextDueAt !== undefined && input.nextDueAt !== null) {
    // Refused rather than ignored. Letting it through would hit the shape CHECK and come
    // back as a constraint violation — a 500 where the caller deserves a sentence.
    if (existing.satisfiedBy !== 'completion') {
      throw new InvalidReferenceError(
        'only a completion rhythm has a due date; a scheduling rhythm is anchored to its periods'
      )
    }
    if (typeof input.nextDueAt !== 'string' || Number.isNaN(Date.parse(input.nextDueAt))) {
      throw new InvalidReferenceError('nextDueAt must be an ISO timestamp')
    }
    nextDueAt = new Date(input.nextDueAt).toISOString()
  }

  // The edit path can poison the register exactly as the create path could.
  if (typeof input.every === 'string' && input.every.trim()) {
    await assertUsableCadence(input.every.trim())
    // ...and on a scheduling rhythm it can do the OTHER harm this function already
    // refuses `startsOn` for. Its periods are generate_series(starts_on, …, every), so a
    // new cadence re-reads every boundary: rhythm_skips rows are keyed on period_start and
    // silently stop matching, and existing bookings get re-attributed. Skip September on a
    // monthly rhythm, change it to quarterly, and the period you deliberately silenced
    // starts nagging again.
    //
    // Split by shape, like nextDueAt below: a completion rhythm has no grid and nothing
    // keyed on one, so moving its cadence just moves the next due date.
    //
    // Restating the same cadence is not a change — clients send the whole form back on
    // save, and refusing an unchanged field would make every edit a 400.
    //
    // Compared as INTERVALS, not as strings. The clients build "3 months" out of a number
    // and a unit while Postgres renders the stored column as "3 mons", so a string test
    // calls every unchanged cadence a change and refuses every ordinary edit. Only
    // Postgres knows these are the same value, so Postgres is asked.
    if (existing.satisfiedBy === 'scheduling') {
      const { rows } = await query<{ same: boolean }>(
        `select ($1::interval = $2::interval) as same`, [input.every.trim(), existing.every]
      )
      if (rows[0]?.same !== true) {
        throw new InvalidReferenceError(
          "a scheduling rhythm's cadence is its period grid, and changing it would re-read every period — including the ones already skipped or booked. Retire it and make a new one."
        )
      }
    }
  }
  if (typeof input.leadTime === 'string' && input.leadTime.trim()) {
    await assertUsableLeadTime(input.leadTime.trim())
  }
  // Compared against the cadence as it will be after this update — which, on a scheduling
  // rhythm, is the cadence it already had, since a change to that is refused above.
  const bookWithin = input.bookWithin === undefined
    ? undefined
    : (typeof input.bookWithin === 'string' && input.bookWithin.trim() ? input.bookWithin.trim() : null)
  if (bookWithin) {
    if (existing.satisfiedBy !== 'scheduling') {
      throw new InvalidReferenceError(
        'only a scheduling rhythm can have a booking window; a completion rhythm has no periods for one to sit inside'
      )
    }
    if (existing.autoSchedule) {
      throw new InvalidReferenceError(
        'a rhythm that puts itself on the calendar cannot also have a booking window — its rule already decides which day inside the period, so there is nothing left to pick'
      )
    }
    await assertWindowFitsCadence(bookWithin, existing.every)
  }

  const { rows } = await query<Row>(
    `update rhythms set
       title      = coalesce($3, title),
       emoji      = case when $4::boolean then $5 else emoji end,
       notes      = case when $6::boolean then $7 else notes end,
       person_id  = case when $8::boolean then $9::uuid else person_id end,
       every      = coalesce($10::interval, every),
       book_within = case when $14::boolean then $15::interval else book_within end,
       -- Re-clamped on every write, against the cadence AND the window as they will be
       -- AFTER this update. Shortening a six-month rhythm to weekly would otherwise leave
       -- it a 14-day runway it can never close; narrowing a fortnight-long window to three
       -- days would leave a runway that opens before the period it belongs to.
       --
       -- Split by shape for the reason the inserts are: a scheduling rhythm's feed closes
       -- when its window does, so it can afford a runway as long as its cycle; a
       -- completion rhythm's never closes on its own, so it keeps half.
       lead_time  = least(
                      coalesce($11::interval, lead_time),
                      case when satisfied_by = 'scheduling'
                           then coalesce(
                                  case when $14::boolean then $15::interval else book_within end,
                                  coalesce($10::interval, every)
                                )
                           else coalesce($10::interval, every) / 2
                      end
                    ),
       is_active  = coalesce($12::boolean, is_active),
       -- Guarded above: only ever non-null for a completion rhythm, whose shape CHECK
       -- requires next_due_at to stay set. A scheduling rhythm must keep it null.
       next_due_at = coalesce($13::timestamptz, next_due_at),
       updated_at = now()
     where household_id = $1 and id = $2 and deleted_at is null
     returning id, title, emoji, notes, person_id, satisfied_by, every::text as every,
               starts_on, auto_schedule, rrule, book_within::text as book_within, lead_time::text as lead_time,
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
      nextDueAt,
      bookWithin !== undefined,
      bookWithin ?? null,
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
  /** Which period the caller means to fill. Optional; checked when given. */
  periodStart?: unknown
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

  // Optionally: which period the caller BELIEVES it is filling.
  //
  // Satisfaction is derived per period, so a booking is always legal — it just settles
  // whichever period it happens to land in. That makes booking ahead work, which is worth
  // keeping. What it also made possible was a booking that landed in no period the user
  // was looking at: the request succeeded, a real event appeared on the calendar, and the
  // card carried on asking, with nothing anywhere saying why. The server cannot infer the
  // intent from an instant alone, so the caller says it, and the server checks it. Both
  // clients already hold the period they are showing.
  //
  // Optional so an older client keeps working exactly as before.
  const claimed = typeof input.periodStart === 'string' && input.periodStart ? input.periodStart : null
  if (claimed) {
    assertRealDate(claimed, 'periodStart')
    const { rows } = await query<{ inside: boolean }>(
      `with hh as (select timezone from households where id = $2)
       select $3::timestamptz >= ($1::date::timestamp at time zone hh.timezone)
          -- The window, not the period. This check exists precisely so a booking cannot
          -- succeed while leaving the period it was meant to settle still asking — which
          -- is exactly what a booking inside the period but outside the window would do.
          and $3::timestamptz <  (($1::date + coalesce(r.book_within, r.every))::timestamp at time zone hh.timezone)
              as inside
         from rhythms r, hh where r.id = $4`,
      [claimed, tenant.householdId, new Date(startsAt).toISOString(), rhythmId]
    )
    if (rows[0]?.inside !== true) {
      throw new InvalidReferenceError(
        `that time is not inside the booking window of the period starting ${claimed} — booking it would leave that period still asking`
      )
    }
  }

  // An auto_schedule rhythm books its whole series at once — the rule already says when
  // it recurs, so asking the caller to restate it would just be a chance to disagree with
  // the rhythm. But ONLY when nothing recurring is left alive. Handing the rrule over
  // unconditionally meant booking a period whose series was perfectly healthy — one
  // instance cancelled, say — created a SECOND weekly series beside the first and doubled
  // every future occurrence, permanently. What was empty was the period, not the series.
  const live = await query<{ id: string }>(
    `select id from events
      where rhythm_id = $1 and household_id = $2 and deleted_at is null and rrule is not null
        and (recurrence_end_at is null
             or (recurrence_end_at > now() and recurrence_end_at >= starts_at))
      limit 1`,
    [rhythm.id, tenant.householdId]
  )
  return createEvent(tenant, {
    title,
    startsAt,
    endsAt,
    allDay: input.allDay === true,
    personId: rhythm.personId,
    rhythmId: rhythm.id,
    rrule: rhythm.autoSchedule && live.rowCount === 0 ? rhythm.rrule : null,
  })
}
