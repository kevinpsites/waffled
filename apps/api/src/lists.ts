// Lists domain — matches the handoff Lists mock (multi-list, parameterized).
// The household has many named lists (Groceries, Lake trip packing, Target run,
// Costco, …) each with an emoji + live item count. Items carry a section
// (CLOTHES / GEAR / FOR THE KIDS via `category`), a freeform quantity ("×4"),
// an assignee (avatar) and a checked state. The grocery list keeps its existing
// get-or-create endpoints (the Today dashboard's Grocery card depends on them).
import createAPI, { type Request, type Response } from 'lambda-api'
import type { QueryResultRow } from 'pg'
import { query } from './db'
import { requireTenant, type Tenant } from './households'
import { getRecipe, listIngredients } from './meals'

type Api = ReturnType<typeof createAPI>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ListRow extends QueryResultRow {
  id: string
  name: string
  emoji: string | null
  list_type: string
  is_auto_built: boolean
  sort_mode: string
}

export interface ListItemRow extends QueryResultRow {
  id: string
  name: string
  quantity: string | null
  checked: boolean
  checked_at: Date | null
  category: string | null
  sort_order: number | null
  assigned_to: string | null
  assignee_name?: string | null
  assignee_avatar?: string | null
  assignee_color?: string | null
}

export async function getOrCreateGroceryList(tenant: Tenant): Promise<ListRow> {
  const found = await query<ListRow>(
    `select * from lists
       where household_id = $1 and list_type = 'grocery' and deleted_at is null
       order by created_at limit 1`,
    [tenant.householdId]
  )
  if (found.rows[0]) return found.rows[0]
  const created = await query<ListRow>(
    `insert into lists (household_id, name, emoji, list_type, is_auto_built, created_by)
     values ($1, 'Grocery', '🛒', 'grocery', false, $2)
     returning *`,
    [tenant.householdId, tenant.personId]
  )
  return created.rows[0]
}

// All of the household's lists with their live (unchecked-or-not) item count.
export async function listLists(householdId: string) {
  const { rows } = await query<ListRow & { item_count: string }>(
    `select l.id, l.name, l.emoji, l.list_type, l.is_auto_built, l.sort_mode,
            (select count(*) from list_items i
              where i.list_id = l.id and i.deleted_at is null) as item_count
       from lists l
      where l.household_id = $1 and l.deleted_at is null
      order by (l.list_type = 'grocery') desc, l.sort_order, l.created_at`,
    [householdId]
  )
  return rows.map((r) => ({ ...presentList(r), itemCount: Number(r.item_count) }))
}

export async function getList(householdId: string, id: string): Promise<ListRow | null> {
  const { rows } = await query<ListRow>(
    `select * from lists where household_id = $1 and id = $2 and deleted_at is null`,
    [householdId, id]
  )
  return rows[0] ?? null
}

export interface CreateListInput {
  name: string
  emoji?: string | null
  sortOrder?: number
}

export async function createList(tenant: Tenant, input: CreateListInput): Promise<ListRow> {
  const { rows } = await query<ListRow>(
    `insert into lists (household_id, name, emoji, list_type, is_auto_built, sort_order, created_by)
     values ($1, $2, $3, 'custom', false, coalesce($4, 0), $5)
     returning *`,
    [tenant.householdId, input.name, input.emoji ?? null, input.sortOrder ?? null, tenant.personId]
  )
  return rows[0]
}

export async function updateList(
  householdId: string,
  id: string,
  patch: { name?: string; emoji?: string | null }
): Promise<ListRow | null> {
  const sets: string[] = []
  const vals: unknown[] = []
  let i = 1
  if (typeof patch.name === 'string') {
    sets.push(`name = $${i++}`)
    vals.push(patch.name)
  }
  if ('emoji' in patch) {
    sets.push(`emoji = $${i++}`)
    vals.push(patch.emoji ?? null)
  }
  if (sets.length === 0) return getList(householdId, id)
  vals.push(householdId, id)
  const { rows } = await query<ListRow>(
    `update lists set ${sets.join(', ')}
      where household_id = $${i++} and id = $${i++} and deleted_at is null
      returning *`,
    vals
  )
  return rows[0] ?? null
}

export async function softDeleteList(householdId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `update lists set deleted_at = now()
       where household_id = $1 and id = $2 and deleted_at is null`,
    [householdId, id]
  )
  return !!rowCount
}

export async function listItems(householdId: string, listId: string): Promise<ListItemRow[]> {
  const { rows } = await query<ListItemRow>(
    `select i.*, p.name as assignee_name, p.avatar_emoji as assignee_avatar, p.color_hex as assignee_color
       from list_items i
       left join persons p on p.id = i.assigned_to and p.deleted_at is null
      where i.household_id = $1 and i.list_id = $2 and i.deleted_at is null
      order by i.checked, i.sort_order nulls last, i.created_at`,
    [householdId, listId]
  )
  return rows
}

export async function addItem(
  tenant: Tenant,
  listId: string,
  input: { name: string; quantity?: string | null; category?: string | null; assignedTo?: string | null }
): Promise<ListItemRow> {
  const { rows } = await query<ListItemRow>(
    `with ins as (
       insert into list_items (household_id, list_id, name, quantity, category, assigned_to, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning *
     )
     select ins.*, p.name as assignee_name, p.avatar_emoji as assignee_avatar, p.color_hex as assignee_color
       from ins left join persons p on p.id = ins.assigned_to and p.deleted_at is null`,
    [
      tenant.householdId,
      listId,
      input.name,
      input.quantity ?? null,
      input.category ?? null,
      input.assignedTo ?? null,
      tenant.personId,
    ]
  )
  return rows[0]
}

// Toggle an item's checked state (records who/when). Household-scoped; null if
// no such live item in this household.
export async function setItemChecked(
  tenant: Tenant,
  id: string,
  checked: boolean
): Promise<ListItemRow | null> {
  const { rows } = await query<ListItemRow>(
    `with upd as (
       update list_items
          set checked = $1,
              checked_at = case when $1 then now() else null end,
              checked_by = case when $1 then $2::uuid else null end
        where household_id = $3 and id = $4 and deleted_at is null
        returning *
     )
     select upd.*, p.name as assignee_name, p.avatar_emoji as assignee_avatar, p.color_hex as assignee_color
       from upd left join persons p on p.id = upd.assigned_to and p.deleted_at is null`,
    [checked, tenant.personId, tenant.householdId, id]
  )
  return rows[0] ?? null
}

// Patch an item — check/uncheck, reassign, change quantity, or move section.
// Any subset of fields may be present.
export interface PatchItemInput {
  checked?: boolean
  assignedTo?: string | null
  quantity?: string | null
  category?: string | null
  name?: string
}

export async function patchItem(
  tenant: Tenant,
  id: string,
  patch: PatchItemInput
): Promise<ListItemRow | null> {
  const sets: string[] = []
  const vals: unknown[] = []
  let i = 1
  if (typeof patch.checked === 'boolean') {
    sets.push(`checked = $${i++}`)
    vals.push(patch.checked)
    sets.push(`checked_at = case when $${i - 1} then now() else null end`)
    sets.push(`checked_by = case when $${i - 1} then $${i++}::uuid else null end`)
    vals.push(tenant.personId)
  }
  if ('assignedTo' in patch) {
    sets.push(`assigned_to = $${i++}`)
    vals.push(patch.assignedTo ?? null)
  }
  if ('quantity' in patch) {
    sets.push(`quantity = $${i++}`)
    vals.push(patch.quantity ?? null)
  }
  if ('category' in patch) {
    sets.push(`category = $${i++}`)
    vals.push(patch.category ?? null)
  }
  if (typeof patch.name === 'string') {
    sets.push(`name = $${i++}`)
    vals.push(patch.name)
  }
  if (sets.length === 0) {
    const cur = await listItemById(tenant.householdId, id)
    return cur
  }
  vals.push(tenant.householdId, id)
  const { rows } = await query<ListItemRow>(
    `with upd as (
       update list_items set ${sets.join(', ')}
        where household_id = $${i++} and id = $${i++} and deleted_at is null
        returning *
     )
     select upd.*, p.name as assignee_name, p.avatar_emoji as assignee_avatar, p.color_hex as assignee_color
       from upd left join persons p on p.id = upd.assigned_to and p.deleted_at is null`,
    vals
  )
  return rows[0] ?? null
}

async function listItemById(householdId: string, id: string): Promise<ListItemRow | null> {
  const { rows } = await query<ListItemRow>(
    `select i.*, p.name as assignee_name, p.avatar_emoji as assignee_avatar, p.color_hex as assignee_color
       from list_items i left join persons p on p.id = i.assigned_to and p.deleted_at is null
      where i.household_id = $1 and i.id = $2 and i.deleted_at is null`,
    [householdId, id]
  )
  return rows[0] ?? null
}

export async function softDeleteItem(householdId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `update list_items set deleted_at = now()
       where household_id = $1 and id = $2 and deleted_at is null`,
    [householdId, id]
  )
  return !!rowCount
}

// Auto-build: add a recipe's ingredients to the grocery list, skipping names
// already on it. Returns null if the recipe isn't in this household.
export async function addRecipeToGrocery(
  tenant: Tenant,
  recipeId: string
): Promise<ListItemRow[] | null> {
  const recipe = await getRecipe(tenant.householdId, recipeId)
  if (!recipe) return null

  const list = await getOrCreateGroceryList(tenant)
  const ingredients = await listIngredients(tenant.householdId, recipeId)
  const existing = await query<{ name: string }>(
    `select name from list_items where household_id=$1 and list_id=$2 and deleted_at is null`,
    [tenant.householdId, list.id]
  )
  const have = new Set(existing.rows.map((r) => r.name.trim().toLowerCase()))

  const added: ListItemRow[] = []
  for (const ing of ingredients) {
    const key = ing.name.trim().toLowerCase()
    if (have.has(key)) continue
    have.add(key)
    const quantity = ing.amount != null && ing.unit ? `${Number(ing.amount)} ${ing.unit}` : null
    const { rows } = await query<ListItemRow>(
      `insert into list_items
         (household_id, list_id, name, quantity, source, source_recipe_ids, created_by)
       values ($1,$2,$3,$4,'auto',$5,$6) returning *`,
      [tenant.householdId, list.id, ing.name, quantity, [recipeId], tenant.personId]
    )
    added.push(rows[0])
  }
  return added
}

export function presentList(l: ListRow) {
  return {
    id: l.id,
    name: l.name,
    emoji: l.emoji,
    listType: l.list_type,
    isAutoBuilt: l.is_auto_built,
    sortMode: l.sort_mode,
  }
}

export function presentListItem(i: ListItemRow) {
  return {
    id: i.id,
    name: i.name,
    quantity: i.quantity,
    checked: i.checked,
    checkedAt: i.checked_at,
    section: i.category,
    sortOrder: i.sort_order,
    assignee:
      i.assigned_to == null
        ? null
        : {
            personId: i.assigned_to,
            name: i.assignee_name ?? null,
            avatarEmoji: i.assignee_avatar ?? null,
            colorHex: i.assignee_color ?? null,
          },
  }
}

export function registerListRoutes(api: Api): void {
  // ---- the household's lists (sidebar) --------------------------------------
  api.get('/api/lists', async (req: Request) => {
    const tenant = await requireTenant(req)
    // Ensure the grocery list exists so it always shows in the rail.
    await getOrCreateGroceryList(tenant)
    return { lists: await listLists(tenant.householdId) }
  })

  api.post('/api/lists', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const body = (req.body ?? {}) as Partial<CreateListInput>
    if (!body.name || !body.name.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'name is required' })
    }
    const list = await createList(tenant, { ...body, name: body.name.trim() } as CreateListInput)
    return res.status(201).json({ list: presentList(list) })
  })

  api.patch('/api/lists/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
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
  })

  api.delete('/api/lists/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    const ok = await softDeleteList(tenant.householdId, id)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    return res.status(204).send('')
  })

  // A list + its items grouped by section (CLOTHES / GEAR / …).
  api.get('/api/lists/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    const list = await getList(tenant.householdId, id)
    if (!list) return res.status(404).json({ error: 'NotFound', message: 'list not found' })
    const items = await listItems(tenant.householdId, id)
    return { list: presentList(list), items: items.map(presentListItem) }
  })

  // Add an item to any list.
  api.post('/api/lists/:id/items', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
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
  })

  // ---- grocery list (unchanged; the Today dashboard depends on these) -------
  api.get('/api/lists/grocery', async (req: Request) => {
    const tenant = await requireTenant(req)
    const list = await getOrCreateGroceryList(tenant)
    const items = await listItems(tenant.householdId, list.id)
    return { list: presentList(list), items: items.map(presentListItem) }
  })

  api.post('/api/lists/grocery/items', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const body = (req.body ?? {}) as { name?: string; quantity?: string }
    if (!body.name || !body.name.trim()) {
      return res.status(400).json({ error: 'BadRequest', message: 'name is required' })
    }
    const list = await getOrCreateGroceryList(tenant)
    const item = await addItem(tenant, list.id, { name: body.name.trim(), quantity: body.quantity ?? null })
    return res.status(201).json({ item: presentListItem(item) })
  })

  // ---- list items (shared across all lists) ---------------------------------
  // Check/uncheck, reassign, change quantity, or move section.
  api.patch('/api/list-items/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
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
  })

  // Remove an item (soft-delete).
  api.delete('/api/list-items/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'item not found' })
    const ok = await softDeleteItem(tenant.householdId, id)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'item not found' })
    return res.status(204).send('')
  })

  // Add a recipe's ingredients to the grocery list (the meal card's "To list").
  api.post('/api/lists/grocery/from-recipe/:recipeId', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const recipeId = req.params.recipeId ?? ''
    if (!UUID_RE.test(recipeId)) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    const added = await addRecipeToGrocery(tenant, recipeId)
    if (added === null) return res.status(404).json({ error: 'NotFound', message: 'recipe not found' })
    return res.status(201).json({ added: added.length, items: added.map(presentListItem) })
  })
}
