// Goals domain — matches the handoff Goals mocks. Goal lists (the SHARED LISTS /
// INDIVIDUAL membership sidebar), goals (count/total/habit/checklist; shared_total
// vs each_tracks), append-only logs (SUM = progress), milestones, and a detail
// read model (hours-by-person, recent activity, streak, this-week).
import createAPI, { type Request, type Response } from 'lambda-api'
import type { QueryResultRow } from 'pg'
import { getPool, query } from './db'
import { requireTenant, type Tenant } from './households'

type Api = ReturnType<typeof createAPI>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GOAL_TYPES = new Set(['count', 'total', 'habit', 'checklist'])
const TRACKING_MODES = new Set(['shared_total', 'each_tracks'])

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

export interface CreateGoalListInput {
  name: string
  emoji?: string | null
  colorHex?: string | null
  isPrivate?: boolean
  memberIds?: string[]
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

export async function softDeleteGoalList(householdId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `update goal_lists set deleted_at = now() where household_id=$1 and id=$2 and deleted_at is null`,
    [householdId, id]
  )
  return !!rowCount
}

// ---- goals ------------------------------------------------------------------

export interface CreateGoalInput {
  title: string
  goalListId?: string | null
  emoji?: string | null
  category?: string | null
  goalType: string
  unit?: string | null
  targetValue?: number | null
  habitPeriod?: string | null
  habitTargetPerPeriod?: number | null
  trackingMode: string
  logMethod?: string | null
  deadline?: string | null
  isFeatured?: boolean
  hasRewards?: boolean
  participantIds?: string[]
  milestones?: Array<{ threshold: number; emoji?: string | null; label?: string | null; rewardText?: string | null }>
}

export async function createGoal(tenant: Tenant, input: CreateGoalInput): Promise<{ id: string }> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const g = await client.query<{ id: string }>(
      `insert into goals
         (household_id, goal_list_id, title, emoji, category, goal_type, unit, target_value,
          habit_period, habit_target_per_period, tracking_mode, log_method, deadline, is_featured, has_rewards)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
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
  deadline: string | null
  is_featured: boolean
  has_rewards: boolean
  total_progress: number
  milestone_total: number
  milestone_reached: number
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
    deadline: g.deadline,
    isFeatured: g.is_featured,
    hasRewards: g.has_rewards,
    target: g.target_value == null ? null : Number(g.target_value),
    totalProgress: Number(g.total_progress),
    milestoneTotal: Number(g.milestone_total),
    milestoneReached: Number(g.milestone_reached),
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
            g.habit_period, g.habit_target_per_period, g.tracking_mode, g.log_method, g.deadline,
            g.is_featured, g.has_rewards,
            coalesce((select sum(amount)::float from goal_logs gl
                       where gl.goal_id = g.id and gl.deleted_at is null), 0) as total_progress,
            (select count(*) from goal_milestones gm
              where gm.goal_id = g.id and gm.deleted_at is null) as milestone_total,
            (select count(*) from goal_milestones gm
              where gm.goal_id = g.id and gm.deleted_at is null
                and gm.threshold <= coalesce((select sum(amount) from goal_logs gl
                       where gl.goal_id = g.id and gl.deleted_at is null), 0)) as milestone_reached,
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

async function goalExists(householdId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `select 1 from goals where household_id=$1 and id=$2 and deleted_at is null`,
    [householdId, id]
  )
  return !!rowCount
}

export async function goalDetail(householdId: string, id: string) {
  const { rows } = await query<GoalRow>(
    `select g.id, g.goal_list_id, g.title, g.emoji, g.category, g.goal_type, g.unit, g.target_value,
            g.habit_period, g.habit_target_per_period, g.tracking_mode, g.log_method, g.deadline,
            g.is_featured, g.has_rewards, g.created_at,
            coalesce((select sum(amount)::float from goal_logs gl
                       where gl.goal_id = g.id and gl.deleted_at is null), 0) as total_progress,
            (select count(*) from goal_milestones gm
              where gm.goal_id = g.id and gm.deleted_at is null) as milestone_total,
            (select count(*) from goal_milestones gm
              where gm.goal_id = g.id and gm.deleted_at is null
                and gm.threshold <= coalesce((select sum(amount) from goal_logs gl
                       where gl.goal_id = g.id and gl.deleted_at is null), 0)) as milestone_reached,
            ${PARTICIPANTS_SUBQUERY} as participants
       from goals g
      where g.household_id = $1 and g.id = $2 and g.deleted_at is null`,
    [householdId, id]
  )
  if (rows.length === 0) return null
  const base = mapGoal(rows[0])

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
    reached: Number(m.threshold) <= base.totalProgress,
  }))

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

  const streakDays = await goalStreak(householdId, id)
  return { ...base, createdAt: rows[0].created_at, milestones, recent, thisWeek, streakDays }
}

// Log progress for one or more people — the handoff "who was outside" multi-select
// inserts one entry per person, so per-person sums still roll up to the pool total.
export async function logProgress(
  tenant: Tenant,
  goalId: string,
  amount: number,
  personIds: Array<string | null>,
  note?: string | null
): Promise<void> {
  const targets = personIds.length ? personIds : [null]
  for (const personId of targets) {
    await query(
      `insert into goal_logs (household_id, goal_id, person_id, amount, note, source, created_by)
       values ($1,$2,$3,$4,$5,'quick_log',$6)`,
      [tenant.householdId, goalId, personId, amount, note ?? null, tenant.personId]
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
  deadline: 'deadline',
  isFeatured: 'is_featured',
  hasRewards: 'has_rewards',
  goalListId: 'goal_list_id',
}

export interface UpdateGoalInput {
  participantIds?: string[]
  milestones?: Array<{ threshold: number; emoji?: string | null; label?: string | null; rewardText?: string | null }>
  [key: string]: unknown
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

// ---- routes -----------------------------------------------------------------

export function registerGoalRoutes(api: Api): void {
  // goal lists (sidebar)
  api.get('/api/goal-lists', async (req: Request) => {
    const tenant = await requireTenant(req)
    return { lists: await listGoalLists(tenant.householdId) }
  })

  api.post('/api/goal-lists', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const body = (req.body ?? {}) as Partial<CreateGoalListInput>
    if (!body.name || !body.name.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'name is required' })
    }
    const list = await createGoalList(tenant, { ...body, name: body.name.trim() } as CreateGoalListInput)
    return res.status(201).json({ list })
  })

  api.delete('/api/goal-lists/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    const ok = await softDeleteGoalList(tenant.householdId, id)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    return res.status(204).send('')
  })

  // goals
  api.post('/api/goals', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const body = (req.body ?? {}) as Partial<CreateGoalInput>
    if (!body.title || !body.title.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'title is required' })
    }
    if (!body.goalType || !GOAL_TYPES.has(body.goalType)) {
      return res.status(400).json({ error: 'BadRequest', message: 'goalType is required' })
    }
    if (!body.trackingMode || !TRACKING_MODES.has(body.trackingMode)) {
      return res.status(400).json({ error: 'BadRequest', message: 'trackingMode is required' })
    }
    const goal = await createGoal(tenant, { ...body, title: body.title.trim() } as CreateGoalInput)
    return res.status(201).json({ goal })
  })

  api.get('/api/goals', async (req: Request) => {
    const tenant = await requireTenant(req)
    const listId = (req.query?.listId as string | undefined) || null
    return { goals: await listGoals(tenant.householdId, listId && UUID_RE.test(listId) ? listId : null) }
  })

  api.get('/api/goals/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    const goal = await goalDetail(tenant.householdId, id)
    if (!goal) return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    return { goal }
  })

  api.patch('/api/goals/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    const body = (req.body ?? {}) as { goalType?: string; trackingMode?: string }
    if (body.goalType && !GOAL_TYPES.has(body.goalType)) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid goalType' })
    }
    if (body.trackingMode && !TRACKING_MODES.has(body.trackingMode)) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid trackingMode' })
    }
    const ok = await updateGoal(tenant, id, req.body ?? {})
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    return { goal: await goalDetail(tenant.householdId, id) }
  })

  api.post('/api/goals/:id/log', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    const body = (req.body ?? {}) as { amount?: unknown; personId?: string; personIds?: string[]; note?: string }
    const amount = Number(body.amount)
    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'amount must be a non-zero number' })
    }
    if (!(await goalExists(tenant.householdId, id))) {
      return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    }
    const personIds = Array.isArray(body.personIds) ? body.personIds.filter(Boolean) : body.personId ? [body.personId] : []
    await logProgress(tenant, id, amount, personIds, body.note ?? null)
    return res.status(201).json({ ok: true })
  })

  api.delete('/api/goals/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    const ok = await softDeleteGoal(tenant.householdId, id)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    return res.status(204).send('')
  })
}
