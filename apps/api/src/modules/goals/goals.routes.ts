// Goals domain — HTTP routes (/api/goals, /api/goal-lists). Logic in
// goals.service.ts; types in goals.types.ts.
import createAPI, { type Request, type Response } from 'lambda-api'
import { requireCapability } from '../../platform/permissions'
import { moduleRoutes } from '../../platform/route-guards'
import {
  InvalidReferenceError,
  assertGoalListInHousehold,
  assertPersonsInHousehold,
} from '../../platform/household-refs'
import type { CreateGoalListInput, UpdateGoalListInput, CreateGoalInput } from './goals.types'
import {
  listGoalLists,
  createGoalList,
  updateGoalList,
  softDeleteGoalList,
  createGoal,
  listGoals,
  goalDetail,
  goalActivity,
  updateGoal,
  softDeleteGoal,
  toggleGoalStep,
  logProgress,
  deleteGoalLog,
  editGoalLog,
  syncHealthProgress,
  goalExists,
  goalTypeFor,
  goalMetaFor,
  goalLogAmount,
  goalParticipantIds,
  GOAL_TYPES,
  TRACKING_MODES,
  PARTICIPANT_MODES,
  TARGET_BASES,
  HABIT_PERIODS,
  HEALTH_METRICS,
  healthMetricFitsGoalType,
  personsInHousehold,
} from './goals.service'
import { registerGoalCaptureTarget } from './goals-capture'

type Api = ReturnType<typeof createAPI>

// Every route here is gated by the optional `goals` module (403 when off).
const { tenantRoute, capRoute } = moduleRoutes('goals')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Shape checks shared by create + PATCH: reject malformed values that would otherwise
// slip into numeric/date columns (a 500) or a habit period that breaks the progress
// query. `goalType` is the effective type (from the body on create, or the body/stored
// type on PATCH) so count goals can enforce whole-number targets. Returns an error
// message or null. Absent fields are skipped — PATCH only validates what it's changing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function goalShapeError(body: any, goalType?: string | null): string | null {
  if (body.targetValue != null && body.targetValue !== '') {
    const n = Number(body.targetValue)
    if (!Number.isFinite(n)) return 'targetValue must be a number'
    if (goalType === 'count' && !Number.isInteger(n)) return 'a count goal target must be a whole number'
  }
  if (body.deadline != null && body.deadline !== '' && !(typeof body.deadline === 'string' && DATE_RE.test(body.deadline))) {
    return 'deadline must be a YYYY-MM-DD date'
  }
  if (body.habitPeriod != null && body.habitPeriod !== '' && !HABIT_PERIODS.has(String(body.habitPeriod))) {
    return 'habitPeriod must be day, week, or month'
  }
  if (body.habitTargetPerPeriod != null) {
    const n = Number(body.habitTargetPerPeriod)
    if (!Number.isInteger(n) || n <= 0) return 'habitTargetPerPeriod must be a positive whole number'
  }
  if (Array.isArray(body.milestones)) {
    for (const m of body.milestones) {
      if (!Number.isFinite(Number(m?.threshold))) return 'milestone threshold must be a number'
    }
  }
  return null
}

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
    if (body.memberIds !== undefined) {
      if (!Array.isArray(body.memberIds) || body.memberIds.some((id) => typeof id !== 'string')) {
        throw new InvalidReferenceError('invalid member ids')
      }
      await assertPersonsInHousehold(tenant.householdId, body.memberIds)
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
    if (body.memberIds !== undefined) {
      if (!Array.isArray(body.memberIds) || body.memberIds.some((personId) => typeof personId !== 'string')) {
        throw new InvalidReferenceError('invalid member ids')
      }
      await assertPersonsInHousehold(tenant.householdId, body.memberIds)
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
    if (body.participantMode != null && !PARTICIPANT_MODES.has(String(body.participantMode))) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid participantMode' })
    }
    if (body.targetBasis != null && !TARGET_BASES.has(String(body.targetBasis))) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid targetBasis' })
    }
    if (body.healthMetric != null && !HEALTH_METRICS.has(String(body.healthMetric))) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid healthMetric' })
    }
    if (body.healthMetric != null && !healthMetricFitsGoalType(String(body.healthMetric), body.goalType)) {
      return res.status(400).json({ error: 'BadRequest', message: 'healthMetric does not fit this goalType' })
    }
    if (body.healthDailyTarget != null && !(Number(body.healthDailyTarget) >= 0)) {
      return res.status(400).json({ error: 'BadRequest', message: 'healthDailyTarget must be a non-negative number' })
    }
    const shapeErr = goalShapeError(body, body.goalType)
    if (shapeErr) return res.status(400).json({ error: 'BadRequest', message: shapeErr })
    if (body.goalListId != null) await assertGoalListInHousehold(tenant.householdId, body.goalListId)
    if (body.participantIds !== undefined) {
      if (!Array.isArray(body.participantIds) || body.participantIds.some((personId) => typeof personId !== 'string')) {
        throw new InvalidReferenceError('invalid participant ids')
      }
      await assertPersonsInHousehold(tenant.householdId, body.participantIds)
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

  // Day-bucketed log history powering the goal-detail data views (Week/Month/Pace/
  // Year/By-person/Year-ring). See goalActivity for the bucketing rules.
  api.get('/api/goals/:id/activity', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    const activity = await goalActivity(tenant.householdId, id)
    if (!activity) return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    return activity
  }))

  api.patch('/api/goals/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    const body = (req.body ?? {}) as {
      goalType?: string; trackingMode?: string; participantMode?: string; targetBasis?: string
      healthMetric?: unknown; healthDailyTarget?: unknown
      goalListId?: string | null; participantIds?: string[]
    }
    if (body.goalType && !GOAL_TYPES.has(body.goalType)) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid goalType' })
    }
    if (body.trackingMode && !TRACKING_MODES.has(body.trackingMode)) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid trackingMode' })
    }
    if (body.participantMode && !PARTICIPANT_MODES.has(body.participantMode)) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid participantMode' })
    }
    if (body.targetBasis && !TARGET_BASES.has(body.targetBasis)) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid targetBasis' })
    }
    // Validate against the EFFECTIVE type: the body's goalType when it's re-sent
    // (both web + iOS do), else the stored type — so a PATCH that changes only the
    // target still enforces a count goal's whole-number rule.
    const effectiveType = body.goalType ?? (await goalTypeFor(tenant.householdId, id))
    const patchShapeErr = goalShapeError(body, effectiveType)
    if (patchShapeErr) return res.status(400).json({ error: 'BadRequest', message: patchShapeErr })
    // A cleared deadline arrives as '' — normalize to null so it isn't written to a date column.
    if ((req.body as { deadline?: unknown })?.deadline === '') (req.body as { deadline?: unknown }).deadline = null
    if (body.healthMetric != null && !HEALTH_METRICS.has(String(body.healthMetric))) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid healthMetric' })
    }
    // Pairing rides the same effective type as the shape check above.
    if (body.healthMetric != null && effectiveType && !healthMetricFitsGoalType(String(body.healthMetric), effectiveType)) {
      return res.status(400).json({ error: 'BadRequest', message: 'healthMetric does not fit this goalType' })
    }
    if (body.healthDailyTarget != null && !(Number(body.healthDailyTarget) >= 0)) {
      return res.status(400).json({ error: 'BadRequest', message: 'healthDailyTarget must be a non-negative number' })
    }
    if (body.goalListId != null) await assertGoalListInHousehold(tenant.householdId, body.goalListId)
    if (body.participantIds !== undefined) {
      if (!Array.isArray(body.participantIds) || body.participantIds.some((personId) => typeof personId !== 'string')) {
        throw new InvalidReferenceError('invalid participant ids')
      }
      await assertPersonsInHousehold(tenant.householdId, body.participantIds)
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
    const assignsAnother = body.participantIds?.some((personId) => personId !== tenant.personId) ?? false
    if (!editIsSelfOnly || assignsAnother) {
      await requireCapability(tenant, 'goal.manage')
    }
    const ok = await updateGoal(tenant, id, req.body ?? {})
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    return { goal: await goalDetail(tenant.householdId, id) }
  }))

  api.post('/api/goals/:id/log', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    const body = (req.body ?? {}) as { amount?: unknown; hours?: unknown; minutes?: unknown; personId?: string; personIds?: string[]; note?: string; loggedOn?: unknown }
    // Optional backdate to catch up a missed day (e.g. keep a streak alive).
    let loggedOn: string | null = null
    if (body.loggedOn != null && body.loggedOn !== '') {
      if (typeof body.loggedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.loggedOn)) {
        return res.status(400).json({ error: 'BadRequest', message: 'loggedOn must be a YYYY-MM-DD date' })
      }
      loggedOn = body.loggedOn
    }
    const meta = await goalMetaFor(tenant.householdId, id)
    if (meta == null) {
      return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    }
    // The body→amount mapping/validation is shared with the capture commit applier
    // (goalLogAmount) so the two entry points can never diverge.
    const mapped = goalLogAmount(meta, body)
    if ('error' in mapped) {
      return res.status(400).json({ error: 'BadRequest', message: mapped.error })
    }
    const amount = mapped.amount
    const personIds = Array.isArray(body.personIds) ? body.personIds.filter(Boolean) : body.personId ? [body.personId] : []
    // Every credited person must be a real member of this household — no crediting a stranger.
    if (personIds.length && !(await personsInHousehold(tenant.householdId, personIds))) {
      return res.status(400).json({ error: 'BadRequest', message: 'unknown person' })
    }
    // Carve-out: logging for nobody (a family/shared log) or only for yourself is
    // always allowed; attributing progress to another person takes goal.manage.
    if (personIds.some((pid) => pid !== tenant.personId)) {
      await requireCapability(tenant, 'goal.manage')
    }
    await logProgress(tenant, id, amount, personIds, body.note ?? null, { at: loggedOn })
    return res.status(201).json({ ok: true })
  }))

  // Apple Health auto-fill (iPhone): the client pushes its own day's total for a linked
  // metric; we upsert it idempotently (one replaceable row per person/metric/day). Always
  // self-scoped — you sync your own Health data — so no capability is needed.
  api.post('/api/goals/:id/health-sync', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    const body = (req.body ?? {}) as { metric?: unknown; day?: unknown; value?: unknown }
    if (typeof body.metric !== 'string' || !HEALTH_METRICS.has(body.metric)) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid metric' })
    }
    if (typeof body.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.day)) {
      return res.status(400).json({ error: 'BadRequest', message: 'day must be a YYYY-MM-DD date' })
    }
    const value = Number(body.value)
    if (!Number.isFinite(value) || value < 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'value must be a non-negative number' })
    }
    if (!(await goalExists(tenant.householdId, id))) {
      return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    }
    await syncHealthProgress(tenant, id, body.metric, body.day, value)
    return res.status(200).json({ ok: true })
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

  // Edit a single logged entry (amount / note / date). Re-plans through the goal's
  // counting rules, keeping the same participants.
  api.patch('/api/goals/:id/logs/:logId', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    const logId = req.params.logId ?? ''
    if (!UUID_RE.test(id) || !UUID_RE.test(logId)) return res.status(404).json({ error: 'NotFound', message: 'entry not found' })
    const body = (req.body ?? {}) as { amount?: unknown; note?: unknown; loggedOn?: unknown; personIds?: unknown }
    const patch: { amount?: number; note?: string | null; loggedOn?: string; personIds?: string[] } = {}
    if (Array.isArray(body.personIds)) {
      const ids = body.personIds.filter(Boolean).map(String)
      if (ids.length && !(await personsInHousehold(tenant.householdId, ids))) {
        return res.status(400).json({ error: 'BadRequest', message: 'a logged person must be in your household' })
      }
      patch.personIds = ids
    }
    if (body.amount !== undefined) {
      const amount = Number(body.amount)
      if (!Number.isFinite(amount) || amount === 0) {
        return res.status(400).json({ error: 'BadRequest', message: 'amount must be a non-zero number' })
      }
      if ((await goalTypeFor(tenant.householdId, id)) === 'count' && !Number.isInteger(amount)) {
        return res.status(400).json({ error: 'BadRequest', message: 'a count goal is logged in whole numbers' })
      }
      patch.amount = amount
    }
    if (body.note !== undefined) patch.note = body.note == null ? null : String(body.note)
    if (body.loggedOn != null && body.loggedOn !== '') {
      if (typeof body.loggedOn !== 'string' || !DATE_RE.test(body.loggedOn)) {
        return res.status(400).json({ error: 'BadRequest', message: 'loggedOn must be a YYYY-MM-DD date' })
      }
      patch.loggedOn = body.loggedOn
    }
    if (!(await goalExists(tenant.householdId, id))) {
      return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    }
    const parts = await goalParticipantIds(tenant.householdId, id)
    if (!(parts.length === 1 && parts[0] === tenant.personId)) await requireCapability(tenant, 'goal.manage')
    const result = await editGoalLog(tenant, id, logId, patch)
    if (result === 'not_found') return res.status(404).json({ error: 'NotFound', message: 'entry not found' })
    if (result === 'not_editable') return res.status(400).json({ error: 'BadRequest', message: 'this entry is managed by its source (a checklist tick, calendar event, or Health sync)' })
    return { goal: await goalDetail(tenant.householdId, id) }
  }))

  // Delete a single logged entry (the whole batch if it was split/attributed).
  api.delete('/api/goals/:id/logs/:logId', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    const logId = req.params.logId ?? ''
    if (!UUID_RE.test(id) || !UUID_RE.test(logId)) return res.status(404).json({ error: 'NotFound', message: 'entry not found' })
    if (!(await goalExists(tenant.householdId, id))) {
      return res.status(404).json({ error: 'NotFound', message: 'goal not found' })
    }
    const parts = await goalParticipantIds(tenant.householdId, id)
    if (!(parts.length === 1 && parts[0] === tenant.personId)) await requireCapability(tenant, 'goal.manage')
    const result = await deleteGoalLog(tenant, id, logId)
    if (result === 'not_found') return res.status(404).json({ error: 'NotFound', message: 'entry not found' })
    if (result === 'not_editable') return res.status(400).json({ error: 'BadRequest', message: 'this entry is managed by its source (a checklist tick, calendar event, or Health sync)' })
    return res.status(200).json({ goal: await goalDetail(tenant.householdId, id) })
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

  // Capture Tier 2: register the 'goal' mutate target (resolve + `log`) into the
  // capture registry from this startup seam.
  registerGoalCaptureTarget()
}
