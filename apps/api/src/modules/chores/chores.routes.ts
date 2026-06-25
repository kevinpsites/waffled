// Chores domain — HTTP routes (/api/chores, /api/chore-instances). Logic lives
// in chores.service.ts; types in chores.types.ts.
import createAPI, { type Request, type Response } from 'lambda-api'
import { requireTenant, requireAdmin } from '../households/households'
import { requireCapability } from '../../platform/permissions'
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
} from './chores.service'
import { getProofTtlDays, setProofTtlDays } from './chore-proof-cleanup.service'

type Api = ReturnType<typeof createAPI>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function registerChoreRoutes(api: Api): void {
  // Household chore settings — currently just the photo-proof retention window.
  api.get('/api/chores/settings', async (req: Request) => {
    const tenant = await requireTenant(req)
    return { proofTtlDays: await getProofTtlDays(tenant.householdId) }
  })

  api.put('/api/chores/settings', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const body = (req.body ?? {}) as { proofTtlDays?: unknown }
    if (typeof body.proofTtlDays !== 'number' || !Number.isFinite(body.proofTtlDays) || body.proofTtlDays < 0) {
      return res.status(400).json({ error: 'BadRequest', message: 'proofTtlDays must be a non-negative number' })
    }
    return { proofTtlDays: await setProofTtlDays(tenant.householdId, body.proofTtlDays) }
  })

  // Stored proof photos — the review/manage surface (admins). A separate path from
  // /api/chores/:id so the collection DELETE (clear-all) can't be read as :id.
  api.get('/api/chore-proofs', async (req: Request) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    return { proofs: await listStoredProofs(tenant.householdId) }
  })

  api.delete('/api/chore-proofs/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'proof not found' })
    const ok = await deleteStoredProof(tenant.householdId, id)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'proof not found' })
    return res.status(204).send('')
  })

  api.delete('/api/chore-proofs', async (req: Request) => {
    const tenant = await requireTenant(req)
    requireAdmin(tenant)
    return { cleared: await clearStoredProofs(tenant.householdId) }
  })

  // Create a chore. Carving the family up takes 'chore.manage', but anyone can add
  // a chore that's up-for-grabs (no assignee) or one for themselves — no gate there.
  api.post('/api/chores', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const body = (req.body ?? {}) as Partial<CreateChoreInput>
    if (body.personId != null && body.personId !== tenant.personId) {
      await requireCapability(tenant, 'chore.manage')
    }
    if (!body.title || !body.title.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'title is required' })
    }
    const chore = await createChore(tenant, { ...body, title: body.title.trim() })
    return res.status(201).json({ chore: presentChore(chore) })
  })

  // Edit a chore definition (chore.manage).
  api.patch('/api/chores/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    await requireCapability(tenant, 'chore.manage')
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'chore not found' })
    const patch = (req.body ?? {}) as Record<string, unknown>
    if (typeof patch.title === 'string' && !patch.title.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'title cannot be empty' })
    }
    if (!Object.keys(UPDATABLE_CHORE).some((field) => field in patch)) {
      return res.status(400).json({ error: 'BadRequest', message: 'no updatable fields provided' })
    }
    const chore = await updateChore(tenant.householdId, id, patch)
    if (!chore) return res.status(404).json({ error: 'NotFound', message: 'chore not found' })
    return { chore: presentChore(chore) }
  })

  // Delete a chore (chore.manage). Hides it + today's instances from the Tasks view.
  api.delete('/api/chores/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    await requireCapability(tenant, 'chore.manage')
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'chore not found' })
    const ok = await softDeleteChore(tenant.householdId, id)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'chore not found' })
    return res.status(204).send('')
  })

  // Per-person chore summary (rings + stars) for a day (default today, household-local).
  api.get('/api/chores/today', async (req: Request) => {
    const tenant = await requireTenant(req)
    const date = requestedDate(req.query?.date, todayDate(await householdTz(tenant.householdId)))
    await ensureTodayInstances(tenant.householdId, date)
    const people = await todaySummary(tenant.householdId, date)
    return { date, people }
  })

  // Individual chore instances (the Tasks list) for a day. `?date=YYYY-MM-DD`
  // (within ±31 days) lets the Tasks screen look ahead; defaults to today (local).
  api.get('/api/chore-instances/today', async (req: Request) => {
    const tenant = await requireTenant(req)
    const date = requestedDate(req.query?.date, todayDate(await householdTz(tenant.householdId)))
    await ensureTodayInstances(tenant.householdId, date)
    const instances = await listTodayInstances(tenant.householdId, date)
    return { date, instances }
  })

  // All chore completions awaiting a parent's OK, across dates — for the mobile
  // approvals queue (the date-scoped lists above miss ones from earlier days).
  // Read-only; approval/rejection still goes through the :id endpoints below.
  api.get('/api/chore-instances/awaiting', async (req: Request) => {
    const tenant = await requireTenant(req)
    const instances = await listAwaitingInstances(tenant.householdId)
    return { instances }
  })

  // Complete / uncomplete an instance (any member can; e.g. a parent on the kiosk).
  api.post('/api/chore-instances/:id/complete', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    const body = (req.body ?? {}) as { storageKey?: unknown; contentType?: unknown }
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
  })

  api.post('/api/chore-instances/:id/uncomplete', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    const inst = await uncompleteInstance(tenant, id)
    if (!inst) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    return { instance: presentInstance(inst) }
  })

  // Claim an up-for-grabs instance for a person (default: the caller). 409 if
  // someone already grabbed it.
  api.post('/api/chore-instances/:id/claim', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    const personId = ((req.body ?? {}) as { personId?: string }).personId?.trim() || tenant.personId
    if (!UUID_RE.test(personId)) return res.status(400).json({ error: 'BadRequest', message: 'valid personId required' })
    const inst = await claimInstance(tenant, id, personId)
    if (!inst) return res.status(409).json({ error: 'Conflict', message: 'already claimed or not found' })
    return { instance: presentInstance(inst) }
  })

  // Reassign an instance to another person, or unassign it back to up-for-grabs
  // (personId null/empty). Powers the board's drag-and-drop between columns.
  api.post('/api/chore-instances/:id/assign', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    const raw = ((req.body ?? {}) as { personId?: string | null }).personId
    let personId: string | null
    if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
      personId = null
    } else {
      personId = String(raw).trim()
      if (!UUID_RE.test(personId)) return res.status(400).json({ error: 'BadRequest', message: 'valid personId required' })
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
  })

  // Parent approves a submitted (awaiting) chore → done + award stars (chore.approve).
  api.post('/api/chore-instances/:id/approve', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    await requireCapability(tenant, 'chore.approve')
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    const inst = await approveInstance(tenant, id)
    if (!inst) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    return { instance: presentInstance(inst) }
  })

  // Parent rejects a submitted chore → back to pending for a redo (chore.approve).
  api.post('/api/chore-instances/:id/reject', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    await requireCapability(tenant, 'chore.approve')
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'instance not found' })
    const inst = await rejectInstance(tenant, id)
    if (!inst) return res.status(409).json({ error: 'Conflict', message: 'not awaiting approval' })
    return { instance: presentInstance(inst) }
  })
}
