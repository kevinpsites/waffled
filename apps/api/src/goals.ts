// Goals domain (MVP): create goals with participants, list with derived progress
// (SUM of append-only logs), and log progress. Milestones/rewards/privacy later.
import createAPI, { type Request, type Response } from 'lambda-api'
import type { QueryResultRow } from 'pg'
import { getPool, query } from './db'
import { requireTenant, type Tenant } from './households'

type Api = ReturnType<typeof createAPI>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GOAL_TYPES = new Set(['count', 'total', 'habit', 'checklist'])
const TRACKING_MODES = new Set(['shared_total', 'each_tracks'])

export interface CreateGoalInput {
  title: string
  emoji?: string | null
  category?: string | null
  goalType: string
  unit?: string | null
  targetValue?: number | null
  trackingMode: string
  participantIds?: string[]
  deadline?: string | null
  isFeatured?: boolean
}

export async function createGoal(tenant: Tenant, input: CreateGoalInput): Promise<{ id: string }> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const g = await client.query<{ id: string }>(
      `insert into goals
         (household_id, title, emoji, category, goal_type, unit, target_value, tracking_mode, deadline, is_featured)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [
        tenant.householdId,
        input.title,
        input.emoji ?? null,
        input.category ?? null,
        input.goalType,
        input.unit ?? null,
        input.targetValue ?? null,
        input.trackingMode,
        input.deadline ?? null,
        input.isFeatured ?? false,
      ]
    )
    const goalId = g.rows[0].id
    for (const pid of [...new Set(input.participantIds ?? [])]) {
      await client.query(
        `insert into goal_participants (household_id, goal_id, person_id) values ($1,$2,$3)`,
        [tenant.householdId, goalId, pid]
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

interface GoalRow extends QueryResultRow {
  id: string
  title: string
  emoji: string | null
  category: string | null
  goal_type: string
  unit: string | null
  target_value: string | null
  tracking_mode: string
  deadline: string | null
  is_featured: boolean
  total_progress: number
  participants: Array<{
    personId: string
    name: string
    colorHex: string | null
    avatarEmoji: string | null
    target: number | null
    progress: number
  }>
}

export async function listGoals(householdId: string) {
  const { rows } = await query<GoalRow>(
    `select g.id, g.title, g.emoji, g.category, g.goal_type, g.unit, g.tracking_mode, g.deadline,
            g.target_value, g.is_featured,
            coalesce((select sum(amount)::float from goal_logs gl
                       where gl.goal_id = g.id and gl.deleted_at is null), 0) as total_progress,
            coalesce((
              select json_agg(json_build_object(
                       'personId', pa.person_id, 'name', p.name,
                       'colorHex', p.color_hex, 'avatarEmoji', p.avatar_emoji,
                       'target', coalesce(pa.target_override, g.target_value)::float,
                       'progress', coalesce((select sum(amount)::float from goal_logs gl2
                                              where gl2.goal_id = g.id and gl2.person_id = pa.person_id
                                                and gl2.deleted_at is null), 0))
                     order by p.sort_order, p.created_at)
                from goal_participants pa
                join persons p on p.id = pa.person_id and p.deleted_at is null
               where pa.goal_id = g.id and pa.deleted_at is null
            ), '[]'::json) as participants
       from goals g
      where g.household_id = $1 and g.deleted_at is null and g.is_active
      order by g.is_featured desc, g.created_at`,
    [householdId]
  )
  return rows.map((g) => ({
    id: g.id,
    title: g.title,
    emoji: g.emoji,
    category: g.category,
    goalType: g.goal_type,
    unit: g.unit,
    trackingMode: g.tracking_mode,
    deadline: g.deadline,
    isFeatured: g.is_featured,
    target: g.target_value == null ? null : Number(g.target_value),
    totalProgress: Number(g.total_progress),
    participants: g.participants,
  }))
}

async function goalExists(householdId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `select 1 from goals where household_id=$1 and id=$2 and deleted_at is null`,
    [householdId, id]
  )
  return !!rowCount
}

export async function logProgress(
  tenant: Tenant,
  goalId: string,
  amount: number,
  personId: string | null
): Promise<void> {
  await query(
    `insert into goal_logs (household_id, goal_id, person_id, amount, source, created_by)
     values ($1,$2,$3,$4,'quick_log',$5)`,
    [tenant.householdId, goalId, personId, amount, tenant.personId]
  )
}

export async function softDeleteGoal(householdId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `update goals set deleted_at = now() where household_id=$1 and id=$2 and deleted_at is null`,
    [householdId, id]
  )
  return !!rowCount
}

export function registerGoalRoutes(api: Api): void {
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
    return { goals: await listGoals(tenant.householdId) }
  })

  api.post('/api/goals/:id/log', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    const body = (req.body ?? {}) as { amount?: unknown; personId?: string }
    const amount = Number(body.amount)
    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'amount must be a non-zero number' })
    }
    if (!(await goalExists(tenant.householdId, id))) {
      return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    }
    await logProgress(tenant, id, amount, body.personId || null)
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
