// Goals domain — matches the handoff Goals mocks. Goal lists (the SHARED LISTS /
// INDIVIDUAL membership sidebar), goals (count/total/habit/checklist; shared_total
// vs each_tracks), append-only logs (SUM = progress), milestones, and a detail
// read model (hours-by-person, recent activity, streak, this-week).
import { randomUUID } from 'node:crypto'
import type { PoolClient, QueryResultRow } from 'pg'
import { getPool, query } from '../../platform/db'
import { type Tenant } from '../households/households'
import type { CreateGoalListInput, UpdateGoalListInput, CreateGoalInput, UpdateGoalInput } from './goals.types'

export const GOAL_TYPES = new Set(['count', 'total', 'habit', 'checklist'])
export const TRACKING_MODES = new Set(['shared_total', 'each_tracks'])
// How a SHARED goal counts a log that several people took part in (ignored for
// each_tracks, which always credits each person and sums to the collective total):
//   count_once  — one shared event; +amount once, the people are attendance.
//   split       — the amount is divided evenly across the people.
// ('credit_each' was retired — see migration 0079.) See migration 0078 + logProgress
// for the row-writing rules.
export const PARTICIPANT_MODES = new Set(['count_once', 'split'])
// Whether a goal's target_value is a family total or a per-person target. Only meaningful
// for each_tracks goals: 'per_person' means the family ring target is target_value × the
// member count (read 12 EACH → 24 for two); 'family' is a flat shared target (12 total).
export const TARGET_BASES = new Set(['family', 'per_person'])
// A habit's period is interpolated into date_trunc() in the progress query, so it must
// be one of Postgres's field names — an unconstrained value would throw at read time and
// 500 the whole goals list. Keep this in sync with habit_period usage.
export const HABIT_PERIODS = new Set(['day', 'week', 'month'])
// Apple Health metrics a goal can auto-fill from (iPhone). Keep in sync with the iOS
// HealthKitBridge.Metric keys. Quantity metrics (steps…mindful_minutes) send a raw daily
// total; the boolean metrics (rings, mood) send 1 when met / 0 when not, so they ride the
// habit daily-threshold path (threshold 1) — the server stays metric-agnostic either way.
export const HEALTH_METRICS = new Set([
  'steps', 'flights', 'exercise_minutes', 'active_energy',
  'move_ring', 'exercise_ring', 'stand_ring', 'rings_all', 'mindful_minutes', 'mood',
])

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

// Edit a goal list: any provided field is updated; when `memberIds` is given the
// membership is replaced wholesale. Existing goals keep their snapshotted
// participants — changing the group doesn't retroactively rewrite past goals.
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

// Deleting a goal group does NOT delete its goals — unlike a throwaway grocery
// list, goals are long-lived (history, progress, participants). So we detach them
// (goal_list_id → null) rather than orphan or destroy them, and drop the now-
// meaningless membership rows. All in one transaction.
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

// A list holds exactly one spotlight (the hero). Clear any OTHER spotlight in the same list,
// demoting the old one to Featured so it stays elevated — just not the hero. `listId` null
// groups ungrouped goals. Runs inside the caller's transaction.
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
    // Demote the list's current spotlight BEFORE inserting the new one (the partial unique
    // index forbids two live spotlights in a list).
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

// Habit goals are about consistency, not a grand total: how many distinct days
// have been logged in the CURRENT period (day/week/month, household timezone).
// 0 for non-habit goals, which display the cumulative total instead.
const PERIOD_DONE_SUBQUERY = `case when g.goal_type = 'habit' then (
  select count(distinct (gl.logged_at at time zone h.timezone)::date)
    from goal_logs gl, households h
   where h.id = g.household_id and gl.goal_id = g.id and gl.deleted_at is null
     and (gl.logged_at at time zone h.timezone)
         >= date_trunc(g.habit_period, (now() at time zone h.timezone))
) else 0 end`

// Who has already logged this goal TODAY (household timezone), as an array of
// person ids — with the sentinel '__family__' for a no-person (shared) log. The
// client uses it to stop a habit being marked done twice in a day per person.
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
            g.habit_period, g.habit_target_per_period, g.tracking_mode, g.participant_mode, g.target_basis, g.log_method, g.auto_from_calendar, g.health_metric, g.health_daily_target, g.deadline,
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

// The goal's type, or null if it doesn't exist (wrong household / deleted). Lets the
// /log route 404 an unknown goal and reject a numeric log against a checklist.
export async function goalTypeFor(householdId: string, id: string): Promise<string | null> {
  const { rows } = await query<{ goal_type: string }>(
    `select goal_type from goals where household_id=$1 and id=$2 and deleted_at is null`,
    [householdId, id]
  )
  return rows[0]?.goal_type ?? null
}

// True only if every id is a live person in this household — so a /log can't attribute
// progress to a stranger (or someone in another household).
export async function personsInHousehold(householdId: string, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true
  const unique = [...new Set(ids)]
  const { rows } = await query<{ n: string }>(
    `select count(*)::int as n from persons where household_id=$1 and id = any($2::uuid[]) and deleted_at is null`,
    [householdId, unique]
  )
  return Number(rows[0]?.n ?? 0) === unique.length
}

// The person_ids currently assigned to a goal (live participants only). Powers the
// goal.manage carve-out: a goal whose sole participant is the caller is "their own".
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
            g.habit_period, g.habit_target_per_period, g.tracking_mode, g.participant_mode, g.target_basis, g.log_method, g.auto_from_calendar, g.health_metric, g.health_daily_target, g.deadline,
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

  // A milestone's threshold is read against the goal's natural axis: streak days
  // for habits, percent-complete for checklists, cumulative total otherwise.
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

  // Audit log. Rows split from one entered amount share a batch_id (set only on the
  // shared-pool split path); we collapse those siblings into a single entry — summed
  // amount, earliest timestamp, and the participants as an avatar list. Every unbatched
  // row groups by its own id, so it stays one entry exactly as before. Grouping (not the
  // raw rows) is limited to 12 so a split action counts as one line.
  const recent = (
    await query<{ id: string; amount: string; loggedAt: string; note: string | null; participants: Array<{ personId: string | null; name: string | null; avatarEmoji: string | null; colorHex: string | null }> }>(
      `select coalesce(gl.batch_id, gl.id)::text as id,
              coalesce(sum(gl.amount) filter (where gl.counts_total), 0) as amount,
              min(gl.logged_at) as "loggedAt",
              gl.note,
              coalesce(
                json_agg(json_build_object(
                  'personId', gl.person_id, 'name', p.name,
                  'avatarEmoji', p.avatar_emoji, 'colorHex', p.color_hex
                ) order by p.name) filter (where gl.person_id is not null),
                '[]'::json
              ) as participants
         from goal_logs gl left join persons p on p.id = gl.person_id
        where gl.goal_id=$1 and gl.deleted_at is null
        group by coalesce(gl.batch_id, gl.id), gl.note
        order by min(gl.logged_at) desc limit 12`,
      [id]
    )
  ).rows.map((r) => ({ ...r, amount: Number(r.amount) }))

  const thisWeek = Number(
    (
      await query<{ sum: string }>(
        `select coalesce(sum(amount),0) as sum from goal_logs
          where goal_id=$1 and deleted_at is null and counts_total
            and logged_at >= date_trunc('week', now())`,
        [id]
      )
    ).rows[0].sum
  )

  return { ...base, milestones, steps, recent, thisWeek, streakDays }
}

// Tick/untick a checklist step. We keep the step's done_at as the source of truth
// AND mirror it into goal_logs (source 'checklist_item') so the activity feed and
// streaks treat a ticked step like any other completion. Returns false if the step
// isn't found (wrong household/goal).
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
// GOAL gains — the people you tap are who took part, never a multiplier. The FAMILY
// total sums only `countsTotal` rows; the per-person leaderboard sums every row by
// person. That split is what lets several people share one event without inflating the
// family number. See PARTICIPANT_MODES + migration 0078.
//   • habit        → each completion is exactly 1 (one row per person, all count).
//   • each_tracks  → everyone independently did `amount`; all rows count, summing to
//                    the collective total (e.g. "read 12 books each" → 48 for four).
//   • shared_total → the participant mode decides:
//       - split       amount divided evenly across the people (rows sum to `amount`).
//       - count_once  one family row (counts once) + an amount-0 ATTENDANCE row per
//                     person recording who was there.
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
  // The attendance/multiplier distinction only bites with 2+ people. With a single
  // person (or none) there is no shared event to divide, so it's just that person (or
  // the family) doing it — one plain row that counts, credited to whoever's named.
  if (participantMode === 'count_once' && realPeople.length > 1) {
    return {
      rows: [{ personId: null, amount, countsTotal: true }, ...realPeople.map((p) => ({ personId: p, amount: 0, countsTotal: false }))],
      batchId: randomUUID(),
    }
  }
  // split with a single target, a single-person shared log, or a family-only log
  // (no people tapped): one plain row that counts toward the total.
  return { rows: targets.map((t) => ({ personId: t, amount, countsTotal: true })), batchId: null }
}

// Log progress toward a goal. Resolves the goal's counting rules, plans the rows via
// planLogRows, then inserts them (batched siblings share a batch_id so the audit log
// collapses them into one line with participant avatars).
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
  // Optional backdate (YYYY-MM-DD, household-local). Lands the entry at noon on
  // that local day so it falls on the intended date in every timezone — used to
  // catch up a forgotten log without breaking a streak.
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
    // A habit can only be logged once per day per person — logging it five times
    // in an afternoon isn't the point. Skip a same-day duplicate silently.
    if (isHabit) {
      // Dedupe against the day we're logging FOR (the backdated day if given),
      // not always "today" — so catching up yesterday doesn't collide with today.
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
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11${at ? `, ($12::date + time '12:00') at time zone (select timezone from households where id = $1)` : ''}) returning id`,
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
 * double-counts against the append-only SUM. `value` is the day's total from HealthKit.
 *
 * The *amount* depends on goal_type (the "what counting" decision):
 *   • total / count → the raw day total, which ACCUMULATES toward target_value
 *     ("1,000,000 steps this year"). Re-sync replaces the day's number in place.
 *   • habit         → ONE completion (amount 1) when the day clears health_daily_target
 *     ("2,000 steps a day, 5 days a week"); below the threshold the day doesn't count,
 *     and a previously-counted day that no longer qualifies is undone.
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
    // Habits only count a day that clears the daily threshold; everything else always
    // records (the running total). The logged amount is 1 for a habit completion.
    const met = !isHabit || (threshold != null && value >= threshold)
    const amount = isHabit ? 1 : value

    const existing = await client.query<{ id: string; goal_log_id: string | null }>(
      `select id, goal_log_id from health_goal_logs
        where goal_id=$1 and person_id is not distinct from $2 and metric=$3 and day=$4`,
      [goalId, tenant.personId, metric, day]
    )

    // A habit day that no longer qualifies (e.g. the threshold was raised): undo the
    // completion and drop the mapping so a later qualifying sync re-creates it.
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
      // First qualifying sync for this day → insert the progress row (landed at noon local
      // so it falls on `day` in every timezone), then record the idempotency mapping.
      const ins = await client.query<{ id: string }>(
        `insert into goal_logs (household_id, goal_id, person_id, amount, source, ref_type, ref_id, created_by, logged_at)
         values ($1,$2,$3,$4,'auto_healthkit','hk_day',null,$3,
                 ($5::date + time '12:00') at time zone (select timezone from households where id=$1))
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
    // Promoting to spotlight demotes the target list's current hero FIRST, before this goal's
    // flag flips (the partial unique index forbids two live spotlights per list). Target list
    // = the patched goalListId if present, else the goal's current list.
    if (patch.isSpotlight === true) {
      const targetList = 'goalListId' in patch
        ? ((patch.goalListId as string | null) ?? null)
        : (await client.query<{ goal_list_id: string | null }>(
            `select goal_list_id from goals where household_id=$1 and id=$2 and deleted_at is null`,
            [tenant.householdId, id]
          )).rows[0]?.goal_list_id ?? null
      await demoteListSpotlight(client, tenant.householdId, targetList, id)
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
    // Reconcile checklist steps WITHOUT wiping completion: update existing steps
    // (matched by id) in place, insert new ones, soft-delete any dropped.
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

// Entries the user can hand-edit/delete. Derived logs (a checklist tick, an Apple
// Health sync, a confirmed calendar event) are owned by their source and must be undone
// there, not through the log endpoints.
const EDITABLE_LOG_SOURCES = new Set(['quick_log', 'manual'])

type LogEditResult = 'ok' | 'not_found' | 'not_editable'

// The live rows of one logged entry. `logId` is the grouped id surfaced in a goal's
// recent activity — a batch_id (split/attributed entry) or a lone row's id.
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

// Edit a logged entry's amount / note / date / participants. Re-plans the rows through
// the goal's current counting rules (so a split/count_once entry stays consistent).
// Every field is optional — omitted ones keep their current value, including who took
// part (pass personIds to change "who was there").
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
    if (!EDITABLE_LOG_SOURCES.has(source)) { await client.query('rollback'); return 'not_editable' }

    const enteredAmount = group.filter((r) => r.counts_total).reduce((s, r) => s + Number(r.amount), 0)
    const participants = patch.personIds != null
      ? [...new Set(patch.personIds)]
      : [...new Set(group.map((r) => r.person_id).filter((p): p is string => p != null))]
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
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9, ($10::date + time '12:00') at time zone (select timezone from households where id=$1))`,
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
