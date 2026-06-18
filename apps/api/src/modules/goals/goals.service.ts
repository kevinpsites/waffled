// Goals domain — matches the handoff Goals mocks. Goal lists (the SHARED LISTS /
// INDIVIDUAL membership sidebar), goals (count/total/habit/checklist; shared_total
// vs each_tracks), append-only logs (SUM = progress), milestones, and a detail
// read model (hours-by-person, recent activity, streak, this-week).
import type { QueryResultRow } from 'pg'
import { getPool, query } from '../../platform/db'
import { type Tenant } from '../households/households'
import type { CreateGoalListInput, UpdateGoalListInput, CreateGoalInput, UpdateGoalInput } from './goals.types'

export const GOAL_TYPES = new Set(['count', 'total', 'habit', 'checklist'])
export const TRACKING_MODES = new Set(['shared_total', 'each_tracks'])

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

export async function createGoal(tenant: Tenant, input: CreateGoalInput): Promise<{ id: string }> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const g = await client.query<{ id: string }>(
      `insert into goals
         (household_id, goal_list_id, title, emoji, category, goal_type, unit, target_value,
          habit_period, habit_target_per_period, tracking_mode, log_method, auto_from_calendar,
          deadline, is_featured, has_rewards)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
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
        input.logMethod ?? 'quick_log',
        input.autoFromCalendar ?? false,
        input.deadline ?? null,
        input.isFeatured ?? false,
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
  log_method: string
  auto_from_calendar: boolean
  deadline: string | null
  is_featured: boolean
  has_rewards: boolean
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
    logMethod: g.log_method,
    autoFromCalendar: g.auto_from_calendar,
    deadline: g.deadline,
    isFeatured: g.is_featured,
    hasRewards: g.has_rewards,
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
            g.habit_period, g.habit_target_per_period, g.tracking_mode, g.log_method, g.auto_from_calendar, g.deadline,
            g.is_featured, g.has_rewards,
            coalesce((select sum(amount)::float from goal_logs gl
                       where gl.goal_id = g.id and gl.deleted_at is null), 0) as total_progress,
            (select count(*) from goal_milestones gm
              where gm.goal_id = g.id and gm.deleted_at is null) as milestone_total,
            (select count(*) from goal_milestones gm
              where gm.goal_id = g.id and gm.deleted_at is null
                and gm.threshold <= coalesce((select sum(amount) from goal_logs gl
                       where gl.goal_id = g.id and gl.deleted_at is null), 0)) as milestone_reached,
            ${PERIOD_DONE_SUBQUERY} as period_done,
            ${STEP_TOTAL_SUBQUERY} as step_total,
            ${STEP_DONE_SUBQUERY} as step_done,
            ${LOGGED_TODAY_SUBQUERY} as logged_today_by,
            ${PARTICIPANTS_SUBQUERY} as participants
       from goals g
      where g.household_id = $1 and g.deleted_at is null and g.is_active
        and ($2::uuid is null or g.goal_list_id = $2)
      order by g.is_featured desc, g.created_at`,
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

export async function goalDetail(householdId: string, id: string) {
  const { rows } = await query<GoalRow>(
    `select g.id, g.goal_list_id, g.title, g.emoji, g.category, g.goal_type, g.unit, g.target_value,
            g.habit_period, g.habit_target_per_period, g.tracking_mode, g.log_method, g.auto_from_calendar, g.deadline,
            g.is_featured, g.has_rewards, g.created_at,
            coalesce((select sum(amount)::float from goal_logs gl
                       where gl.goal_id = g.id and gl.deleted_at is null), 0) as total_progress,
            (select count(*) from goal_milestones gm
              where gm.goal_id = g.id and gm.deleted_at is null) as milestone_total,
            (select count(*) from goal_milestones gm
              where gm.goal_id = g.id and gm.deleted_at is null
                and gm.threshold <= coalesce((select sum(amount) from goal_logs gl
                       where gl.goal_id = g.id and gl.deleted_at is null), 0)) as milestone_reached,
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

  const recent = (
    await query<{ id: string; amount: string; loggedAt: string; note: string | null; personId: string | null; name: string | null; avatarEmoji: string | null; colorHex: string | null }>(
      `select gl.id, gl.amount, gl.logged_at as "loggedAt", gl.note,
              gl.person_id as "personId", p.name, p.avatar_emoji as "avatarEmoji", p.color_hex as "colorHex"
         from goal_logs gl left join persons p on p.id = gl.person_id
        where gl.goal_id=$1 and gl.deleted_at is null
        order by gl.logged_at desc limit 12`,
      [id]
    )
  ).rows.map((r) => ({ ...r, amount: Number(r.amount) }))

  const thisWeek = Number(
    (
      await query<{ sum: string }>(
        `select coalesce(sum(amount),0) as sum from goal_logs
          where goal_id=$1 and deleted_at is null
            and logged_at >= date_trunc('week', now())`,
        [id]
      )
    ).rows[0].sum
  )

  return { ...base, createdAt: rows[0].created_at, milestones, steps, recent, thisWeek, streakDays }
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

// Log progress for one or more people — the handoff "who was outside" multi-select
// inserts one entry per person, so per-person sums still roll up to the pool total.
const round2 = (n: number): number => Math.round(n * 100) / 100

// Log progress toward a goal. The `amount` is always what the GOAL gains — the
// people you tap are who took part, never a multiplier. How that maps to rows
// depends on the goal:
//   • shared_total + divisible (goalType 'total', e.g. hours): the amount is the
//     family's total for this activity, so it's SPLIT EVENLY across participants
//     (rows sum back to exactly `amount`; the last person absorbs any rounding
//     remainder so the pool total never drifts).
//   • each_tracks: each person independently did `amount`, so every participant
//     gets a full-amount row (the pool gains amount × N — correct here).
//   • whole-unit goals (books, parks): the modal sends a single target (one
//     person, or null = "the family"), so this writes one full-amount row.
export async function logProgress(
  tenant: Tenant,
  goalId: string,
  amount: number,
  personIds: Array<string | null>,
  note?: string | null
): Promise<void> {
  const targets = personIds.length ? personIds : [null]

  const { rows } = await query<{ tracking_mode: string; goal_type: string }>(
    `select tracking_mode, goal_type from goals where id = $1 and household_id = $2`,
    [goalId, tenant.householdId]
  )
  const trackingMode = rows[0]?.tracking_mode
  const goalType = rows[0]?.goal_type
  const isHabit = goalType === 'habit'
  const splitEvenly = trackingMode === 'shared_total' && goalType === 'total' && targets.length > 1

  // Per-row amounts. Habits are about consistency, so each completion counts as
  // exactly 1 (never split, never a custom amount). When splitting a divisible
  // shared pool, divide so the parts sum to exactly `amount`.
  let amounts: number[]
  if (isHabit) {
    amounts = targets.map(() => 1)
  } else if (splitEvenly) {
    const n = targets.length
    const share = round2(amount / n)
    amounts = targets.map((_, i) => (i === n - 1 ? round2(amount - share * (n - 1)) : share))
  } else {
    amounts = targets.map(() => amount)
  }

  for (let i = 0; i < targets.length; i++) {
    // A habit can only be logged once per day per person — logging it five times
    // in an afternoon isn't the point. Skip a same-day duplicate silently.
    if (isHabit) {
      const dup = await query(
        `select 1 from goal_logs gl, households h
          where h.id = $1 and gl.household_id = $1 and gl.goal_id = $2 and gl.deleted_at is null
            and gl.person_id is not distinct from $3
            and (gl.logged_at at time zone h.timezone)::date = (now() at time zone h.timezone)::date
          limit 1`,
        [tenant.householdId, goalId, targets[i]]
      )
      if (dup.rowCount) continue
    }
    await query(
      `insert into goal_logs (household_id, goal_id, person_id, amount, note, source, created_by)
       values ($1,$2,$3,$4,$5,'quick_log',$6)`,
      [tenant.householdId, goalId, targets[i], amounts[i], note ?? null, tenant.personId]
    )
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
  logMethod: 'log_method',
  autoFromCalendar: 'auto_from_calendar',
  deadline: 'deadline',
  isFeatured: 'is_featured',
  hasRewards: 'has_rewards',
  goalListId: 'goal_list_id',
}

export async function updateGoal(tenant: Tenant, id: string, patch: UpdateGoalInput): Promise<boolean> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
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

export async function softDeleteGoal(householdId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `update goals set deleted_at = now() where household_id=$1 and id=$2 and deleted_at is null`,
    [householdId, id]
  )
  return !!rowCount
}
