// Lists domain — HTTP routes (/api/lists, /api/list-items, /api/lists/grocery,
// /api/pantry-staples). Logic in lists.service.ts; types in lists.types.ts.
import createAPI, { type Request, type Response } from 'lambda-api'
import { moduleRoutes } from '../../platform/route-guards'
import type { CreateListInput, PatchItemInput } from './lists.types'
import {
  getOrCreateGroceryList,
  listLists,
  getList,
  createList,
  updateList,
  softDeleteList,
  listItems,
  addItem,
  patchItem,
  softDeleteItem,
  addRecipeToGrocery,
  listPantryStaples,
  ensureDefaultStaples,
  addPantryStaple,
  removePantryStaple,
  rebuildGroceryFromWeek,
  groceryBoard,
  presentList,
  presentListItem,
} from './lists.service'

type Api = ReturnType<typeof createAPI>

// Every route here is gated by the optional `lists` module (403 when off).
const { tenantRoute } = moduleRoutes('lists')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function registerListRoutes(api: Api): void {
  // ---- the household's lists (sidebar) --------------------------------------
  api.get('/api/lists', tenantRoute(async (tenant) => {
    // Ensure the grocery list exists so it always shows in the rail.
    await getOrCreateGroceryList(tenant)
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
    const items = await listItems(tenant.householdId, id)
    return { list: presentList(list), items: items.map(presentListItem) }
  }))

  // Add an item to any list.
  api.post('/api/lists/:id/items', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    const list = await getList(tenant.householdId, id)
    if (!list) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    const body = (req.body ?? {}) as { name?: string; quantity?: string; category?: string; assignedTo?: string }
    if (!body.name || !body.name.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'name is required' })
    }
    const item = await addItem(tenant, id, {
      name: body.name.trim(),
      quantity: body.quantity ?? null,
      category: body.category ?? null,
      assignedTo: body.assignedTo ?? null,
    })
    return res.status(201).json({ item: presentListItem(item) })
  }))

  // ---- grocery list (unchanged; the Today dashboard depends on these) -------
  api.get('/api/lists/grocery', tenantRoute(async (tenant) => {
    const list = await getOrCreateGroceryList(tenant)
    const items = await listItems(tenant.householdId, list.id)
    return { list: presentList(list), items: items.map(presentListItem) }
  }))

  api.post('/api/lists/grocery/items', tenantRoute(async (tenant, req: Request, res: Response) => {
    const body = (req.body ?? {}) as { name?: string; quantity?: string; category?: string }
    if (!body.name || !body.name.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'name is required' })
    }
    const list = await getOrCreateGroceryList(tenant)
    const item = await addItem(tenant, list.id, {
      name: body.name.trim(),
      quantity: body.quantity ?? null,
      category: body.category ?? null,
    })
    return res.status(201).json({ item: presentListItem(item) })
  }))

  // ---- list items (shared across all lists) ---------------------------------
  // Check/uncheck, reassign, change quantity, or move section.
  api.patch('/api/list-items/:id', tenantRoute(async (tenant, req: Request, res: Response) => {
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'item not found' })
    const body = (req.body ?? {}) as PatchItemInput
    const known = ['checked', 'assignedTo', 'quantity', 'category', 'name']
    if (!known.some((k) => k in body)) {
      return res.status(400).json({ error: 'BadRequest', message: 'no patchable fields provided' })
    }
    if ('checked' in body && typeof body.checked !== 'boolean') {
      return res.status(400).json({ error: 'BadRequest', message: 'checked must be a boolean' })
    }
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
    const added = await addRecipeToGrocery(tenant, recipeId)
    if (added === null) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    return res.status(201).json({ added: added.length, items: added.map(presentListItem) })
  }))

  // ---- grocery board + auto-build + pantry staples --------------------------
  function weekStartParam(req: Request): string {
    const ws = (req.query?.weekStart as string | undefined) || ''
    if (/^\d{4}-\d{2}-\d{2}$/.test(ws)) return ws
    // default: the Sunday of the current week (server local)
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - d.getDay())
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  api.get('/api/lists/grocery/board', tenantRoute(async (tenant, req: Request) => {
    return groceryBoard(tenant, weekStartParam(req))
  }))

  api.post('/api/lists/grocery/rebuild', tenantRoute(async (tenant, req: Request) => {
    const weekStart = weekStartParam(req)
    const count = await rebuildGroceryFromWeek(tenant, weekStart)
    return { rebuilt: count, board: await groceryBoard(tenant, weekStart) }
  }))

  api.get('/api/pantry-staples', tenantRoute(async (tenant) => {
    await ensureDefaultStaples(tenant.householdId)
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
}
