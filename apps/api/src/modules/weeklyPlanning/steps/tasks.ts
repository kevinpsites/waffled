// Weekly Planning · step 8 (Tasks) — "Who's doing what?" A strip of everything nobody has
// taken, and a column per member showing what they carry for the week being planned.
//
// THE UNIT IS THE CHORE DEFINITION, NOT THE INSTANCE. A chore_instance is one day; the
// session plans a week, and reading a week instance-by-instance would side-effect-
// materialize seven days of rows (ensureTodayInstances writes). The days a card lands on
// are computed here, one place, so web and iOS can't disagree. The columns are
// SERVER-OWNED: a column is what someone is carrying, not a log of this sitting.
import { query } from '../../../platform/db'
import { householdTz, todayDate } from '../../chores/chores.service'
import type { QueryResultRow } from 'pg'

export type Cadence = 'daily' | 'weekly' | 'once'

export function cadenceOf(rrule: string | null): Cadence {
  if (!rrule) return 'once'
  if (/FREQ=WEEKLY/i.test(rrule)) return 'weekly'
  if (/FREQ=DAILY/i.test(rrule)) return 'daily'
  return 'once'
}

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

// UTC math on a plain date, so no timezone can shift which day a chore is shown on.
export function weekDates(weekStart: string): string[] {
  const out: string[] = []
  const d = new Date(`${weekStart}T00:00:00Z`)
  for (let i = 0; i < 7; i++) {
    out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

// Which of the week's days a recurring chore lands on. Mirrors the rule
// ensureTodayInstances materializes by (DAILY every day; WEEKLY on its BYDAY codes), so
// the board can't promise a day the chores module won't produce. WEEKLY with no BYDAY
// lands nowhere, and says so.
export function recurringDays(rrule: string, dates: string[]): string[] {
  if (/FREQ=DAILY/i.test(rrule)) return [...dates]
  if (!/FREQ=WEEKLY/i.test(rrule)) return []
  const byDay = rrule.match(/BYDAY=([A-Z,]+)/i)?.[1]?.toUpperCase() ?? ''
  if (!byDay) return []
  const wanted = new Set(byDay.split(','))
  return dates.filter((d) => wanted.has(WEEKDAY_CODES[new Date(`${d}T00:00:00Z`).getUTCDay()]))
}

export interface TasksBoardChore {
  id: string
  title: string
  emoji: string | null
  rrule: string | null
  cadence: Cadence
  days: string[]
  // A one-off's own date, which may sit outside the planned week. null for recurring.
  dueOn: string | null
  dueTime: string | null
  // A one-off whose day has PASSED, still open, that rolls forward. NOT merely "dated
  // before the week": a session usually plans NEXT week.
  carriedOver: boolean
  rewardAmount: number
  rewardCurrency: string | null
  // The two settings a card never draws but the chore editor does. ChoreModal treats a
  // missing flag as false, so leaving them out would quietly switch "Needs a parent's
  // OK" off the first time anybody fixed a typo here.
  requiresApproval: boolean
  requiresPhoto: boolean
  // Every still-open day of this chore already on a board. updateChore only cascades to
  // instances from today forward, so days already behind us have to be moved by hand.
  // EVERY such day comes back, and for an OWNED chore too — that is what makes handing
  // one out reversible.
  pendingInstanceIds: string[]
}

export interface TasksBoardPerson {
  id: string
  name: string
  avatarEmoji: string | null
  colorHex: string | null
  memberType: string
  isAdmin: boolean
  // Active chores that repeat: one-offs are not a standing commitment. NOT an occurrence count.
  recurringChores: number
  chores: TasksBoardChore[]
}

export interface TasksBoard {
  weekStart: string
  // The day a task ADDED during this session should land on. Server-owned for the same
  // reason the week boundary is: a client would use the browser's today, so adding a task
  // during a Wednesday session planning next week would quietly date it to the Wednesday.
  newTaskDay: string
  people: TasksBoardPerson[]
  unassigned: TasksBoardChore[]
}

interface ChoreRowForBoard extends QueryResultRow {
  id: string
  title: string
  emoji: string | null
  person_id: string | null
  rrule: string | null
  rollover: boolean
  reward_amount: number
  reward_currency: string | null
  due_time: string | null
  requires_approval: boolean
  requires_photo: boolean
  instance_due_on: string | null
  instance_status: string | null
}

async function choreRows(householdId: string): Promise<ChoreRowForBoard[]> {
  const { rows } = await query<ChoreRowForBoard>(
    `select c.id, c.title, c.emoji, c.person_id, c.rrule, c.rollover,
            c.reward_amount, c.reward_currency, c.due_time::text as due_time,
            c.requires_approval, c.requires_photo,
            i.due_on::text as instance_due_on, i.status as instance_status
       from chores c
       left join lateral (
         select ci.due_on, ci.status
           from chore_instances ci
          where ci.chore_id = c.id and ci.deleted_at is null
          order by (ci.status = 'pending') desc, ci.due_on
          limit 1
       ) i on true
      where c.household_id = $1 and c.is_active and c.deleted_at is null
      order by c.title`,
    [householdId]
  )
  return rows
}

// Every materialized instance still open, per chore — ALL the days a hand-out has to fix,
// and taking it back has to fix again. Not filtered by person_id, because a move is
// reversible. Only 'pending' rows: a day somebody completed keeps its owner.
async function pendingInstanceIds(householdId: string): Promise<Map<string, string[]>> {
  const { rows } = await query<{ chore_id: string; ids: string[] }>(
    `select ci.chore_id, array_agg(ci.id order by ci.due_on) as ids
       from chore_instances ci
       join chores c on c.id = ci.chore_id and c.deleted_at is null
      where ci.household_id = $1
        and ci.status = 'pending' and ci.deleted_at is null
        -- Only days that AGREE with the definition: unclaimed, or on whoever owns the
        -- chore. A day somebody claimed for themselves off an up-for-grabs chore is
        -- their own doing, and this board has no business handing it to someone else.
        and (ci.person_id is null or ci.person_id is not distinct from c.person_id)
      group by ci.chore_id`,
    [householdId]
  )
  return new Map(rows.map((r) => [r.chore_id, r.ids]))
}

function present(
  r: ChoreRowForBoard,
  days: string[],
  carriedOver: boolean,
  pendingInstanceIds: string[]
): TasksBoardChore {
  return {
    id: r.id,
    title: r.title,
    emoji: r.emoji,
    rrule: r.rrule,
    cadence: cadenceOf(r.rrule),
    days,
    dueOn: r.rrule ? null : r.instance_due_on,
    dueTime: r.due_time ? String(r.due_time).slice(0, 5) : null,
    carriedOver,
    rewardAmount: Number(r.reward_amount ?? 0),
    rewardCurrency: r.reward_currency,
    requiresApproval: r.requires_approval,
    requiresPhoto: r.requires_photo,
    pendingInstanceIds,
  }
}

// Where a chore sits relative to the week being planned; null ⇒ it doesn't belong on the
// board. `today` — not the week start — is what decides "carried over": a session normally
// plans NEXT week, so judging by the week start would brand a task just written down.
function placeInWeek(
  r: ChoreRowForBoard,
  dates: string[],
  today: string
): { days: string[]; carriedOver: boolean } | null {
  if (r.rrule) return { days: recurringDays(r.rrule, dates), carriedOver: false }
  const due = r.instance_due_on
  if (!due) return { days: [], carriedOver: false }
  if (dates.includes(due)) return { days: [due], carriedOver: false }
  if (due < dates[0]) {
    if (r.instance_status !== 'pending') return null
    // Its day has passed and it's still open: it rolls into the week without a day in it.
    if (due < today) return r.rollover ? { days: [], carriedOver: true } : null
    // Still ahead of us, just before the week starts — a task made today, nobody's leftover.
    return { days: [], carriedOver: false }
  }
  return null
}

export async function getTasksBoard(householdId: string, weekStart: string): Promise<TasksBoard> {
  const dates = weekDates(weekStart)
  // The household's own today, taken from the chores module rather than computed here: a
  // chore day rolls at household-local midnight, not UTC's.
  const today = todayDate(await householdTz(householdId))
  const [{ rows: personRows }, chores, pending] = await Promise.all([
    query<QueryResultRow>(
      `select p.id, p.name, p.avatar_emoji, p.color_hex, p.member_type, p.is_admin
         from persons p
        where p.household_id = $1 and p.deleted_at is null
        order by p.sort_order, p.created_at`,
      [householdId]
    ),
    choreRows(householdId),
    pendingInstanceIds(householdId),
  ])

  const byPerson = new Map<string, TasksBoardChore[]>()
  const recurring = new Map<string, number>()
  const unassigned: TasksBoardChore[] = []

  for (const r of chores) {
    if (r.person_id && r.rrule) recurring.set(r.person_id, (recurring.get(r.person_id) ?? 0) + 1)

    if (r.person_id == null) {
      // The strip is everything nobody has taken — deliberately NOT week-scoped. Up for
      // grabs is up for grabs until someone takes it.
      const place = placeInWeek(r, dates, today) ?? { days: [], carriedOver: false }
      unassigned.push(present(r, place.days, place.carriedOver, pending.get(r.id) ?? []))
      continue
    }
    const place = placeInWeek(r, dates, today)
    if (!place) continue
    const list = byPerson.get(r.person_id) ?? []
    list.push(present(r, place.days, place.carriedOver, pending.get(r.id) ?? []))
    byPerson.set(r.person_id, list)
  }

  const people: TasksBoardPerson[] = personRows.map((p) => ({
    id: p.id,
    name: p.name,
    avatarEmoji: p.avatar_emoji,
    colorHex: p.color_hex,
    memberType: p.member_type,
    isAdmin: p.is_admin,
    recurringChores: recurring.get(p.id) ?? 0,
    chores: (byPerson.get(p.id) ?? []).sort(
      (a, b) => (a.days[0] ?? '9999').localeCompare(b.days[0] ?? '9999') || a.title.localeCompare(b.title)
    ),
  }))

  const newTaskDay = today >= dates[0] && today <= dates[6] ? today : dates[0]

  return { weekStart, newTaskDay, people, unassigned }
}
