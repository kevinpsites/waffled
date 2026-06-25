// Goals domain — HTTP routes (/api/goals, /api/goal-lists). Logic in
// goals.service.ts; types in goals.types.ts.
import createAPI, { type Request, type Response } from 'lambda-api'
import { requireCapability } from '../../platform/permissions'
import { tenantRoute, capRoute } from '../../platform/route-guards'
import type { CreateGoalListInput, UpdateGoalListInput, CreateGoalInput } from './goals.types'
import {
  listGoalLists,
  createGoalList,
  updateGoalList,
  softDeleteGoalList,
  createGoal,
  listGoals,
  goalDetail,
  updateGoal,
  softDeleteGoal,
  toggleGoalStep,
  logProgress,
  goalExists,
  goalParticipantIds,
  GOAL_TYPES,
  TRACKING_MODES,
} from './goals.service'

type Api = ReturnType<typeof createAPI>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function registerGoalRoutes(api: Api): void {
  // goal lists (sidebar)
  api.get('/api/goal-lists', tenantRoute(async (tenant) => ({
    lists: await listGoalLists(tenant.householdId),
  })))

  api.post('/api/goal-lists', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as Partial<CreateGoalListInput>
    if (!body.name || !body.name.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'name is required' })
    }
    const list = await createGoalList(tenant, { ...body, name: body.name.trim() } as CreateGoalListInput)
    return res.status(201).json({ list })
  }))

  api.patch('/api/goal-lists/:id', capRoute('goal.manage', async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    const body = (req.body ?? {}) as UpdateGoalListInput
    if (body.name !== undefined && !String(body.name).trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'name cannot be empty' })
    }
    const patch: UpdateGoalListInput = { ...body }
    if (patch.name !== undefined) patch.name = String(patch.name).trim()
    const ok = await updateGoalList(tenant, id, patch)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    return res.status(200).json({ ok: true })
  }))

  api.delete('/api/goal-lists/:id', capRoute('goal.manage', async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    const ok = await softDeleteGoalList(tenant.householdId, id)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    return res.status(204).send('')
  }))

  // goals
  api.post('/api/goals', tenantRoute(async (tenant, req: Request, res: Response) => {
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
    // Carve-out: a goal that assigns no one else (nobody, or only the caller) is
    // self-scoped. Assigning another participant takes goal.manage.
    const assigned = Array.isArray(body.participantIds) ? body.participantIds.filter(Boolean) : []
    if (assigned.some((pid) => pid !== tenant.personId)) {
      await requireCapability(tenant, 'goal.manage')
    }
    const goal = await createGoal(tenant, { ...body, title: body.title.trim() } as CreateGoalInput)
    return res.status(201).json({ goal })
  }))

  api.get('/api/goals', tenantRoute(async (tenant, req: Request) => {
    const listId = (req.query?.listId as string | undefined) || null
    return { goals: await listGoals(tenant.householdId, listId && UUID_RE.test(listId) ? listId : null) }
  }))

  api.get('/api/goals/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    const goal = await goalDetail(tenant.householdId, id)
    if (!goal) return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    return { goal }
  }))

  api.patch('/api/goals/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    const body = (req.body ?? {}) as { goalType?: string; trackingMode?: string }
    if (body.goalType && !GOAL_TYPES.has(body.goalType)) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid goalType' })
    }
    if (body.trackingMode && !TRACKING_MODES.has(body.trackingMode)) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid trackingMode' })
    }
    // Carve-out: a goal whose sole participant is the caller is their own personal
    // goal — editable freely. Anything else (shared, others', or a family goal with
    // no/other participants) takes goal.manage. Confirm the goal exists first so an
    // unknown id still 404s rather than 403s.
    if (!(await goalExists(tenant.householdId, id))) {
      return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    }
    const editParticipants = await goalParticipantIds(tenant.householdId, id)
    const editIsSelfOnly = editParticipants.length === 1 && editParticipants[0] === tenant.personId
    if (!editIsSelfOnly) {
      await requireCapability(tenant, 'goal.manage')
    }
    const ok = await updateGoal(tenant, id, req.body ?? {})
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    return { goal: await goalDetail(tenant.householdId, id) }
  }))

  api.post('/api/goals/:id/log', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    const body = (req.body ?? {}) as { amount?: unknown; personId?: string; personIds?: string[]; note?: string; loggedOn?: unknown }
    const amount = Number(body.amount)
    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'amount must be a non-zero number' })
    }
    // Optional backdate to catch up a missed day (e.g. keep a streak alive).
    let loggedOn: string | null = null
    if (body.loggedOn != null && body.loggedOn !== '') {
      if (typeof body.loggedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.loggedOn)) {
        return res.status(400).json({ error: 'BadRequest', message: 'loggedOn must be a YYYY-MM-DD date' })
      }
      loggedOn = body.loggedOn
    }
    if (!(await goalExists(tenant.householdId, id))) {
      return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    }
    const personIds = Array.isArray(body.personIds) ? body.personIds.filter(Boolean) : body.personId ? [body.personId] : []
    // Carve-out: logging for nobody (a family/shared log) or only for yourself is
    // always allowed; attributing progress to another person takes goal.manage.
    if (personIds.some((pid) => pid !== tenant.personId)) {
      await requireCapability(tenant, 'goal.manage')
    }
    await logProgress(tenant, id, amount, personIds, body.note ?? null, { at: loggedOn })
    return res.status(201).json({ ok: true })
  }))

  // Tick/untick a checklist step.
  api.patch('/api/goals/:id/steps/:stepId', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    const stepId = req.params.stepId ?? ''
    if (!UUID_RE.test(id) || !UUID_RE.test(stepId)) return res.status(404).json({ error: 'NotFound', message: 'step not found' })
    const done = Boolean((req.body ?? {}).done)
    const ok = await toggleGoalStep(tenant, id, stepId, done)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'step not found' })
    return res.status(200).json({ ok: true })
  }))

  api.delete('/api/goals/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    // Carve-out mirrors edit: deleting your own sole-participant goal is fine; any
    // shared/others'/family goal takes goal.manage. 404 a missing id before 403.
    if (!(await goalExists(tenant.householdId, id))) {
      return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    }
    const delParticipants = await goalParticipantIds(tenant.householdId, id)
    const delIsSelfOnly = delParticipants.length === 1 && delParticipants[0] === tenant.personId
    if (!delIsSelfOnly) {
      await requireCapability(tenant, 'goal.manage')
    }
    const ok = await softDeleteGoal(tenant.householdId, id)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    return res.status(204).send('')
  }))
}
