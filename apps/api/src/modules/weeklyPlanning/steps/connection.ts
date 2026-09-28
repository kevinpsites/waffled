// Weekly Planning · step 5 (Connection) — "Who gets time with whom?"
//
// THE STEP STORES NOTHING, AND THAT IS THE WHOLE DESIGN. A pairing is a QUERY over
// event_participants for an event whose people are exactly those two; picking a slot writes an
// ordinary calendar event through the app's own event modal. There is no `pairings` table, no
// migration and no write route here — if a change starts to want one, the step has been misread.
//
// TIME THAT ALREADY EXISTS GETS CREDIT: `alreadyThisWeek` is computed first and is what the row
// leads with. Recurring answers live in event_occurrences rather than `events`, hence
// rangeEvents() rather than a bare select — which is also what keeps this step and the Calendar
// step agreeing about what is on the week.
import { DateTime } from 'luxon'
import { query } from '../../../platform/db'
import { rangeEvents, type EventRow } from '../../events/events'
import { householdTz, todayDate } from '../../chores/chores.service'

// How far back "the last time it was just the two of you" looks. Bounded by the recurrence
// expansion window (expansion.service PAST_MONTHS = 3): occurrences older than that have aged
// out of event_occurrences, so asking for more would report a wrong date. Falling off the end
// reads as "never", which overstates the staleness — the safe direction.
const LOOKBACK_DAYS = 90

const LATEST_START_HOUR = 22

const SHORT_TITLE = 18

export interface ConnectionSlot {
  /** The day inside the planned week (YYYY-MM-DD, household-local). */
  date: string
  /**
   * When the gap opens, or null for a day with nothing on it. NULL IS NOT "unknown": the whole
   * day is free and the event modal's picker should decide, rather than this file naming an hour.
   */
  startsAt: string | null
  kind: 'after' | 'open'
  afterTitle: string | null
  /**
   * "Wed after Scouts" / "Tue after 8:30 PM" / "Sun · free all day". Built server-side so web and
   * iOS say it the same way, and both halves spell their meaning out — an empty day reads "free
   * all day", never a bare "open".
   */
  label: string
}

export interface ConnectionEvent {
  id: string
  title: string
  startsAt: string
  endsAt: string | null
  allDay: boolean
  minutes: number | null
  day: string
  time: string | null
  when: string
}

export interface ConnectionPairing {
  personIds: string[]
  who: string
  lastTogetherOn: string | null
  lastTogetherTitle: string | null
  alreadyThisWeek: ConnectionEvent[]
  togetherThisWeek: ConnectionEvent[]
  slots: ConnectionSlot[]
}

export interface ConnectionBoard {
  weekStart: string
  pairings: ConnectionPairing[]
}

interface Person { id: string; name: string }

function peopleOf(e: EventRow): string[] {
  const ids = (e.participants ?? []).map((p) => p.id)
  if (ids.length) return [...new Set(ids)]
  return e.person_id ? [e.person_id] : []
}

const sameSet = (a: string[], b: Set<string>) => a.length === b.size && a.every((id) => b.has(id))

function minutesOf(e: EventRow): number | null {
  if (!e.ends_at || e.all_day) return null
  return Math.round((new Date(e.ends_at).getTime() - new Date(e.starts_at).getTime()) / 60000)
}

function present(e: EventRow, tz: string): ConnectionEvent {
  const start = DateTime.fromJSDate(new Date(e.starts_at), { zone: tz })
  return {
    id: e.id,
    title: e.title,
    startsAt: new Date(e.starts_at).toISOString(),
    endsAt: e.ends_at ? new Date(e.ends_at).toISOString() : null,
    allDay: e.all_day,
    minutes: minutesOf(e),
    day: start.toFormat('cccc'),
    time: e.all_day ? null : start.toFormat('h:mm a'),
    when: e.all_day ? `${start.toFormat('cccc')}, all day` : start.toFormat('cccc h:mm a'),
  }
}

export function whoLabel(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * The gaps a set of people have left in the planned week. A day is busy for the set if ANY of
 * them is on a timed event that day (plus household-wide events). All-day rows are deliberately
 * ignored: they have no end to open a gap after, and most are birthdays and notes rather than
 * something that occupies the evening.
 */
export function slotsFor(
  weekStart: string,
  events: EventRow[],
  people: string[],
  tz: string,
  now: Date
): ConnectionSlot[] {
  const set = new Set(people)
  const today = todayDate(tz)
  const byDay = new Map<string, EventRow[]>()
  for (const e of events) {
    if (e.all_day) continue
    const who = peopleOf(e)
    if (who.length && !who.some((id) => set.has(id))) continue
    const key = DateTime.fromJSDate(new Date(e.starts_at), { zone: tz }).toISODate()!
    const list = byDay.get(key)
    if (list) list.push(e)
    else byDay.set(key, [e])
  }

  const out: ConnectionSlot[] = []
  for (let i = 0; i < 7; i++) {
    const d = DateTime.fromISO(weekStart, { zone: tz }).plus({ days: i })
    const date = d.toISODate()!
    if (date < today) continue // a gap that has already gone by is not an offer
    const dow = d.toFormat('EEE')
    const onDay = byDay.get(date) ?? []

    if (!onDay.length) {
      out.push({ date, startsAt: null, kind: 'open', afterTitle: null, label: `${dow} · free all day` })
      continue
    }
    // The gap opens when the LAST thing on the day ends (an event with no end is treated as an
    // hour, which is what the event modal defaults a new one to).
    let after: EventRow | null = null
    let end = 0
    for (const e of onDay) {
      const t = e.ends_at ? new Date(e.ends_at).getTime() : new Date(e.starts_at).getTime() + 3600_000
      if (t > end) { end = t; after = e }
    }
    const opens = DateTime.fromMillis(end, { zone: tz })
    if (opens.hour >= LATEST_START_HOUR || opens.toMillis() <= now.getTime()) continue
    const title = after!.title
    out.push({
      date,
      startsAt: opens.toUTC().toISO()!,
      kind: 'after',
      afterTitle: title,
      label: title.length <= SHORT_TITLE ? `${dow} after ${title}` : `${dow} after ${opens.toFormat('h:mm a')}`,
    })
  }

  return out.sort((a, b) => {
    const ra = a.kind === 'open' ? -1 : DateTime.fromISO(a.startsAt!, { zone: tz }).hour * 60 + DateTime.fromISO(a.startsAt!, { zone: tz }).minute
    const rb = b.kind === 'open' ? -1 : DateTime.fromISO(b.startsAt!, { zone: tz }).hour * 60 + DateTime.fromISO(b.startsAt!, { zone: tz }).minute
    return ra - rb || a.date.localeCompare(b.date)
  })
}

export async function householdPeople(householdId: string): Promise<Person[]> {
  const { rows } = await query<{ id: string; name: string }>(
    `select p.id, p.name
       from persons p
      where p.household_id = $1 and p.deleted_at is null
      order by p.sort_order, p.created_at, p.id`,
    [householdId]
  )
  return rows
}

/**
 * The week's events as this step reads them. `viewerPersonId` is the DRIVER's person, not null:
 * `visibleTo` hides personal-visibility events from everyone but their owner, so reading as
 * nobody would hide the driver's own calendar and offer a slot in a gap step 2 draws as full.
 */
async function weekAndHistory(householdId: string, weekStart: string, viewerPersonId: string) {
  const start = DateTime.fromISO(weekStart)
  const [week, history] = await Promise.all([
    rangeEvents(householdId, weekStart, start.plus({ days: 6 }).toISODate()!, viewerPersonId),
    rangeEvents(householdId, start.minus({ days: LOOKBACK_DAYS }).toISODate()!, start.minus({ days: 1 }).toISODate()!, viewerPersonId),
  ])
  return { week, history }
}

export async function getConnectionBoard(
  householdId: string,
  weekStart: string,
  viewerPersonId: string,
  now = new Date()
): Promise<ConnectionBoard> {
  const [tz, people] = await Promise.all([householdTz(householdId), householdPeople(householdId)])
  const { week, history } = await weekAndHistory(householdId, weekStart, viewerPersonId)

  const pairings: ConnectionPairing[] = []
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const a = people[i]
      const b = people[j]
      const set = new Set([a.id, b.id])

      const already: ConnectionEvent[] = []
      const together: ConnectionEvent[] = []
      for (const e of week) {
        const who = peopleOf(e)
        if (sameSet(who, set)) already.push(present(e, tz))
        else if (set.size && [...set].every((id) => who.includes(id))) together.push(present(e, tz))
      }

      let last: EventRow | null = null
      for (const e of history) if (sameSet(peopleOf(e), set)) last = e

      pairings.push({
        personIds: [a.id, b.id],
        who: whoLabel([a.name, b.name]),
        lastTogetherOn: last ? DateTime.fromJSDate(new Date(last.starts_at), { zone: tz }).toISODate() : null,
        lastTogetherTitle: last?.title ?? null,
        alreadyThisWeek: already,
        togetherThisWeek: together,
        slots: slotsFor(weekStart, week, [a.id, b.id], tz, now),
      })
    }
  }

  const staleness = (p: ConnectionPairing) =>
    p.lastTogetherOn === null
      ? Number.MAX_SAFE_INTEGER
      : Math.round(DateTime.fromISO(weekStart).diff(DateTime.fromISO(p.lastTogetherOn), 'days').days)
  // Keyed by ids, NOT by `who`: two people can share a first name (a Jr., two Sams),
  // and a name-keyed map would collapse two pairings into one and shuffle the order.
  const order = new Map(pairings.map((p, idx) => [p.personIds.join('-'), idx]))
  pairings.sort(
    (x, y) =>
      staleness(y) - staleness(x) ||
      y.togetherThisWeek.length - x.togetherThisWeek.length ||
      order.get(x.personIds.join('-'))! - order.get(y.personIds.join('-'))!
  )

  return { weekStart, pairings }
}

export async function getConnectionSlots(
  householdId: string,
  weekStart: string,
  viewerPersonId: string,
  personIds: string[],
  now = new Date()
): Promise<{ weekStart: string; personIds: string[]; who: string; slots: ConnectionSlot[] }> {
  const [tz, people] = await Promise.all([householdTz(householdId), householdPeople(householdId)])
  const wanted = new Set(personIds)
  const chosen = people.filter((p) => wanted.has(p.id))
  if (chosen.length !== wanted.size || chosen.length < 2) {
    throw new InvalidPairingError('a pairing needs at least two people from this household')
  }
  const week = await rangeEvents(
    householdId,
    weekStart,
    DateTime.fromISO(weekStart).plus({ days: 6 }).toISODate()!,
    viewerPersonId
  )
  const ids = chosen.map((p) => p.id)
  return { weekStart, personIds: ids, who: whoLabel(chosen.map((p) => p.name)), slots: slotsFor(weekStart, week, ids, tz, now) }
}

export class InvalidPairingError extends Error {}


// ---------------------------------------------------------------------------
// The one thing this step remembers
// ---------------------------------------------------------------------------

/**
 * WHICH EVENT ANSWERS EACH PAIRING, merged onto the step row.
 *
 * Still "nothing new is stored": this records no event, no pairing and no time — only a pointer
 * from a pairing to an event that already exists, because a link is the ANSWER to a pairing and
 * has to outlive the render that made it.
 *
 * MERGED, AND NOT A DECISION. On conflict `status` and `decided_at` are left alone (as the Goals
 * step's `writeFocus` does): the shell's `decideStep` stamps `decided_at = now()` on every write,
 * which is right when somebody presses the primary and wrong here — re-linking on a settled step
 *
 * `jsonb_set` keeps whatever else the step wrote, and the step body mirrors this map back through
 * `setDecisionData` so pressing the primary doesn't wipe it.
 */
export async function writeConnectionLinks(sessionId: string, links: Record<string, string>): Promise<void> {
  await query(
    `insert into planning_session_steps (session_id, step_key, status, data)
     values ($1, 'connection', 'pending', jsonb_build_object('links', $2::jsonb))
     on conflict (session_id, step_key)
       do update set data = jsonb_set(coalesce(planning_session_steps.data, '{}'::jsonb), '{links}', $2::jsonb, true)`,
    [sessionId, JSON.stringify(links)]
  )
}
