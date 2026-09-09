// Goals domain: goal lists (the SHARED LISTS / INDIVIDUAL membership sidebar), goals
// (count/total/habit/checklist; shared_total vs each_tracks), append-only logs (SUM =
// progress), milestones, and a detail read model.
import { randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { getPool, query } from '../../platform/db'
import { type Tenant } from '../households/households'
import type { CreateGoalListInput, UpdateGoalListInput, CreateGoalInput, UpdateGoalInput } from './goals.types'

export const GOAL_TYPES = new Set(['count', 'total', 'habit', 'checklist'])
export const TRACKING_MODES = new Set(['shared_total', 'each_tracks'])
// How a SHARED goal counts a log several people took part in (ignored for each_tracks,
// which always credits each person):
//   count_once — one shared event; +amount once, the people are attendance.
//   split      — the amount is divided evenly across the people.
// See migration 0078 + logProgress for the row-writing rules.
export const PARTICIPANT_MODES = new Set(['count_once', 'split'])
// Whether target_value is a family total or a per-person target. Only meaningful for
// each_tracks.
export const TARGET_BASES = new Set(['family', 'per_person'])
// Interpolated into date_trunc() in the progress query, so it must be a Postgres field
// name — an unconstrained value 500s the goals list.
export const HABIT_PERIODS = new Set(['day', 'week', 'month'])
// Apple Health metrics a goal can auto-fill from. Keep in sync with the iOS
// HealthKitBridge.Metric keys. Quantity metrics send a raw daily total; boolean metrics
// (rings, mood) send 1/0 and ride the habit daily-threshold path (threshold 1), so the
// server stays metric-agnostic. Fractional quantities (walk_run_distance) ride the same
// numeric columns unchanged — no counting rule cares whether the total is whole.
export const HEALTH_METRICS = new Set([
  'steps', 'flights', 'exercise_minutes', 'active_energy', 'walk_run_distance',
  'cycling_distance', 'swimming_distance', 'wheelchair_distance',
  'move_ring', 'exercise_ring', 'stand_ring', 'rings_all', 'mindful_minutes', 'mood',
  // Workout metrics bake the measure (minutes summed vs sessions counted) into the key,
  // so no workout logic is needed server-side.
  ...['running', 'cycling', 'swimming', 'yoga', 'strength', 'any'].flatMap((a) =>
    [`workout_${a}_minutes`, `workout_${a}_sessions`]),
])

/** Metrics that are met-or-not per day (rings closed / mood logged) — nothing to sum. */
const BOOLEAN_HEALTH_METRICS = new Set(['move_ring', 'exercise_ring', 'stand_ring', 'rings_all', 'mood'])

/**
 * Whether a health metric can drive a goal of this type — mirrors the iOS
 * `Metric.applies(toGoalType:)` rules the pickers enforce. Without it a raw API call can
 * store e.g. session counts on a total goal, and a later unrelated edit then silently
 * null-patches the link away.
 */
export function healthMetricFitsGoalType(metric: string, goalType: string): boolean {
  if (metric.startsWith('workout_')) {
    if (metric.endsWith('_minutes')) return goalType === 'total' || goalType === 'habit'
    if (metric.endsWith('_sessions')) return goalType === 'count' || goalType === 'habit'
  }
  if (BOOLEAN_HEALTH_METRICS.has(metric)) return goalType === 'habit' || goalType === 'count'
  return goalType === 'total' || goalType === 'count' || goalType === 'habit'
}

// ---- goal lists (membership groups) ----------------------------------------

interface GoalListRow extends QueryResultRow {
  id: string
  name: string
  emoji: string | null
  color_hex: string | null
  is_private: boolean
  sort_order: number
  members: Array<{ personId: string; name: string; avatarEmoji: string | null; colorHex: string | null }>
  goal_count: number
}

export async function listGoalLists(householdId: string) {
  const { rows } = await query<GoalListRow>(
    `select gl.id, gl.name, gl.emoji, gl.color_hex, gl.is_private, gl.sort_order,
            coalesce((
              select json_agg(json_build_object(
                       'personId', p.id, 'name', p.name,
                       'avatarEmoji', p.avatar_emoji, 'colorHex', p.color_hex)
                     order by p.sort_order, p.created_at)
                from goal_list_members m
                join persons p on p.id = m.person_id and p.deleted_at is null
               where m.goal_list_id = gl.id and m.deleted_at is null
            ), '[]'::json) as members,
            (select count(*) from goals g
              where g.goal_list_id = gl.id and g.deleted_at is null and g.is_active) as goal_count
       from goal_lists gl
      where gl.household_id = $1 and gl.deleted_at is null
      order by gl.sort_order, gl.created_at`,
    [householdId]
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    emoji: r.emoji,
    colorHex: r.color_hex,
    isPrivate: r.is_private,
    sortOrder: r.sort_order,
    members: r.members,
    goalCount: Number(r.goal_count),
  }))
}

export async function createGoalList(tenant: Tenant, input: CreateGoalListInput): Promise<{ id: string }> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const r = await client.query<{ id: string }>(
      `insert into goal_lists (household_id, name, emoji, color_hex, is_private)
       values ($1,$2,$3,$4,$5) returning id`,
      [tenant.householdId, input.name, input.emoji ?? null, input.colorHex ?? null, input.isPrivate ?? false]
    )
    const listId = r.rows[0].id
    for (const pid of [...new Set(input.memberIds ?? [])]) {
      await client.query(
        `insert into goal_list_members (household_id, goal_list_id, person_id) values ($1,$2,$3)`,
        [tenant.householdId, listId, pid]
      )
    }
    await client.query('commit')
    return { id: listId }
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// Edit a goal list; `memberIds` replaces the membership wholesale. Existing goals keep
// their snapshotted participants.
export async function updateGoalList(
  tenant: Tenant,
  id: string,
  input: UpdateGoalListInput
): Promise<boolean> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const sets: string[] = []
    const vals: unknown[] = []
    let n = 1
    const push = (col: string, v: unknown) => { sets.push(`${col} = $${n++}`); vals.push(v) }
    if (input.name !== undefined) push('name', input.name)
    if (input.emoji !== undefined) push('emoji', input.emoji ?? null)
    if (input.colorHex !== undefined) push('color_hex', input.colorHex ?? null)
    if (input.isPrivate !== undefined) push('is_private', input.isPrivate)

    let found = true
    if (sets.length) {
      const r = await client.query(
        `update goal_lists set ${sets.join(', ')} where id = $${n++} and household_id = $${n++} and deleted_at is null`,
        [...vals, id, tenant.householdId]
      )
      found = (r.rowCount ?? 0) > 0
    } else {
      const r = await client.query(
        `select 1 from goal_lists where id = $1 and household_id = $2 and deleted_at is null`,
        [id, tenant.householdId]
      )
      found = (r.rowCount ?? 0) > 0
    }

    if (found && input.memberIds !== undefined) {
      await client.query(`delete from goal_list_members where goal_list_id = $1 and household_id = $2`, [id, tenant.householdId])
      for (const pid of [...new Set(input.memberIds)]) {
        await client.query(
          `insert into goal_list_members (household_id, goal_list_id, person_id) values ($1,$2,$3)`,
          [tenant.householdId, id, pid]
        )
      }
    }
    await client.query('commit')
    return found
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// Deleting a goal group does NOT delete its goals — they are long-lived (history,
// progress, participants), so they are detached (goal_list_id → null) and the membership
// rows dropped, in one txn.
export async function softDeleteGoalList(householdId: string, id: string): Promise<boolean> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const r = await client.query(
      `update goal_lists set deleted_at = now() where household_id=$1 and id=$2 and deleted_at is null`,
      [householdId, id]
    )
    const found = (r.rowCount ?? 0) > 0
    if (found) {
      await client.query(`update goals set goal_list_id = null where household_id=$1 and goal_list_id=$2 and deleted_at is null`, [householdId, id])
      await client.query(`update goal_list_members set deleted_at = now() where household_id=$1 and goal_list_id=$2 and deleted_at is null`, [householdId, id])
    }
    await client.query('commit')
    return found
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// ---- goals ------------------------------------------------------------------

// A list holds exactly one spotlight. Clear any OTHER in the same list, demoting it to
// Featured. Runs in the caller's txn.
async function demoteListSpotlight(client: PoolClient, householdId: string, listId: string | null, exceptGoalId: string | null): Promise<void> {
  await client.query(
    `update goals set is_spotlight = false, is_featured = true
      where household_id = $1 and deleted_at is null and is_spotlight
        and ($2::uuid is null or id <> $2)
        and goal_list_id is not distinct from $3`,
    [householdId, exceptGoalId, listId]
  )
}

export async function createGoal(tenant: Tenant, input: CreateGoalInput): Promise<{ id: string }> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    // Demote the list's current spotlight BEFORE inserting — the partial unique index
    // forbids two live spotlights.
    if (input.isSpotlight) {
      await demoteListSpotlight(client, tenant.householdId, input.goalListId ?? null, null)
    }
    const g = await client.query<{ id: string }>(
      `insert into goals
         (household_id, goal_list_id, title, emoji, category, goal_type, unit, target_value,
          habit_period, habit_target_per_period, tracking_mode, participant_mode, target_basis, log_method, auto_from_calendar,
          health_metric, health_daily_target, deadline, is_featured, is_spotlight, has_rewards)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) returning id`,
      [
        tenant.householdId,
        input.goalListId ?? null,
        input.title,
        input.emoji ?? null,
        input.category ?? null,
        input.goalType,
        input.unit ?? null,
        input.targetValue ?? null,
        input.habitPeriod ?? null,
        input.habitTargetPerPeriod ?? null,
        input.trackingMode,
        input.participantMode ?? 'count_once',
        input.targetBasis ?? 'family',
        input.logMethod ?? 'quick_log',
        input.autoFromCalendar ?? false,
        input.healthMetric ?? null,
        input.healthDailyTarget ?? null,
        input.deadline || null, // '' (cleared) → null so it isn't written to a date column

        input.isFeatured ?? false,
        input.isSpotlight ?? false,
        input.hasRewards ?? false,
      ]
    )
    const goalId = g.rows[0].id
    for (const pid of [...new Set(input.participantIds ?? [])]) {
      await client.query(
        `insert into goal_participants (household_id, goal_id, person_id) values ($1,$2,$3)`,
        [tenant.householdId, goalId, pid]
      )
    }
    let order = 0
    for (const m of input.milestones ?? []) {
      await client.query(
        `insert into goal_milestones (household_id, goal_id, threshold, emoji, label, reward_text, sort_order)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [tenant.householdId, goalId, m.threshold, m.emoji ?? null, m.label ?? null, m.rewardText ?? null, order++]
      )
    }
    let stepOrder = 0
    for (const s of input.steps ?? []) {
      if (!s.label?.trim()) continue
      await client.query(
        `insert into goal_steps (household_id, goal_id, label, sort_order) values ($1,$2,$3,$4)`,
        [tenant.householdId, goalId, s.label.trim(), stepOrder++]
      )
    }
    await client.query('commit')
    return { id: goalId }
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// Per-goal participant rollup (shared by list + detail reads).
const PARTICIPANTS_SUBQUERY = `coalesce((
  select json_agg(json_build_object(
           'personId', pa.person_id, 'name', p.name,
           'colorHex', p.color_hex, 'avatarEmoji', p.avatar_emoji,
           'target', coalesce(pa.target_override, g.target_value)::float,
           'progress', coalesce((select sum(amount)::float from goal_logs gl2
                                  where gl2.goal_id = g.id and gl2.person_id = pa.person_id
                                    and gl2.deleted_at is null), 0))
         order by coalesce((select sum(amount) from goal_logs gl3
                            where gl3.goal_id = g.id and gl3.person_id = pa.person_id
                              and gl3.deleted_at is null), 0) desc, p.sort_order)
    from goal_participants pa
    join persons p on p.id = pa.person_id and p.deleted_at is null
   where pa.goal_id = g.id and pa.deleted_at is null
), '[]'::json)`

// The first day of the goal's CURRENT habit period, as a household-local DATE.
//
// A week follows the HOUSEHOLD's `week_start` — the same rule as `snapToWeekStart` and
// iOS `Cal.weekStart` — not Postgres's `date_trunc('week')`, which is always Monday. The
// default household is a *sunday* one, so Monday truncation puts Sunday's completion in
// the week that was ending. `extract(dow)` is 0=Sunday..6=Saturday; subtracting the
// household's start day (mod 7, kept positive) walks back to it. Day and month fall
// through to date_trunc.
//
// EXPORTED, and parameterised on the households alias, so the Weekly Planning goals step
// measures "last week" on this exact clock instead of spelling the rule again (its query
// calls the households row `l`). A second spelling is how Monday truncation creeps back.
export const periodStartSQL = (hh = 'h') => `case
  when g.habit_period = 'week' then
    (now() at time zone ${hh}.timezone)::date
      - ((extract(dow from (now() at time zone ${hh}.timezone))::int
          - case when ${hh}.week_start = 'monday' then 1 else 0 end + 7) % 7)
  else date_trunc(g.habit_period, (now() at time zone ${hh}.timezone))::date
end`

const PERIOD_START_SQL = periodStartSQL('h')

// Habits count consistency: distinct days logged in the CURRENT period. 0 for non-habits,
// which show the cumulative total.
const PERIOD_DONE_SUBQUERY = `case when g.goal_type = 'habit' then (
  select count(distinct (gl.logged_at at time zone h.timezone)::date)
    from goal_logs gl, households h
   where h.id = g.household_id and gl.goal_id = g.id and gl.deleted_at is null
     and (gl.logged_at at time zone h.timezone)::date >= (${PERIOD_START_SQL})
) else 0 end`

// Who logged this TODAY (household tz), '__family__' for a no-person log. Stops a habit
// being marked done twice a day per person.
const LOGGED_TODAY_SUBQUERY = `coalesce((
  select json_agg(distinct coalesce(gl.person_id::text, '__family__'))
    from goal_logs gl, households h
   where h.id = g.household_id and gl.goal_id = g.id and gl.deleted_at is null
     and (gl.logged_at at time zone h.timezone)::date = (now() at time zone h.timezone)::date
), '[]'::json)`

// Checklist progress comes from steps (done / total), not summed logs.
const STEP_TOTAL_SUBQUERY = `(select count(*) from goal_steps gs where gs.goal_id = g.id and gs.deleted_at is null)`
const STEP_DONE_SUBQUERY = `(select count(*) from goal_steps gs where gs.goal_id = g.id and gs.deleted_at is null and gs.done_at is not null)`

interface GoalRow extends QueryResultRow {
  id: string
  goal_list_id: string | null
  title: string
  emoji: string | null
  category: string | null
  goal_type: string
  unit: string | null
  target_value: string | null
  habit_period: string | null
  habit_target_per_period: number | null
  tracking_mode: string
  participant_mode: string
  target_basis: string
  log_method: string
  auto_from_calendar: boolean
  health_metric: string | null
  health_daily_target: string | null
  deadline: string | null
  is_featured: boolean
  is_spotlight: boolean
  has_rewards: boolean
  created_at: string
  total_progress: number
  milestone_total: number
  milestone_reached: number
  period_done: number
  step_total: number
  step_done: number
  logged_today_by: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  participants: any[]
}

function mapGoal(g: GoalRow) {
  return {
    id: g.id,
    goalListId: g.goal_list_id,
    title: g.title,
    emoji: g.emoji,
    category: g.category,
    goalType: g.goal_type,
    unit: g.unit,
    habitPeriod: g.habit_period,
    habitTargetPerPeriod: g.habit_target_per_period,
    trackingMode: g.tracking_mode,
    participantMode: g.participant_mode,
    targetBasis: g.target_basis,
    logMethod: g.log_method,
    autoFromCalendar: g.auto_from_calendar,
    healthMetric: g.health_metric,
    healthDailyTarget: g.health_daily_target == null ? null : Number(g.health_daily_target),
    deadline: g.deadline,
    isFeatured: g.is_featured,
    isSpotlight: g.is_spotlight,
    hasRewards: g.has_rewards,
    createdAt: g.created_at,
    target: g.target_value == null ? null : Number(g.target_value),
    totalProgress: Number(g.total_progress),
    milestoneTotal: Number(g.milestone_total),
    milestoneReached: Number(g.milestone_reached),
    periodDone: Number(g.period_done),
    stepTotal: Number(g.step_total),
    stepDone: Number(g.step_done),
    loggedTodayBy: g.logged_today_by ?? [],
    participants: g.participants,
  }
}

// Batched consecutive-day streaks for many goals (one query + JS rollup).
async function streaksFor(householdId: string, goalIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (goalIds.length === 0) return out
  const { rows: t } = await query<{ today: string }>(
    `select (now() at time zone timezone)::date::text as today from households where id = $1`,
    [householdId]
  )
  const today = new Date(t[0].today + 'T00:00:00Z').getTime()
  const DAY = 86400000
  const { rows } = await query<{ goal_id: string; day: string }>(
    `select gl.goal_id, (gl.logged_at at time zone h.timezone)::date::text as day
       from goal_logs gl join households h on h.id = gl.household_id
      where gl.household_id = $1 and gl.goal_id = any($2) and gl.deleted_at is null
      group by gl.goal_id, day`,
    [householdId, goalIds]
  )
  const byGoal = new Map<string, number[]>()
  for (const r of rows) {
    const ts = new Date(r.day + 'T00:00:00Z').getTime()
    ;(byGoal.get(r.goal_id) ?? byGoal.set(r.goal_id, []).get(r.goal_id)!).push(ts)
  }
  for (const [goalId, daysRaw] of byGoal) {
    const days = daysRaw.sort((a, b) => b - a)
    let cursor = days[0]
    if (today - cursor > DAY) {
      out.set(goalId, 0)
      continue
    }
    let streak = 0
    for (const ts of days) {
      if (ts === cursor) {
        streak++
        cursor -= DAY
      } else if (ts < cursor) {
        break
      }
    }
    out.set(goalId, streak)
  }
  return out
}

export async function listGoals(householdId: string, listId?: string | null) {
  const { rows } = await query<GoalRow>(
    `select g.id, g.goal_list_id, g.title, g.emoji, g.category, g.goal_type, g.unit, g.target_value,
            g.habit_period, g.habit_target_per_period, g.tracking_mode, g.participant_mode, g.target_basis, g.log_method, g.auto_from_calendar, g.health_metric, g.health_daily_target, g.deadline::text as deadline,
            g.is_featured, g.is_spotlight, g.has_rewards, g.created_at,
            coalesce((select sum(amount)::float from goal_logs gl
                       where gl.goal_id = g.id and gl.deleted_at is null and gl.counts_total), 0) as total_progress,
            (select count(*) from goal_milestones gm
              where gm.goal_id = g.id and gm.deleted_at is null) as milestone_total,
            (select count(*) from goal_milestones gm
              where gm.goal_id = g.id and gm.deleted_at is null
                and gm.threshold <= coalesce((select sum(amount) from goal_logs gl
                       where gl.goal_id = g.id and gl.deleted_at is null and gl.counts_total), 0)) as milestone_reached,
            ${PERIOD_DONE_SUBQUERY} as period_done,
            ${STEP_TOTAL_SUBQUERY} as step_total,
            ${STEP_DONE_SUBQUERY} as step_done,
            ${LOGGED_TODAY_SUBQUERY} as logged_today_by,
            ${PARTICIPANTS_SUBQUERY} as participants
       from goals g
      where g.household_id = $1 and g.deleted_at is null and g.is_active
        and ($2::uuid is null or g.goal_list_id = $2)
      order by lower(g.title), g.created_at`,
    [householdId, listId ?? null]
  )
  const goals = rows.map(mapGoal)
  const streaks = await streaksFor(householdId, goals.map((g) => g.id))
  return goals.map((g) => ({ ...g, streakDays: streaks.get(g.id) ?? 0 }))
}

// Consecutive-day streak ending today/yesterday (household timezone).
async function goalStreak(householdId: string, goalId: string): Promise<number> {
  const { rows } = await query<{ day: string }>(
    `select distinct (gl.logged_at at time zone h.timezone)::date::text as day
       from goal_logs gl
       join households h on h.id = gl.household_id
      where gl.goal_id = $1 and gl.household_id = $2 and gl.deleted_at is null
      order by day desc`,
    [goalId, householdId]
  )
  if (rows.length === 0) return 0
  const days = rows.map((r) => r.day)
  const { rows: t } = await query<{ today: string }>(
    `select (now() at time zone timezone)::date::text as today from households where id = $1`,
    [householdId]
  )
  const today = new Date(t[0].today + 'T00:00:00Z').getTime()
  const DAY = 86400000
  // streak only counts if the latest log is today or yesterday
  let cursor = new Date(days[0] + 'T00:00:00Z').getTime()
  if (today - cursor > DAY) return 0
  let streak = 0
  for (const d of days) {
    const ts = new Date(d + 'T00:00:00Z').getTime()
    if (ts === cursor) {
      streak++
      cursor -= DAY
    } else if (ts < cursor) {
      break
    }
  }
  return streak
}

export async function goalExists(householdId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `select 1 from goals where household_id=$1 and id=$2 and deleted_at is null`,
    [householdId, id]
  )
  return !!rowCount
}

// The goal's type, or null if it doesn't exist — lets /log 404 an unknown goal and reject
// a numeric log against a checklist.
export async function goalTypeFor(householdId: string, id: string): Promise<string | null> {
  const { rows } = await query<{ goal_type: string }>(
    `select goal_type from goals where household_id=$1 and id=$2 and deleted_at is null`,
    [householdId, id]
  )
  return rows[0]?.goal_type ?? null
}

// Type + unit in one hit: /log needs both to decide whether an hours+minutes entry is
// allowed.
export async function goalMetaFor(
  householdId: string,
  id: string
): Promise<{ goalType: string; unit: string | null } | null> {
  const { rows } = await query<{ goal_type: string; unit: string | null }>(
    `select goal_type, unit from goals where household_id=$1 and id=$2 and deleted_at is null`,
    [householdId, id]
  )
  const r = rows[0]
  return r ? { goalType: r.goal_type, unit: r.unit } : null
}

// "Time-measured" purely by the free-text unit. Keep in sync with HOURS in web
// LogModal.tsx and hourUnits in iOS GoalsView.swift.
const TIME_UNITS = new Set(['hour', 'hours', 'hr', 'hrs'])
export function isTimeUnit(unit: string | null | undefined): boolean {
  return unit != null && TIME_UNITS.has(unit.trim().toLowerCase())
}

// The ONE body→log-amount mapping/validation, shared by POST /api/goals/:id/log and the
// capture commit applier so the two can never diverge. Returns the folded amount, or the
// 400 message.
export function goalLogAmount(
  meta: { goalType: string; unit: string | null },
  body: { amount?: unknown; hours?: unknown; minutes?: unknown }
): { amount: number } | { error: string } {
  // A checklist has no numeric progress — it's driven by ticking steps.
  if (meta.goalType === 'checklist') {
    return { error: 'checklist goals are updated by ticking steps, not logging progress' }
  }
  // Time goals may be logged as hours + minutes; the server folds them so no client has
  // to. Either field may stand alone.
  const usesHm = body.hours != null || body.minutes != null
  if (usesHm) {
    if (body.amount != null) {
      return { error: 'send either amount or hours/minutes, not both' }
    }
    if (meta.goalType !== 'total' || !isTimeUnit(meta.unit)) {
      return { error: 'hours and minutes only apply to a time goal (measured in hours)' }
    }
    const hours = body.hours == null ? 0 : Number(body.hours)
    const minutes = body.minutes == null ? 0 : Number(body.minutes)
    // Whole hours + a 0–59 remainder, reasserted so a non-UI caller can't fold { minutes:
    // 200 } into 3.33h.
    if (!Number.isInteger(hours) || hours < 0 || !Number.isInteger(minutes) || minutes < 0 || minutes > 59) {
      return { error: 'hours must be a whole number ≥ 0 and minutes 0–59' }
    }
    const amount = hours + minutes / 60
    if (amount === 0) {
      return { error: 'log some time — hours and minutes cannot both be zero' }
    }
    return { amount }
  }
  const amount = Number(body.amount)
  if (!Number.isFinite(amount) || amount === 0) {
    return { error: 'amount must be a non-zero number' }
  }
  // A count goal tallies whole things (parks, books) — no fractional amounts.
  if (meta.goalType === 'count' && !Number.isInteger(amount)) {
    return { error: 'a count goal is logged in whole numbers' }
  }
  return { amount }
}

// True only if every id is a live person in this household — so a /log can't credit a
// stranger.
export async function personsInHousehold(householdId: string, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true
  const unique = [...new Set(ids)]
  const { rows } = await query<{ n: string }>(
    `select count(*)::int as n from persons where household_id=$1 and id = any($2::uuid[]) and deleted_at is null`,
    [householdId, unique]
  )
  return Number(rows[0]?.n ?? 0) === unique.length
}

// Powers the goal.manage carve-out: a goal whose sole participant is the caller is "their
// own".
export async function goalParticipantIds(householdId: string, goalId: string): Promise<string[]> {
  const { rows } = await query<{ person_id: string }>(
    `select pa.person_id
       from goal_participants pa
       join goals g on g.id = pa.goal_id and g.household_id = $1 and g.deleted_at is null
      where pa.goal_id = $2 and pa.deleted_at is null`,
    [householdId, goalId]
  )
  return rows.map((r) => r.person_id)
}

export async function goalDetail(householdId: string, id: string) {
  const { rows } = await query<GoalRow>(
    `select g.id, g.goal_list_id, g.title, g.emoji, g.category, g.goal_type, g.unit, g.target_value,
            g.habit_period, g.habit_target_per_period, g.tracking_mode, g.participant_mode, g.target_basis, g.log_method, g.auto_from_calendar, g.health_metric, g.health_daily_target, g.deadline::text as deadline,
            g.is_featured, g.is_spotlight, g.has_rewards, g.created_at,
            coalesce((select sum(amount)::float from goal_logs gl
                       where gl.goal_id = g.id and gl.deleted_at is null and gl.counts_total), 0) as total_progress,
            (select count(*) from goal_milestones gm
              where gm.goal_id = g.id and gm.deleted_at is null) as milestone_total,
            (select count(*) from goal_milestones gm
              where gm.goal_id = g.id and gm.deleted_at is null
                and gm.threshold <= coalesce((select sum(amount) from goal_logs gl
                       where gl.goal_id = g.id and gl.deleted_at is null and gl.counts_total), 0)) as milestone_reached,
            ${PERIOD_DONE_SUBQUERY} as period_done,
            ${STEP_TOTAL_SUBQUERY} as step_total,
            ${STEP_DONE_SUBQUERY} as step_done,
            ${LOGGED_TODAY_SUBQUERY} as logged_today_by,
            ${PARTICIPANTS_SUBQUERY} as participants
       from goals g
      where g.household_id = $1 and g.id = $2 and g.deleted_at is null`,
    [householdId, id]
  )
  if (rows.length === 0) return null
  const base = mapGoal(rows[0])
  const streakDays = await goalStreak(householdId, id)

  // A milestone's threshold reads against the goal's natural axis: streak days,
  // percent-complete, or cumulative total.
  const stepPct = base.stepTotal ? (base.stepDone / base.stepTotal) * 100 : 0
  const milestoneAxis = base.goalType === 'habit' ? streakDays : base.goalType === 'checklist' ? stepPct : base.totalProgress

  const milestones = (
    await query<{ id: string; threshold: string; emoji: string | null; label: string | null; reward_text: string | null }>(
      `select id, threshold, emoji, label, reward_text from goal_milestones
        where goal_id=$1 and deleted_at is null order by sort_order, threshold`,
      [id]
    )
  ).rows.map((m) => ({
    id: m.id,
    threshold: Number(m.threshold),
    emoji: m.emoji,
    label: m.label,
    rewardText: m.reward_text,
    reached: Number(m.threshold) <= milestoneAxis,
  }))

  const steps = (
    await query<{ id: string; label: string; done_at: string | null; done_by: string | null }>(
      `select id, label, done_at as "done_at", done_by as "done_by" from goal_steps
        where goal_id=$1 and deleted_at is null order by sort_order, created_at`,
      [id]
    )
  ).rows.map((s) => ({ id: s.id, label: s.label, done: s.done_at != null, doneBy: s.done_by }))

  // Audit log. Rows split from one entered amount share a batch_id and collapse into a
  // single entry (summed amount, earliest timestamp, avatars). Grouping — not the raw
  // rows — is capped at 12.
  const recent = (
    await query<{ id: string; source: string; amount: string; loggedAt: string; dateKey: string; note: string | null; participants: Array<{ personId: string | null; name: string | null; avatarEmoji: string | null; colorHex: string | null }> }>(
      `select coalesce(gl.batch_id, gl.id)::text as id,
              min(gl.source) as source,
              coalesce(sum(gl.amount) filter (where gl.counts_total), 0) as amount,
              min(gl.logged_at) as "loggedAt",
              -- Household-timezone day, matching goalActivity's bucketing exactly —
              -- so the day drill-down's entry list agrees with the day cell's total
              -- regardless of which timezone the VIEWING device happens to be in.
              (min(gl.logged_at) at time zone h.timezone)::date::text as "dateKey",
              gl.note,
              coalesce(
                json_agg(json_build_object(
                  'personId', gl.person_id, 'name', p.name,
                  'avatarEmoji', p.avatar_emoji, 'colorHex', p.color_hex
                ) order by p.name) filter (where gl.person_id is not null),
                '[]'::json
              ) as participants
         from goal_logs gl
         join households h on h.id = gl.household_id
         left join persons p on p.id = gl.person_id
        where gl.goal_id=$1 and gl.household_id=$2 and gl.deleted_at is null
        group by coalesce(gl.batch_id, gl.id), gl.note, h.timezone
        order by min(gl.logged_at) desc limit 12`,
      [id, householdId]
    )
    // `editable` false means the entry is owned by its source (checklist tick, calendar
    // confirm, Health sync): note-only edits.
  ).rows.map(({ source, ...r }) => ({ ...r, amount: Number(r.amount), editable: EDITABLE_LOG_SOURCES.has(source) }))

  // The hero's "THIS WEEK": the household's own first-day-of-week AND timezone, so it
  // agrees with the habit count beside it.
  const thisWeek = Number(
    (
      await query<{ sum: string }>(
        `select coalesce(sum(gl.amount),0) as sum
           from goal_logs gl join households h on h.id = gl.household_id
          where gl.goal_id=$1 and gl.household_id=$2 and gl.deleted_at is null and gl.counts_total
            and (gl.logged_at at time zone h.timezone)::date >=
                (now() at time zone h.timezone)::date
                  - ((extract(dow from (now() at time zone h.timezone))::int
                      - case when h.week_start = 'monday' then 1 else 0 end + 7) % 7)`,
        [id, householdId]
      )
    ).rows[0].sum
  )

  return { ...base, milestones, steps, recent, thisWeek, streakDays }
}

export interface GoalActivityDay {
  dateKey: string // YYYY-MM-DD, household-local
  total: number
  perMember: Record<string, number>
}

// Day-bucketed log history for the goal-detail data views. Buckets by the SAME
// household-timezone day expression as goalStreak/streaksFor. `total` sums only
// counts_total rows (matching the ring); `perMember` sums EVERY row for that person,
// including amount-0 attendance rows from a count_once event, so a "who was there"
// indicator can key on presence rather than amount>0. Sparse — the caller fills gaps.
export async function goalActivity(
  householdId: string,
  goalId: string
): Promise<{ startDate: string; endDate: string | null; today: string; days: GoalActivityDay[] } | null> {
  const { rows: g } = await query<{ created_at: string; deadline: string | null }>(
    `select (g.created_at at time zone h.timezone)::date::text as created_at, g.deadline::text as deadline
       from goals g join households h on h.id = g.household_id
      where g.household_id = $1 and g.id = $2 and g.deleted_at is null`,
    [householdId, goalId]
  )
  if (g.length === 0) return null

  const { rows: t } = await query<{ today: string }>(
    `select (now() at time zone timezone)::date::text as today from households where id = $1`,
    [householdId]
  )

  const { rows } = await query<{ day: string; person_id: string | null; counts_total: boolean; amount: string }>(
    `select (gl.logged_at at time zone h.timezone)::date::text as day,
            gl.person_id, gl.counts_total, sum(gl.amount)::float as amount
       from goal_logs gl join households h on h.id = gl.household_id
      where gl.goal_id = $1 and gl.household_id = $2 and gl.deleted_at is null
      group by day, gl.person_id, gl.counts_total
      order by day`,
    [goalId, householdId]
  )

  const dayTotals = new Map<string, number>()
  const dayPerMember = new Map<string, Map<string, number>>()
  for (const r of rows) {
    const amount = Number(r.amount)
    if (r.counts_total) dayTotals.set(r.day, round2((dayTotals.get(r.day) ?? 0) + amount))
    if (r.person_id != null) {
      const perMember = dayPerMember.get(r.day) ?? new Map<string, number>()
      perMember.set(r.person_id, round2((perMember.get(r.person_id) ?? 0) + amount))
      dayPerMember.set(r.day, perMember)
    }
  }
  const dateKeys = [...new Set([...dayTotals.keys(), ...dayPerMember.keys()])].sort()
  const days: GoalActivityDay[] = dateKeys.map((dateKey) => ({
    dateKey,
    total: dayTotals.get(dateKey) ?? 0,
    perMember: Object.fromEntries(dayPerMember.get(dateKey) ?? []),
  }))

  return { startDate: g[0].created_at, endDate: g[0].deadline, today: t[0].today, days }
}

// Slightly more than the default chip count, so the client still has fresh options after
// de-duping.
const NOTE_SUGGESTION_LIMIT = 8

// Notes this household has actually logged against THIS goal, most-used first (ties by
// most-recent), case/whitespace variants collapsed. With `personId` we scope to notes
// where that person was the CREDITED participant (goal_logs.person_id) rather than the
// recorder, so each member's box learns their own history. null when the goal doesn't
// exist.
export async function goalNoteSuggestions(
  householdId: string,
  goalId: string,
  personId?: string | null
): Promise<string[] | null> {
  if (!(await goalExists(householdId, goalId))) return null
  const { rows } = await query<{ note: string }>(
    `select (array_agg(btrim(note) order by logged_at desc))[1] as note
       from goal_logs
      where household_id = $1 and goal_id = $2 and deleted_at is null
        and note is not null and btrim(note) <> ''
        and ($3::uuid is null or person_id = $3::uuid)
      group by lower(btrim(note))
      order by count(*) desc, max(logged_at) desc, lower(btrim(note)) asc
      limit $4`,
    [householdId, goalId, personId ?? null, NOTE_SUGGESTION_LIMIT]
  )
  return rows.map((r) => r.note)
}

// Tick/untick a checklist step. `done_at` is the source of truth AND is mirrored into
// goal_logs (source 'checklist_item') so the activity feed and streaks treat it like any
// other completion.
export async function toggleGoalStep(
  tenant: Tenant,
  goalId: string,
  stepId: string,
  done: boolean
): Promise<boolean> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const upd = await client.query(
      `update goal_steps set done_at = ${done ? 'now()' : 'null'}, done_by = $1
        where id = $2 and goal_id = $3 and household_id = $4 and deleted_at is null`,
      [done ? tenant.personId : null, stepId, goalId, tenant.householdId]
    )
    const found = (upd.rowCount ?? 0) > 0
    if (found) {
      if (done) {
        await client.query(
          `insert into goal_logs (household_id, goal_id, person_id, amount, source, ref_type, ref_id, created_by)
           values ($1,$2,$3,1,'checklist_item','goal_step',$4,$5)`,
          [tenant.householdId, goalId, tenant.personId, stepId, tenant.personId]
        )
      } else {
        await client.query(
          `update goal_logs set deleted_at = now()
            where goal_id = $1 and ref_type = 'goal_step' and ref_id = $2 and deleted_at is null`,
          [goalId, stepId]
        )
      }
    }
    await client.query('commit')
    return found
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100

interface PlanRow { personId: string | null; amount: number; countsTotal: boolean }

// Decide which goal_logs rows a single log action writes. `amount` is always what the
// GOAL gains — the people you tap are who took part, never a multiplier. The FAMILY total
// sums only `countsTotal` rows; the per-person leaderboard sums every row. That split is
// what lets several people share one event without inflating the family number.
//   • habit        → each completion is exactly 1 (one row per person, all count).
//   • each_tracks  → everyone independently did `amount`; all rows count.
//   • shared_total → split divides `amount` evenly; count_once writes one family row plus
//                    an amount-0 ATTENDANCE row per person.
export function planLogRows(
  participantMode: string,
  trackingMode: string,
  goalType: string,
  amount: number,
  targets: Array<string | null>
): { rows: PlanRow[]; batchId: string | null } {
  const realPeople = targets.filter((t): t is string => t != null)
  if (goalType === 'habit') {
    return { rows: targets.map((t) => ({ personId: t, amount: 1, countsTotal: true })), batchId: null }
  }
  if (trackingMode === 'each_tracks') {
    return { rows: targets.map((t) => ({ personId: t, amount, countsTotal: true })), batchId: null }
  }
  if (participantMode === 'split' && targets.length > 1) {
    const n = targets.length
    const share = round2(amount / n)
    return {
      rows: targets.map((t, i) => ({ personId: t, amount: i === n - 1 ? round2(amount - share * (n - 1)) : share, countsTotal: true })),
      batchId: randomUUID(),
    }
  }
  // The attendance/multiplier distinction only bites with 2+ people: one plain row that
  // counts otherwise.
  if (participantMode === 'count_once' && realPeople.length > 1) {
    return {
      rows: [{ personId: null, amount, countsTotal: true }, ...realPeople.map((p) => ({ personId: p, amount: 0, countsTotal: false }))],
      batchId: randomUUID(),
    }
  }
  // split with a single target, a single-person shared log, or a family-only log: one row
  // that counts.
  return { rows: targets.map((t) => ({ personId: t, amount, countsTotal: true })), batchId: null }
}

/**
 * SQL for a backdated `logged_at`: noon on the given day, in the household's own
 * timezone. Noon rather than midnight because every read buckets the day back out with
 * `(logged_at at time zone h.timezone)::date`, and anchoring at an edge lets a row drift
 * a day under a DST shift. `dateParam`/`householdParam` are the placeholder numbers
 * holding the YYYY-MM-DD date and the household id.
 */
export function localNoonSql(dateParam: number, householdParam = 1): string {
  return `($${dateParam}::date + time '12:00') at time zone (select timezone from households where id = $${householdParam})`
}

// Resolve the counting rules, plan the rows via planLogRows, then insert (batched
// siblings share a batch_id).
export async function logProgress(
  tenant: Tenant,
  goalId: string,
  amount: number,
  personIds: Array<string | null>,
  note?: string | null,
  opts?: { source?: string; refType?: string | null; refId?: string | null; at?: string | null }
): Promise<string[]> {
  const source = opts?.source ?? 'quick_log'
  const refType = opts?.refType ?? null
  const refId = opts?.refId ?? null
  // Optional backdate (household-local). Lands at noon on that local day so it falls on
  // the intended date in every timezone.
  const at = opts?.at ?? null
  const targets = personIds.length ? personIds : [null]
  const logIds: string[] = []

  const { rows: goalRows } = await query<{ tracking_mode: string; goal_type: string; participant_mode: string }>(
    `select tracking_mode, goal_type, participant_mode from goals where id = $1 and household_id = $2`,
    [goalId, tenant.householdId]
  )
  const trackingMode = goalRows[0]?.tracking_mode
  const goalType = goalRows[0]?.goal_type
  const participantMode = goalRows[0]?.participant_mode
  const isHabit = goalType === 'habit'

  const { rows: plan, batchId } = planLogRows(participantMode, trackingMode, goalType, amount, targets)

  for (const row of plan) {
    // A habit is once per day per person; a same-day duplicate is skipped silently.
    if (isHabit) {
      // Dedupe against the day we're logging FOR, so catching up yesterday doesn't
      // collide with today.
      const dayExpr = at ? '$4::date' : '(now() at time zone h.timezone)::date'
      const dup = await query(
        `select 1 from goal_logs gl, households h
          where h.id = $1 and gl.household_id = $1 and gl.goal_id = $2 and gl.deleted_at is null
            and gl.person_id is not distinct from $3
            and (gl.logged_at at time zone h.timezone)::date = ${dayExpr}
          limit 1`,
        at ? [tenant.householdId, goalId, row.personId, at] : [tenant.householdId, goalId, row.personId]
      )
      if (dup.rowCount) continue
    }
    const ins = await query<{ id: string }>(
      `insert into goal_logs (household_id, goal_id, person_id, amount, note, source, ref_type, ref_id, created_by, batch_id, counts_total${at ? ', logged_at' : ''})
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11${at ? `, ${localNoonSql(12)}` : ''}) returning id`,
      at
        ? [tenant.householdId, goalId, row.personId, row.amount, note ?? null, source, refType, refId, tenant.personId, batchId, row.countsTotal, at]
        : [tenant.householdId, goalId, row.personId, row.amount, note ?? null, source, refType, refId, tenant.personId, batchId, row.countsTotal]
    )
    logIds.push(ins.rows[0].id)
  }
  return logIds
}

/**
 * Idempotent per-day Apple Health sync (Tier 1). Keeps at most ONE goal_logs row per
 * (goal, person, metric, day) — tracked in health_goal_logs — so re-syncing never
 * double-counts against the append-only SUM. `value` is the day's HealthKit total.
 *
 * The amount depends on goal_type:
 *   • total / count → the raw day total, ACCUMULATING toward target_value; a re-sync
 *     replaces the day's number in place.
 *   • habit         → ONE completion (amount 1) when the day clears health_daily_target;
 *     below it the day doesn't count, and a previously-counted day is undone.
 */
export async function syncHealthProgress(
  tenant: Tenant,
  goalId: string,
  metric: string,
  day: string,
  value: number
): Promise<{ goalLogId: string | null }> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const meta = await client.query<{ goal_type: string; health_daily_target: string | null }>(
      `select goal_type, health_daily_target from goals where id=$1 and household_id=$2 and deleted_at is null`,
      [goalId, tenant.householdId]
    )
    const isHabit = meta.rows[0]?.goal_type === 'habit'
    const threshold = meta.rows[0]?.health_daily_target == null ? null : Number(meta.rows[0].health_daily_target)
    // Habits only count a day clearing the daily threshold; everything else records the
    // running total.
    const met = !isHabit || (threshold != null && value >= threshold)
    const amount = isHabit ? 1 : value

    const existing = await client.query<{ id: string; goal_log_id: string | null }>(
      `select id, goal_log_id from health_goal_logs
        where goal_id=$1 and person_id is not distinct from $2 and metric=$3 and day=$4`,
      [goalId, tenant.personId, metric, day]
    )

    // A habit day that no longer qualifies: undo the completion and drop the mapping so a
    // later qualifying sync re-creates it.
    if (!met) {
      if (existing.rowCount) {
        if (existing.rows[0].goal_log_id) {
          await client.query(`update goal_logs set deleted_at=now() where id=$1 and household_id=$2`,
                             [existing.rows[0].goal_log_id, tenant.householdId])
        }
        await client.query(`delete from health_goal_logs where id=$1`, [existing.rows[0].id])
      }
      await client.query('commit')
      return { goalLogId: null }
    }

    let goalLogId: string
    if (existing.rowCount && existing.rows[0].goal_log_id) {
      // Replace the day's amount in place (revive it if it had been undone).
      goalLogId = existing.rows[0].goal_log_id
      await client.query(
        `update goal_logs set amount=$1, deleted_at=null where id=$2 and household_id=$3`,
        [amount, goalLogId, tenant.householdId]
      )
    } else {
      // First qualifying sync for this day → insert the progress row (noon local), then
      // record the idempotency mapping.
      const ins = await client.query<{ id: string }>(
        `insert into goal_logs (household_id, goal_id, person_id, amount, source, ref_type, ref_id, created_by, logged_at)
         values ($1,$2,$3,$4,'auto_healthkit','hk_day',null,$3, ${localNoonSql(5)})
         returning id`,
        [tenant.householdId, goalId, tenant.personId, amount, day]
      )
      goalLogId = ins.rows[0].id
      await client.query(
        `insert into health_goal_logs (household_id, goal_id, person_id, metric, day, goal_log_id)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (goal_id, person_id, metric, day)
           do update set goal_log_id=excluded.goal_log_id, updated_at=now()`,
        [tenant.householdId, goalId, tenant.personId, metric, day, goalLogId]
      )
    }
    await client.query('commit')
    return { goalLogId }
  } catch (e) {
    await client.query('rollback')
    throw e
  } finally {
    client.release()
  }
}

const GOAL_COLUMNS: Record<string, string> = {
  title: 'title',
  emoji: 'emoji',
  category: 'category',
  goalType: 'goal_type',
  unit: 'unit',
  targetValue: 'target_value',
  habitPeriod: 'habit_period',
  habitTargetPerPeriod: 'habit_target_per_period',
  trackingMode: 'tracking_mode',
  participantMode: 'participant_mode',
  targetBasis: 'target_basis',
  logMethod: 'log_method',
  autoFromCalendar: 'auto_from_calendar',
  healthMetric: 'health_metric',
  healthDailyTarget: 'health_daily_target',
  deadline: 'deadline',
  isFeatured: 'is_featured',
  isSpotlight: 'is_spotlight',
  hasRewards: 'has_rewards',
  goalListId: 'goal_list_id',
}

export async function updateGoal(tenant: Tenant, id: string, patch: UpdateGoalInput): Promise<boolean> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    // Promoting to spotlight demotes the target list's hero FIRST, before this goal's
    // flag flips (the partial unique index forbids two per list). Target = the patched
    // goalListId if present, else the current one.
    if (patch.isSpotlight === true) {
      const targetList = 'goalListId' in patch
        ? ((patch.goalListId as string | null) ?? null)
        : (await client.query<{ goal_list_id: string | null }>(
            `select goal_list_id from goals where household_id=$1 and id=$2 and deleted_at is null`,
            [tenant.householdId, id]
          )).rows[0]?.goal_list_id ?? null
      await demoteListSpotlight(client, tenant.householdId, targetList, id)
    }
    // Re-linking to a DIFFERENT metric clears the other metrics' auto-logged progress
    // first: sibling workout keys (minutes ↔ sessions) see the same real-world workouts,
    // so surviving old-key logs would double-count every already-qualified day when the
    // new key back-fills. Metric-scoped on purpose — unlinking (null) keeps the progress
    // that genuinely happened.
    if ('healthMetric' in patch && patch.healthMetric != null) {
      await client.query(
        `update goal_logs set deleted_at=now()
          where household_id=$1 and deleted_at is null
            and id in (select goal_log_id from health_goal_logs where goal_id=$2 and metric <> $3)`,
        [tenant.householdId, id, patch.healthMetric]
      )
      await client.query(
        `delete from health_goal_logs where household_id=$1 and goal_id=$2 and metric <> $3`,
        [tenant.householdId, id, patch.healthMetric]
      )
    }
    const sets: string[] = []
    const vals: unknown[] = []
    let i = 1
    for (const [k, col] of Object.entries(GOAL_COLUMNS)) {
      if (k in patch) {
        sets.push(`${col}=$${i++}`)
        vals.push((patch[k] as unknown) ?? null)
      }
    }
    let exists = true
    if (sets.length) {
      vals.push(tenant.householdId, id)
      const r = await client.query(
        `update goals set ${sets.join(',')} where household_id=$${i++} and id=$${i++} and deleted_at is null`,
        vals
      )
      exists = !!r.rowCount
    } else {
      const r = await client.query(`select 1 from goals where household_id=$1 and id=$2 and deleted_at is null`, [tenant.householdId, id])
      exists = !!r.rowCount
    }
    if (!exists) {
      await client.query('rollback')
      return false
    }
    if (Array.isArray(patch.participantIds)) {
      await client.query(`update goal_participants set deleted_at=now() where goal_id=$1 and deleted_at is null`, [id])
      for (const pid of [...new Set(patch.participantIds)]) {
        await client.query(`insert into goal_participants (household_id, goal_id, person_id) values ($1,$2,$3)`, [tenant.householdId, id, pid])
      }
    }
    if (Array.isArray(patch.milestones)) {
      await client.query(`update goal_milestones set deleted_at=now() where goal_id=$1 and deleted_at is null`, [id])
      let order = 0
      for (const m of patch.milestones) {
        await client.query(
          `insert into goal_milestones (household_id, goal_id, threshold, emoji, label, reward_text, sort_order) values ($1,$2,$3,$4,$5,$6,$7)`,
          [tenant.householdId, id, m.threshold, m.emoji ?? null, m.label ?? null, m.rewardText ?? null, order++]
        )
      }
    }
    // Reconcile checklist steps WITHOUT wiping completion: update matched ids in place,
    // insert new, soft-delete dropped.
    if (Array.isArray(patch.steps)) {
      const keepIds = patch.steps.map((s) => s.id).filter(Boolean) as string[]
      await client.query(
        `update goal_steps set deleted_at=now()
          where goal_id=$1 and deleted_at is null and not (id = any($2::uuid[]))`,
        [id, keepIds]
      )
      let order = 0
      for (const s of patch.steps) {
        const label = s.label?.trim()
        if (!label) continue
        if (s.id) {
          await client.query(
            `update goal_steps set label=$1, sort_order=$2 where id=$3 and goal_id=$4 and deleted_at is null`,
            [label, order++, s.id, id]
          )
        } else {
          await client.query(
            `insert into goal_steps (household_id, goal_id, label, sort_order) values ($1,$2,$3,$4)`,
            [tenant.householdId, id, label, order++]
          )
        }
      }
    }
    await client.query('commit')
    return true
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// Derived logs (checklist tick, Health sync, confirmed calendar event) are owned by their
// source and must be undone there.
const EDITABLE_LOG_SOURCES = new Set(['quick_log', 'manual'])

type LogEditResult = 'ok' | 'not_found' | 'not_editable'

// The live rows of one logged entry. `logId` is the grouped id from recent activity — a
// batch_id, or a lone row's id.
async function loadLogGroup(
  client: import('pg').PoolClient,
  householdId: string,
  goalId: string,
  logId: string
): Promise<Array<{ person_id: string | null; amount: string; note: string | null; source: string; counts_total: boolean; day: string }>> {
  const { rows } = await client.query(
    `select person_id, amount, note, source, counts_total,
            (logged_at at time zone (select timezone from households where id=$1))::date::text as day
       from goal_logs
      where household_id=$1 and goal_id=$2 and deleted_at is null and coalesce(batch_id, id) = $3
      order by created_at`,
    [householdId, goalId, logId]
  )
  return rows
}

// Soft-delete a whole logged entry (every row in its batch). Refuses derived entries.
export async function deleteGoalLog(tenant: Tenant, goalId: string, logId: string): Promise<LogEditResult> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const group = await loadLogGroup(client, tenant.householdId, goalId, logId)
    if (group.length === 0) { await client.query('rollback'); return 'not_found' }
    if (!EDITABLE_LOG_SOURCES.has(group[0].source)) { await client.query('rollback'); return 'not_editable' }
    await client.query(
      `update goal_logs set deleted_at = now()
        where household_id=$1 and goal_id=$2 and deleted_at is null and coalesce(batch_id, id) = $3`,
      [tenant.householdId, goalId, logId]
    )
    await client.query('commit')
    return 'ok'
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// Edit an entry's amount / note / date / participants, re-planning through the goal's
// current counting rules.
export async function editGoalLog(
  tenant: Tenant,
  goalId: string,
  logId: string,
  patch: { amount?: number; note?: string | null; loggedOn?: string | null; personIds?: string[] }
): Promise<LogEditResult> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const group = await loadLogGroup(client, tenant.householdId, goalId, logId)
    if (group.length === 0) { await client.query('rollback'); return 'not_found' }
    const source = group[0].source

    const enteredAmount = group.filter((r) => r.counts_total).reduce((s, r) => s + Number(r.amount), 0)
    const current = [...new Set(group.map((r) => r.person_id).filter((p): p is string => p != null))]
    const participants = patch.personIds != null ? [...new Set(patch.personIds)] : current

    if (!EDITABLE_LOG_SOURCES.has(source)) {
      // A derived entry (checklist tick, calendar confirm, Health sync) is owned by
      // whatever wrote it, and other tables (event_goal_logs, health_goal_logs) key off
      // these exact row ids. The note is the user's own text, so a note-only change is
      // allowed — applied IN PLACE, never through the re-plan below, which would
      // soft-delete these rows and orphan those links. Both edit sheets re-send the
      // current amount/day/people, so "unchanged" counts as note-only; only a real change
      // to a source-owned field is refused.
      const movesDay = patch.loggedOn != null && patch.loggedOn !== group[0].day
      const changesAmount = patch.amount != null && Math.abs(patch.amount - enteredAmount) > 1e-9
      const changesWho = patch.personIds != null &&
        (participants.length !== current.length || participants.some((p) => !current.includes(p)))
      if (movesDay || changesAmount || changesWho) { await client.query('rollback'); return 'not_editable' }
      if (patch.note !== undefined) {
        await client.query(
          `update goal_logs set note=$4, updated_at=now()
            where household_id=$1 and goal_id=$2 and deleted_at is null and coalesce(batch_id, id) = $3`,
          [tenant.householdId, goalId, logId, patch.note]
        )
      }
      await client.query('commit')
      return 'ok'
    }
    const newAmount = patch.amount != null ? patch.amount : enteredAmount
    const newNote = patch.note !== undefined ? patch.note : group[0].note
    const newDay = patch.loggedOn != null ? patch.loggedOn : group[0].day

    const g = await client.query<{ tracking_mode: string; goal_type: string; participant_mode: string }>(
      `select tracking_mode, goal_type, participant_mode from goals where id=$1 and household_id=$2`,
      [goalId, tenant.householdId]
    )
    await client.query(
      `update goal_logs set deleted_at = now()
        where household_id=$1 and goal_id=$2 and deleted_at is null and coalesce(batch_id, id) = $3`,
      [tenant.householdId, goalId, logId]
    )
    const targets = participants.length ? participants : [null]
    const { rows: plan, batchId } = planLogRows(g.rows[0].participant_mode, g.rows[0].tracking_mode, g.rows[0].goal_type, newAmount, targets)
    for (const row of plan) {
      await client.query(
        `insert into goal_logs (household_id, goal_id, person_id, amount, note, source, created_by, batch_id, counts_total, logged_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9, ${localNoonSql(10)})`,
        [tenant.householdId, goalId, row.personId, row.amount, newNote, source, tenant.personId, batchId, row.countsTotal, newDay]
      )
    }
    await client.query('commit')
    return 'ok'
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

export async function softDeleteGoal(householdId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `update goals set deleted_at = now() where household_id=$1 and id=$2 and deleted_at is null`,
    [householdId, id]
  )
  return !!rowCount
}
