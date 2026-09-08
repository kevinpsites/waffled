// Lists domain — HTTP routes (/api/lists, /api/list-items, /api/lists/grocery,
// /api/pantry-staples). Logic in lists.service.ts; types in lists.types.ts.
import createAPI, { type Request, type Response } from 'lambda-api'
import { moduleRoutes } from '../../platform/route-guards'
import { assertPersonInHousehold } from '../../platform/household-refs'
import { registerListItemCaptureTarget } from './lists-capture'
import type { CreateListInput, PatchItemInput } from './lists.types'
import {
  getOrCreateGroceryList,
  findGroceryList,
  listLists,
  getList,
  createList,
  updateList,
  softDeleteList,
  listItems,
  addItem,
  patchItem,
  softDeleteItem,
  bulkPatchItems,
  listStores,
  autoClearCheckedItems,
  clearCompletedItems,
  addRecipeToGrocery,
  removeRecipeFromGrocery,
  convertToTemplate,
  convertToList,
  applyTemplate,
  listTemplates,
  listPantryStaples,
  ensureDefaultStaples,
  addPantryStaple,
  removePantryStaple,
  rebuildGroceryFromWeek,
  clearGroceryChecks,
  groceryBoard,
  householdWeekStart,
  householdWeekStartFor,
  parseWeekStartParam,
  presentList,
  presentListItem,
} from './lists.service'

type Api = ReturnType<typeof createAPI>

// Every route here is gated by the optional `lists` module (403 when off).
const { tenantRoute } = moduleRoutes('lists')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Priority is a 1–5 urgency scale: 1 = not urgent, 3 = normal, 5 = urgent.
function isValidPriority(v: unknown): v is 1 | 2 | 3 | 4 | 5 {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5
}

export function registerListRoutes(api: Api): void {
  // ---- the household's lists (sidebar) --------------------------------------
  api.get('/api/lists', tenantRoute(async (tenant) => {
    // Ensure the grocery list exists so it always shows in the rail.
    if (tenant.memberType !== 'guest') await getOrCreateGroceryList(tenant)
    return { lists: await listLists(tenant.householdId) }
  }))

  api.post('/api/lists', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as Partial<CreateListInput>
    if (!body.name || !body.name.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'name is required' })
    }
    const list = await createList(tenant, { ...body, name: body.name.trim() } as CreateListInput)
    return res.status(201).json({ list: presentList(list) })
  }))

  // ---- list templates (save-as-template / apply) ----------------------------
  // Registered before the `/api/lists/:id` routes so the literal `templates`
  // segment wins over the `:id` param.

  // The household's saved templates (hidden from the normal rail).
  api.get('/api/lists/templates', tenantRoute(async (tenant) => {
    return { templates: await listTemplates(tenant.householdId) }
  }))

  // A template + its (always-unchecked) items.
  api.get('/api/lists/templates/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'template not found' })
    const tpl = await getList(tenant.householdId, id)
    if (!tpl || tpl.list_type !== 'template') return res.status(404).json({ error: 'NotFound', message: 'template not found' })
    const items = await listItems(tenant.householdId, id)
    return { template: presentList(tpl), items: items.map(presentListItem) }
  }))

  // Mark a list as a reusable template — converts it in place (it leaves the
  // active rail and becomes the single editable template).
  api.post('/api/lists/:id/save-as-template', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    const template = await convertToTemplate(tenant.householdId, id)
    if (!template) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    return res.status(201).json({ template: presentList(template) })
  }))

  // Move a template back into the active Lists rail (undo a convert).
  api.post('/api/lists/:id/unmark-template', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'template not found' })
    const list = await convertToList(tenant.householdId, id)
    if (!list) return res.status(404).json({ error: 'NotFound', message: 'template not found' })
    return res.status(201).json({ list: presentList(list) })
  }))

  // Apply a template → a fresh custom list with everything unchecked.
  api.post('/api/lists/templates/:id/apply', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'template not found' })
    const name = ((req.body ?? {}) as { name?: string }).name
    const list = await applyTemplate(tenant, id, name)
    if (!list) return res.status(404).json({ error: 'NotFound', message: 'template not found' })
    return res.status(201).json({ list: presentList(list) })
  }))

  // The household's previously-used store names (most-used first) — the durable
  // quick-select for a grocery item's store field. Registered before `/api/lists/:id`
  // so the literal `stores` segment wins over the id param.
  api.get('/api/lists/stores', tenantRoute(async (tenant) => {
    return { stores: await listStores(tenant.householdId) }
  }))

  api.patch('/api/lists/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    const body = (req.body ?? {}) as { name?: string; emoji?: string | null }
    if (typeof body.name === 'string' && !body.name.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'name cannot be empty' })
    }
    const patch: { name?: string; emoji?: string | null } = {}
    if (typeof body.name === 'string') patch.name = body.name.trim()
    if ('emoji' in body) patch.emoji = body.emoji ?? null
    const list = await updateList(tenant.householdId, id, patch)
    if (!list) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    return { list: presentList(list) }
  }))

  api.delete('/api/lists/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    const ok = await softDeleteList(tenant.householdId, id)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    return res.status(204).send('')
  }))

  // A list + its items grouped by section (CLOTHES / GEAR / …).
  api.get('/api/lists/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    const list = await getList(tenant.householdId, id)
    if (!list) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    // Lazily sweep old checked items off a custom list before we read it (no cron):
    // a no-op for grocery/templates (scoped to list_type='custom' in the query).
    if (tenant.memberType !== 'guest') await autoClearCheckedItems(tenant.householdId, id)
    const items = await listItems(tenant.householdId, id)
    return { list: presentList(list), items: items.map(presentListItem) }
  }))

  // Clear a custom list's Completed section now (soft-delete its checked items).
  api.post('/api/lists/:id/clear-completed', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    const list = await getList(tenant.householdId, id)
    if (!list) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    const cleared = await clearCompletedItems(tenant.householdId, id)
    return { cleared }
  }))

  // Add an item to any list.
  api.post('/api/lists/:id/items', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    const list = await getList(tenant.householdId, id)
    if (!list) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    const body = (req.body ?? {}) as { name?: string; quantity?: string; category?: string; store?: string; assignedTo?: string; priority?: number }
    if (!body.name || !body.name.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'name is required' })
    }
    if ('priority' in body && !isValidPriority(body.priority)) {
      return res.status(400).json({ error: 'BadRequest', message: 'priority must be an integer from 1 (not urgent) to 5 (urgent)' })
    }
    if (body.assignedTo != null) await assertPersonInHousehold(tenant.householdId, body.assignedTo)
    const item = await addItem(tenant, id, {
      name: body.name.trim(),
      quantity: body.quantity ?? null,
      category: body.category ?? null,
      store: body.store ?? null,
      assignedTo: body.assignedTo ?? null,
      priority: body.priority,
    })
    return res.status(201).json({ item: presentListItem(item) })
  }))

  // ---- grocery list (unchanged; the Today dashboard depends on these) -------
  api.get('/api/lists/grocery', tenantRoute(async (tenant, _req: Request, res: Response) => {
    const list = tenant.memberType === 'guest'
      ? await findGroceryList(tenant.householdId)
      : await getOrCreateGroceryList(tenant)
    if (!list) return res.status(404).json({ error: 'NotFound', message: 'grocery list not found' })
    const items = await listItems(tenant.householdId, list.id)
    return { list: presentList(list), items: items.map(presentListItem) }
  }))

  api.post('/api/lists/grocery/items', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { name?: string; quantity?: string; category?: string; store?: string }
    if (!body.name || !body.name.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'name is required' })
    }
    const list = await getOrCreateGroceryList(tenant)
    const item = await addItem(tenant, list.id, {
      name: body.name.trim(),
      quantity: body.quantity ?? null,
      category: body.category ?? null,
      store: body.store ?? null,
    })
    return res.status(201).json({ item: presentListItem(item) })
  }))

  // ---- list items (shared across all lists) ---------------------------------
  // Bulk-edit section / assignee / priority across a multi-selection. Registered
  // before `/api/list-items/:id` so the literal `bulk` segment wins over `:id`.
  api.patch('/api/list-items/bulk', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { ids?: unknown; patch?: Record<string, unknown> }
    const ids = body.ids
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x) => typeof x === 'string' && UUID_RE.test(x))) {
      return res.status(400).json({ error: 'BadRequest', message: 'ids must be a non-empty array of item ids' })
    }
    const p = (body.patch ?? {}) as { section?: string | null; category?: string | null; store?: string | null; assignedTo?: string | null; priority?: number }
    const patch: { category?: string | null; store?: string | null; assignedTo?: string | null; priority?: number } = {}
    // `section` is the client-facing key; `category` is a legacy alias for the same
    // column. Apply the alias first so that if both are ever sent, `section` wins.
    if ('category' in p) patch.category = p.category ?? null
    if ('section' in p) patch.category = p.section ?? null
    if ('store' in p) patch.store = p.store ?? null
    if ('assignedTo' in p) patch.assignedTo = p.assignedTo ?? null
    if ('priority' in p) {
      if (!isValidPriority(p.priority)) {
        return res.status(400).json({ error: 'BadRequest', message: 'priority must be an integer from 1 (not urgent) to 5 (urgent)' })
      }
      patch.priority = p.priority
    }
    if (!('category' in patch) && !('store' in patch) && !('assignedTo' in patch) && !('priority' in patch)) {
      return res.status(400).json({ error: 'BadRequest', message: 'no patchable fields provided' })
    }
    if (patch.assignedTo != null) await assertPersonInHousehold(tenant.householdId, patch.assignedTo)
    const updated = await bulkPatchItems(tenant.householdId, ids as string[], patch)
    return { updated }
  }))

  // Check/uncheck, reassign, change quantity, or move section.
  api.patch('/api/list-items/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'item not found' })
    const body = (req.body ?? {}) as PatchItemInput
    const known = ['checked', 'assignedTo', 'quantity', 'category', 'store', 'priority', 'name']
    if (!known.some((k) => k in body)) {
      return res.status(400).json({ error: 'BadRequest', message: 'no patchable fields provided' })
    }
    if ('checked' in body && typeof body.checked !== 'boolean') {
      return res.status(400).json({ error: 'BadRequest', message: 'checked must be a boolean' })
    }
    if ('priority' in body && !isValidPriority(body.priority)) {
      return res.status(400).json({ error: 'BadRequest', message: 'priority must be an integer from 1 (not urgent) to 5 (urgent)' })
    }
    if (body.assignedTo != null) await assertPersonInHousehold(tenant.householdId, body.assignedTo)
    const item = await patchItem(tenant, id, body)
    if (!item) return res.status(404).json({ error: 'NotFound', message: 'item not found' })
    return { item: presentListItem(item) }
  }))

  // Remove an item (soft-delete).
  api.delete('/api/list-items/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'item not found' })
    const ok = await softDeleteItem(tenant.householdId, id)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'item not found' })
    return res.status(204).send('')
  }))

  // Add a recipe's ingredients to the grocery list (the meal card's "To list").
  api.post('/api/lists/grocery/from-recipe/:recipeId', tenantRoute(async (tenant, req: Request, res: Response) => {
    const recipeId = req.params.recipeId ?? ''
    if (!UUID_RE.test(recipeId)) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    // Optional subset: the "choose specific ingredients" picker sends the ids to add;
    // omitting it keeps the original add-all-non-staples behavior.
    const body = (req.body ?? {}) as { ingredientIds?: unknown }
    let ingredientIds: string[] | undefined
    if ('ingredientIds' in body && body.ingredientIds != null) {
      if (!Array.isArray(body.ingredientIds) || !body.ingredientIds.every((v) => typeof v === 'string' && UUID_RE.test(v))) {
        return res.status(400).json({ error: 'BadRequest', message: 'ingredientIds must be an array of ingredient ids' })
      }
      ingredientIds = body.ingredientIds as string[]
    }
    const added = await addRecipeToGrocery(tenant, recipeId, await weekStartFor(tenant, req), ingredientIds)
    if (added === null) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    return res.status(201).json({ added: added.length, items: added.map(presentListItem) })
  }))

  // Take a recipe's ingredients back off the grocery list (undo the off-plan add;
  // removes it from the by-meal "Unscheduled" group).
  api.delete('/api/lists/grocery/from-recipe/:recipeId', tenantRoute(async (tenant, req: Request, res: Response) => {
    const recipeId = req.params.recipeId ?? ''
    if (!UUID_RE.test(recipeId)) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    const removed = await removeRecipeFromGrocery(tenant, recipeId, await weekStartFor(tenant, req))
    if (removed === null) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    return res.status(200).json({ removed })
  }))

  // ---- grocery board + auto-build + pantry staples --------------------------
  // The week to operate on: the household week CONTAINING an explicit
  // ?weekStart=YYYY-MM-DD, else its current week (both honoring first-day-of-week +
  // timezone). Household-aware so it matches what the clients render for "this week" —
  // and the 0088 backfill.
  //
  // The snap is the point, not a nicety: grocery rows are keyed by week start and the
  // board only ever asks for week starts, so accepting the caller's date verbatim writes
  // rows onto a key no board will ever query. "Plan the month" did exactly that with the
  // 1st of the month (a Tuesday in Sep 2026) and the whole list came back empty.
  async function weekStartFor(tenant: { householdId: string }, req: Request): Promise<string> {
    const ws = parseWeekStartParam(req.query?.weekStart)
    return ws === null ? householdWeekStart(tenant.householdId) : householdWeekStartFor(tenant.householdId, ws)
  }

  api.get('/api/lists/grocery/board', tenantRoute(async (tenant, req: Request, res: Response) => {
    const board = await groceryBoard(tenant, await weekStartFor(tenant, req), tenant.memberType !== 'guest')
    if (!board) return res.status(404).json({ error: 'NotFound', message: 'grocery list not found' })
    return board
  }))

  api.post('/api/lists/grocery/rebuild', tenantRoute(async (tenant, req: Request) => {
    const weekStart = await weekStartFor(tenant, req)
    const count = await rebuildGroceryFromWeek(tenant, weekStart)
    return { rebuilt: count, board: await groceryBoard(tenant, weekStart) }
  }))

  // "Start over": un-check everything on the week's list (Refresh keeps checks instead).
  api.post('/api/lists/grocery/clear-checks', tenantRoute(async (tenant, req: Request) => {
    const weekStart = await weekStartFor(tenant, req)
    const cleared = await clearGroceryChecks(tenant, weekStart)
    return { cleared, board: await groceryBoard(tenant, weekStart) }
  }))

  api.get('/api/pantry-staples', tenantRoute(async (tenant) => {
    if (tenant.memberType !== 'guest') await ensureDefaultStaples(tenant.householdId)
    return { staples: await listPantryStaples(tenant.householdId) }
  }))

  api.post('/api/pantry-staples', tenantRoute(async (tenant, req: Request, res: Response) => {
    const name = ((req.body ?? {}) as { name?: string }).name?.trim()
    if (!name) return res.status(400).json({ error: 'BadRequest', message: 'name is required' })
    return res.status(201).json({ staple: await addPantryStaple(tenant.householdId, name) })
  }))

  api.delete('/api/pantry-staples/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'staple not found' })
    const ok = await removePantryStaple(tenant.householdId, id)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'staple not found' })
    return res.status(204).send('')
  }))

  // Register the listItem capture target (Tier 2 mutate: complete/delete) into the
  // capture registry so /api/capture/{resolve,commit} can dispatch to it.
  registerListItemCaptureTarget()
}
