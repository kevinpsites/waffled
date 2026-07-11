// Chores domain — HTTP routes (/api/chores, /api/chore-instances). Logic lives
// in chores.service.ts; types in chores.types.ts.
import createAPI, { type Request, type Response } from 'lambda-api'
import { requireCapability } from '../../platform/permissions'
import { moduleRoutes } from '../../platform/route-guards'
import type { CreateChoreInput } from './chores.types'
import {
  createChore,
  updateChore,
  softDeleteChore,
  requestedDate,
  todayDate,
  householdTz,
  ensureTodayInstances,
  todaySummary,
  upForGrabsCount,
  listTodayInstances,
  listAwaitingInstances,
  completeInstance,
  uncompleteInstance,
  claimInstance,
  setInstanceAssignee,
  approveInstance,
  rejectInstance,
  presentChore,
  presentInstance,
  UPDATABLE_CHORE,
  ProofRequiredError,
  listStoredProofs,
  deleteStoredProof,
  clearStoredProofs,
  getChoreRewardsEnabled,
  setChoreRewardsEnabled,
} from './chores.service'
import { getProofTtlDays, setProofTtlDays } from './chore-proof-cleanup.service'
import { assertPersonInHousehold } from '../../platform/household-refs'
import { mediaKeyBelongsToHousehold } from '../../platform/storage'

type Api = ReturnType<typeof createAPI>

// Every route here is gated by the optional `chores` module (403 when off).
const { tenantRoute, adminRoute, capRoute } = moduleRoutes('chores')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function registerChoreRoutes(api: Api): void {
  // Household chore settings — the photo-proof retention window and the rewards
  // sub-toggle (rewards is the spend half of the chores economy, not its own module).
  api.get('/api/chores/settings', tenantRoute(async (tenant) => ({
    proofTtlDays: await getProofTtlDays(tenant.householdId),
    rewards: await getChoreRewardsEnabled(tenant.householdId),
  })))

  api.put('/api/chores/settings', adminRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { proofTtlDays?: unknown; rewards?: unknown }
    // Both fields optional; accept either (or both) in one call.
    if (body.proofTtlDays !== undefined && (typeof body.proofTtlDays !== 'number' || !Number.isFinite(body.proofTtlDays) || body.proofTtlDays < 0)) {
      return res.status(400).json({ error: 'BadRequest', message: 'proofTtlDays must be a non-negative number' })
    }
    if (body.rewards !== undefined && typeof body.rewards !== 'boolean') {
      return res.status(400).json({ error: 'BadRequest', message: 'rewards must be a boolean' })
    }
    if (typeof body.proofTtlDays === 'number') await setProofTtlDays(tenant.householdId, body.proofTtlDays)
    if (typeof body.rewards === 'boolean') await setChoreRewardsEnabled(tenant.householdId, body.rewards)
    return {
      proofTtlDays: await getProofTtlDays(tenant.householdId),
      rewards: await getChoreRewardsEnabled(tenant.householdId),
    }
  }))

  // Stored proof photos — the review/manage surface (admins). A separate path from
  // /api/chores/:id so the collection DELETE (clear-all) can't be read as :id.
  api.get('/api/chore-proofs', adminRoute(async (tenant) => ({
    proofs: await listStoredProofs(tenant.householdId),
  })))

  api.delete('/api/chore-proofs/:id', adminRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'proof not found' })
    const ok = await deleteStoredProof(tenant.householdId, id)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'proof not found' })
    return res.status(204).send('')
  }))

  api.delete('/api/chore-proofs', adminRoute(async (tenant) => ({
    cleared: await clearStoredProofs(tenant.householdId),
  })))

  // Create a chore. Carving the family up takes 'chore.manage', but anyone can add
  // a chore that's up-for-grabs (no assignee) or one for themselves — no gate there.
  api.post('/api/chores', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as Partial<CreateChoreInput>
    if (!body.title || !body.title.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'title is required' })
    }
    if (body.personId != null) {
      if (!UUID_RE.test(body.personId)) {
        return res.status(400).json({ error: 'BadRequest', message: 'valid personId required' })
      }
      await assertPersonInHousehold(tenant.householdId, body.personId)
    }
    if (body.personId != null && body.personId !== tenant.personId) {
      await requireCapability(tenant, 'chore.manage')
    }
    const chore = await createChore(tenant, { ...body, title: body.title.trim() })
    return res.status(201).json({ chore: presentChore(chore) })
  }))

  // Edit a chore definition (chore.manage).
  api.patch('/api/chores/:id', capRoute('chore.manage', async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'chore not found' })
    const patch = (req.body ?? {}) as Record<string, unknown>
    if (typeof patch.title === 'string' && !patch.title.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'title cannot be empty' })
    }
    if (patch.personId != null) {
      if (typeof patch.personId !== 'string' || !UUID_RE.test(patch.personId)) {
        return res.status(400).json({ error: 'BadRequest', message: 'valid personId required' })
      }
      await assertPersonInHousehold(tenant.householdId, patch.personId)
    }
    if (!Object.keys(UPDATABLE_CHORE).some((field) => field in patch)) {
      return res.status(400).json({ error: 'BadRequest', message: 'no updatable fields provided' })
    }
    const chore = await updateChore(tenant.householdId, id, patch)
    if (!chore) return res.status(404).json({ error: 'NotFound', message: 'chore not found' })
    return { chore: presentChore(chore) }
  }))

  // Delete a chore (chore.manage). Hides it + today's instances from the Tasks view.
  api.delete('/api/chores/:id', capRoute('chore.manage', async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'chore not found' })
    const ok = await softDeleteChore(tenant.householdId, id)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'chore not found' })
    return res.status(204).send('')
  }))

  // Per-person chore summary (rings + stars) for a day (default today, household-local).
  api.get('/api/chores/today', tenantRoute(async (tenant, req: Request) => {
    const tz = await householdTz(tenant.householdId)
    const date = requestedDate(req.query?.date, todayDate(tz))
    await ensureTodayInstances(tenant.householdId, date)
    const [people, upForGrabs] = await Promise.all([
      todaySummary(tenant.householdId, date, tz),
      upForGrabsCount(tenant.householdId, date, tz),
    ])
    return { date, people, upForGrabs }
  }))

  // Individual chore instances (the Tasks list) for a day. `?date=YYYY-MM-DD`
  // (within ±31 days) lets the Tasks screen look ahead; defaults to today (local).
  api.get('/api/chore-instances/today', tenantRoute(async (tenant, req: Request) => {
    const tz = await householdTz(tenant.householdId)
    const date = requestedDate(req.query?.date, todayDate(tz))
    await ensureTodayInstances(tenant.householdId, date)
    const instances = await listTodayInstances(tenant.householdId, date, tz)
    return { date, instances }
  }))

  // All chore completions awaiting a parent's OK, across dates — for the mobile
  // approvals queue (the date-scoped lists above miss ones from earlier days).
  // Read-only; approval/rejection still goes through the :id endpoints below.
  api.get('/api/chore-instances/awaiting', tenantRoute(async (tenant) => ({
    instances: await listAwaitingInstances(tenant.householdId),
  })))

  // Complete / uncomplete an instance (any member can; e.g. a parent on the kiosk).
  api.post('/api/chore-instances/:id/complete', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    const body = (req.body ?? {}) as { storageKey?: unknown; contentType?: unknown }
    if (body.storageKey != null && (
      typeof body.storageKey !== 'string' ||
      !mediaKeyBelongsToHousehold(body.storageKey, tenant.householdId)
    )) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid proof image key' })
    }
    const proof = {
      storageKey: typeof body.storageKey === 'string' ? body.storageKey : null,
      contentType: typeof body.contentType === 'string' ? body.contentType : null,
    }
    try {
      const inst = await completeInstance(tenant, id, proof)
      if (!inst) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
      return { instance: presentInstance(inst) }
    } catch (err) {
      if (err instanceof ProofRequiredError) {
        return res.status(422).json({ error: 'ProofRequired', message: err.message })
      }
      throw err
    }
  }))

  api.post('/api/chore-instances/:id/uncomplete', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    const inst = await uncompleteInstance(tenant, id)
    if (!inst) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    return { instance: presentInstance(inst) }
  }))

  // Claim an up-for-grabs instance for a person (default: the caller). 409 if
  // someone already grabbed it.
  api.post('/api/chore-instances/:id/claim', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    const personId = ((req.body ?? {}) as { personId?: string }).personId?.trim() || tenant.personId
    if (!UUID_RE.test(personId)) return res.status(400).json({ error: 'BadRequest', message: 'valid personId required' })
    await assertPersonInHousehold(tenant.householdId, personId)
    const inst = await claimInstance(tenant, id, personId)
    if (!inst) return res.status(409).json({ error: 'Conflict', message: 'already claimed or not found' })
    return { instance: presentInstance(inst) }
  }))

  // Reassign an instance to another person, or unassign it back to up-for-grabs
  // (personId null/empty). Powers the board's drag-and-drop between columns.
  api.post('/api/chore-instances/:id/assign', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    const raw = ((req.body ?? {}) as { personId?: string | null }).personId
    let personId: string | null
    if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
      personId = null
    } else {
      personId = String(raw).trim()
      if (!UUID_RE.test(personId)) return res.status(400).json({ error: 'BadRequest', message: 'valid personId required' })
      await assertPersonInHousehold(tenant.householdId, personId)
    }
    // Assigning a chore to ANOTHER person needs chore.manage. Releasing it to
    // up-for-grabs (null) or taking it yourself stays open — that's just
    // claiming, which any member may do.
    if (personId !== null && personId !== tenant.personId) {
      await requireCapability(tenant, 'chore.manage')
    }
    const inst = await setInstanceAssignee(tenant, id, personId)
    if (!inst) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    return { instance: presentInstance(inst) }
  }))

  // Parent approves a submitted (awaiting) chore → done + award stars (chore.approve).
  api.post('/api/chore-instances/:id/approve', capRoute('chore.approve', async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    const inst = await approveInstance(tenant, id)
    if (!inst) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    return { instance: presentInstance(inst) }
  }))

  // Parent rejects a submitted chore → back to pending for a redo (chore.approve).
  api.post('/api/chore-instances/:id/reject', capRoute('chore.approve', async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    const inst = await rejectInstance(tenant, id)
    if (!inst) return res.status(409).json({ error: 'Conflict', message: 'not awaiting approval' })
    return { instance: presentInstance(inst) }
  }))
}
