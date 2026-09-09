// Step 6 · Goals — "What's each group's focus this week?"
//
// This step invents nothing (see docs/product/weekly-planning-plan.md): the tabs are the
// `goal_lists` that already exist and picking one sets the goal's existing `is_featured`
// flag. What has no other home is WHICH GROUPS THIS SESSION SETTLED, since "nothing this
// week" is a real answer indistinguishable from "not got to it yet" — so the session keeps
// a `{ focus: { <listId>: <goalId> | null } }` map in `planning_session_steps.data`.
//
// That map keeps the write NON-DESTRUCTIVE: `is_featured` is the goals screen's additive
// "Pinned" tier, so changing a focus un-features ONLY the goal this session set for the
// list. PRIVACY: `goal_lists.is_private` is enforced HERE — a private list is dropped from
// the read for non-members and naming it in a write 404s, with no admin bypass.
import type { PoolClient } from 'pg'
import { query, getPool } from '../../../platform/db'
import type { Tenant } from '../../households/households'
import { listGoalLists, listGoals, periodStartSQL } from '../../goals/goals.service'
import { getSessionById } from '../weeklyPlanning'

const STEP_KEY = 'goals'

// What the session decided per list. A key PRESENT means settled; `null` means it settled
// on "nothing this week".
export type FocusMap = Record<string, string | null>

type GoalList = Awaited<ReturnType<typeof listGoalLists>>[number]
type Goal = Awaited<ReturnType<typeof listGoals>>[number]

// A goal as this step shows it: the goals screen's fields plus how it is going (`paceFor`).
export interface GoalsStepGoal extends Goal {
  pace: Pace | null
}

export interface GoalsStepMember {
  personId: string
  name: string
  avatarEmoji: string | null
  colorHex: string | null
  // Null when we don't know their birthday — the sub line omits the age rather than guess.
  age: number | null
}

export interface GoalsStepGroup extends Omit<GoalList, 'id' | 'goalCount' | 'members'> {
  // Named `listId` rather than `id` so a client can never confuse a tab with a goal.
  listId: string
  members: GoalsStepMember[]
  // Literally every person, so the sub line can say "everyone" without counting people.
  isEveryone: boolean
  goals: GoalsStepGoal[]
  // True when THIS session has answered for this group — the ★ on the tab.
  settled: boolean
  // What it answered: a goal id, or null for "nothing this week".
  focusGoalId: string | null
}

export interface GoalsStepView {
  groups: GoalsStepGroup[]
}

// Pace — the second half of a goal row's subtitle ("kind · pace"), derived from real
// `goal_logs` activity SERVER-side so web and iOS read the same verdict. One grouped query
// gives the first and last log's local day, distinct days in the last 7 and 28, the amount
// in the last 7, and — for habits — days logged in the PREVIOUS habit period.
export type PaceTone = 'ok' | 'flat' | 'behind'
export interface Pace {
  text: string
  tone: PaceTone
}

interface ActivityRow {
  goal_id: string
  first_day: string | null
  last_day: string | null
  days_last7: number
  days_last28: number
  amount_last7: number
  prev_period_days: number
  today: string
}

export interface Activity {
  firstDay: string | null
  lastDay: string | null
  daysLast7: number
  daysLast28: number
  amountLast7: number
  prevPeriodDays: number
  today: string
}

const DAY_MS = 86400000
const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY_MS
// The same reading `fmtGoalNum` gives on the client, so sentence and number never disagree.
const fmtNum = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })
const fmtDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// One goal's pace, or null when there is genuinely nothing to say.
export function paceFor(goal: Goal, a: Activity | undefined): Pace | null {
  if (!a) return null
  const since = a.lastDay ? dayNum(a.today) - dayNum(a.lastDay) : null

  // Never logged. Said plainly rather than dressed up as a rate.
  if (a.lastDay == null || since == null) return { text: 'nothing logged yet', tone: 'behind' }

  // Gone quiet. Naming the date it stopped is more use than naming the size of the gap.
  if (since >= 21) return { text: `nothing logged in ${plural(Math.floor(since / 7), 'week', 'weeks')}`, tone: 'behind' }
  if (since >= 8) return { text: `stalled since ${fmtDay(a.lastDay)}`, tone: 'behind' }

  // A habit is judged on its cadence, against the cadence it set itself.
  const habitTarget = goal.goalType === 'habit' ? goal.habitTargetPerPeriod ?? goal.target ?? 0 : 0
  if (habitTarget > 0) {
    const period = goal.habitPeriod ?? 'week'
    return {
      text: `${a.prevPeriodDays} of ${fmtNum(habitTarget)} last ${period}`,
      tone: a.prevPeriodDays >= habitTarget ? 'ok' : 'behind',
    }
  }

  // The long slow burn: its weekly number would be noise, so the cadence is honest.
  const span = a.firstDay ? dayNum(a.today) - dayNum(a.firstDay) : 0
  if (span >= 56 && a.daysLast28 <= 2 && goal.totalProgress > 0) {
    const perMonth = goal.totalProgress / (span / 30.44)
    const unit = goal.unit ? ` ${goal.unit}` : ''
    return { text: `roughly ${fmtNum(Math.round(perMonth * 100) / 100)}${unit} a month`, tone: 'flat' }
  }

  // Recent and measurable. `ok` only where there is a target to be ok against.
  if (a.amountLast7 > 0 && goal.unit) {
    const target = goal.goalType === 'checklist' ? goal.stepTotal : goal.target
    return { text: `${fmtNum(a.amountLast7)} ${goal.unit} last week`, tone: target ? 'ok' : 'flat' }
  }
  if (a.daysLast7 > 0) return { text: `${plural(a.daysLast7, 'day', 'days')} logged last week`, tone: 'ok' }
  return { text: `last logged ${fmtDay(a.lastDay)}`, tone: 'flat' }
}

// Every live goal's recent activity in one grouped query.
//
// `prev_period_days` imports `periodStartSQL` rather than restating it, so "2 of 5 last
// week" is on the same clock as the screen's "3 of 5". Never a bare `date_trunc('week', …)`:
// that is MONDAY-only, so a Sunday-start household's Sunday log lands in the wrong period.
async function recentActivity(householdId: string): Promise<Map<string, Activity>> {
  const { rows } = await query<ActivityRow>(
    `with local as (select id, timezone, week_start, (now() at time zone timezone)::date as today
                      from households where id = $1),
          logs as (
            select gl.goal_id,
                   (gl.logged_at at time zone l.timezone)::date as day,
                   gl.amount, gl.counts_total
              from goal_logs gl join local l on l.id = gl.household_id
             where gl.household_id = $1 and gl.deleted_at is null
          )
     select g.id as goal_id,
            min(lg.day)::text as first_day,
            max(lg.day)::text as last_day,
            count(distinct lg.day) filter (where lg.day > l.today - 7) as days_last7,
            count(distinct lg.day) filter (where lg.day > l.today - 28) as days_last28,
            coalesce(sum(lg.amount) filter (where lg.day > l.today - 7 and lg.counts_total), 0)::float as amount_last7,
            (case when g.goal_type = 'habit' then (
               select count(distinct (gl2.logged_at at time zone l.timezone)::date)
                 from goal_logs gl2
                where gl2.goal_id = g.id and gl2.deleted_at is null
                  and (gl2.logged_at at time zone l.timezone)
                      >= (${periodStartSQL('l')})
                         - (case g.habit_period when 'day' then interval '1 day'
                                                when 'month' then interval '1 month'
                                                else interval '1 week' end)
                  and (gl2.logged_at at time zone l.timezone)
                      < (${periodStartSQL('l')})
             ) else 0 end) as prev_period_days,
            l.today::text as today
       from goals g
       cross join local l
       left join logs lg on lg.goal_id = g.id
      where g.household_id = $1 and g.deleted_at is null and g.is_active
      -- l.week_start joins the grouping because the correlated subquery above reads it:
      -- an aggregate query may only reference outer columns that are grouped, and Postgres
      -- infers functional dependency from a real table's primary key, never through a CTE.
      group by g.id, g.goal_type, g.habit_period, l.today, l.timezone, l.week_start`,
    [householdId]
  )
  return new Map(
    rows.map((r) => [r.goal_id, {
      firstDay: r.first_day,
      lastDay: r.last_day,
      daysLast7: Number(r.days_last7),
      daysLast28: Number(r.days_last28),
      amountLast7: Number(r.amount_last7),
      prevPeriodDays: Number(r.prev_period_days),
      today: r.today,
    }])
  )
}

// Each member's age for the sub line, plus the headcount that lets a group say "everyone".
async function householdPeople(householdId: string): Promise<{ ages: Map<string, number>; headcount: number }> {
  const { rows } = await query<{ id: string; age: number | null }>(
    `select p.id,
            case when p.birthday is null then null
                 else extract(year from age((now() at time zone h.timezone)::date, p.birthday))::int end as age
       from persons p join households h on h.id = p.household_id
      where p.household_id = $1 and p.deleted_at is null`,
    [householdId]
  )
  const ages = new Map<string, number>()
  for (const r of rows) if (r.age != null) ages.set(r.id, r.age)
  return { ages, headcount: rows.length }
}

function isFocusMap(v: unknown): v is FocusMap {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  return Object.values(v as Record<string, unknown>).every((x) => x === null || typeof x === 'string')
}

// `runner` is the pool for a plain read, or the transaction's client when the map is about
// to be rewritten — reading it outside that transaction loses a concurrent answer's entry.
type Runner = Pick<PoolClient, 'query'> | null
async function readFocus(sessionId: string, runner: Runner = null): Promise<FocusMap> {
  const sql = `select data from planning_session_steps where session_id = $1 and step_key = $2`
  const { rows } = runner
    ? await runner.query<{ data: Record<string, unknown> | null }>(sql, [sessionId, STEP_KEY])
    : await query<{ data: Record<string, unknown> | null }>(sql, [sessionId, STEP_KEY])
  const focus = rows[0]?.data?.focus
  return isFocusMap(focus) ? focus : {}
}

// Merge the decision map onto the step row WITHOUT claiming the step is answered. The
// shell's `decideStep` REPLACES `data` when the primary is pressed, so the step body mirrors
// this map back through `setDecisionData`.
async function writeFocus(client: PoolClient, sessionId: string, focus: FocusMap): Promise<void> {
  await client.query(
    `insert into planning_session_steps (session_id, step_key, status, data)
     values ($1, $2, 'pending', jsonb_build_object('focus', $3::jsonb))
     on conflict (session_id, step_key)
       do update set data = jsonb_set(coalesce(planning_session_steps.data, '{}'::jsonb), '{focus}', $3::jsonb, true)`,
    [sessionId, STEP_KEY, JSON.stringify(focus)]
  )
}

// Every shared list plus the private ones this caller belongs to — the single privacy gate.
async function visibleLists(tenant: Tenant): Promise<GoalList[]> {
  const lists = await listGoalLists(tenant.householdId)
  return lists.filter((l) => !l.isPrivate || l.members.some((m) => m.personId === tenant.personId))
}

export async function getGoalsStepView(tenant: Tenant, sessionId: string | null): Promise<GoalsStepView> {
  const [lists, goals, focus, activity, people] = await Promise.all([
    visibleLists(tenant),
    listGoals(tenant.householdId),
    sessionId ? readFocus(sessionId) : Promise.resolve({} as FocusMap),
    recentActivity(tenant.householdId),
    householdPeople(tenant.householdId),
  ])
  return {
    groups: lists.map((l) => {
      const { id, goalCount: _goalCount, members, ...rest } = l
      const mine = goals
        .filter((g) => g.goalListId === id)
        .map((g) => ({ ...g, pace: paceFor(g, activity.get(g.id)) }))
      const settled = Object.prototype.hasOwnProperty.call(focus, id)
      const picked = focus[id] ?? null
      const pinned = mine.filter((g) => g.isFeatured)
      return {
        ...rest,
        listId: id,
        members: members.map((m) => ({ ...m, age: people.ages.get(m.personId) ?? null })),
        isEveryone: people.headcount > 1 && members.length === people.headcount,
        goals: mine,
        // ★ IS THE SESSION'S OWN ANSWER: adopting a pre-existing pin would star a tab
        // nobody had looked at yet.
        settled,
        focusGoalId: settled
          // A pick whose goal has gone isn't reported as the focus, but the group stays settled.
          ? (picked && mine.some((g) => g.id === picked) ? picked : null)
          // Not answered yet, but exactly one goal already carries the flag — that IS the
          // focus, which is what closes the "＋ New goal for this week" round trip. TWO pins
          // is ambiguous, so the session adopts neither.
          : (pinned.length === 1 ? pinned[0].id : null),
      }
    }),
  }
}

export type SetFocusResult = { ok: true; view: GoalsStepView } | { ok: false }

// Answer one group; `goalId` null is the real answer "nothing this week".
//
// ONE FOCUS PER LIST, WITHOUT TRAMPLING PINS: `is_featured` is also the goals screen's
// not-one-per-list "Pinned" tier, so this un-features exactly ONE goal — whichever THIS
// session last set as the list's focus. `is_spotlight` is never touched.
export async function setGroupFocus(
  tenant: Tenant,
  sessionId: string,
  listId: string,
  goalId: string | null
): Promise<SetFocusResult> {
  const session = await getSessionById(tenant.householdId, sessionId)
  if (!session) return { ok: false }

  // Privacy AND ownership in one check: a list this caller can't see is one they can't
  // answer for.
  const lists = await visibleLists(tenant)
  if (!lists.some((l) => l.id === listId)) return { ok: false }

  if (goalId) {
    const { rowCount } = await query(
      `select 1 from goals
        where household_id = $1 and id = $2 and goal_list_id = $3 and deleted_at is null and is_active`,
      [tenant.householdId, goalId, listId]
    )
    // Validated BEFORE anything is cleared, so another list's goal can't cost this one its focus.
    if (!rowCount) return { ok: false }
  }

  const client = await getPool().connect()
  try {
    await client.query('begin')
    // Read the map first — the previous focus is the ONLY pin this write may drop.
    const focus = await readFocus(sessionId, client)
    const previous = focus[listId] ?? null
    if (previous && previous !== goalId) {
      await client.query(
        `update goals set is_featured = false
          where household_id = $1 and id = $2 and goal_list_id = $3 and deleted_at is null`,
        [tenant.householdId, previous, listId]
      )
    }
    if (goalId) {
      await client.query(
        `update goals set is_featured = true where household_id = $1 and id = $2 and goal_list_id = $3`,
        [tenant.householdId, goalId, listId]
      )
    }
    focus[listId] = goalId
    await writeFocus(client, sessionId, focus)
    await client.query('commit')
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
  return { ok: true, view: await getGoalsStepView(tenant, sessionId) }
}
