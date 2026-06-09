// Lists domain. For now the kiosk needs the household's grocery list (get-or-
// create) plus add/check/remove items; custom lists generalize from here.
import createAPI, { type Request, type Response } from 'lambda-api'
import type { QueryResultRow } from 'pg'
import { query } from './db'
import { requireTenant, type Tenant } from './households'
import { getRecipe, listIngredients } from './meals'

type Api = ReturnType<typeof createAPI>

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

export async function listItems(householdId: string, listId: string): Promise<ListItemRow[]> {
  const { rows } = await query<ListItemRow>(
    `select * from list_items
       where household_id = $1 and list_id = $2 and deleted_at is null
       order by checked, sort_order nulls last, created_at`,
    [householdId, listId]
  )
  return rows
}

export async function addItem(
  tenant: Tenant,
  listId: string,
  input: { name: string; quantity?: string | null }
): Promise<ListItemRow> {
  const { rows } = await query<ListItemRow>(
    `insert into list_items (household_id, list_id, name, quantity, created_by)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [tenant.householdId, listId, input.name, input.quantity ?? null, tenant.personId]
  )
  return rows[0]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Toggle an item's checked state (records who/when). Household-scoped; null if
// no such live item in this household.
export async function setItemChecked(
  tenant: Tenant,
  id: string,
  checked: boolean
): Promise<ListItemRow | null> {
  const { rows } = await query<ListItemRow>(
    `update list_items
        set checked = $1,
            checked_at = case when $1 then now() else null end,
            checked_by = case when $1 then $2::uuid else null end
      where household_id = $3 and id = $4 and deleted_at is null
      returning *`,
    [checked, tenant.personId, tenant.householdId, id]
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
    category: i.category,
    sortOrder: i.sort_order,
  }
}

export function registerListRoutes(api: Api): void {
  // The household's grocery list + its items (creates the list on first access).
  api.get('/api/lists/grocery', async (req: Request) => {
    const tenant = await requireTenant(req)
    const list = await getOrCreateGroceryList(tenant)
    const items = await listItems(tenant.householdId, list.id)
    return { list: presentList(list), items: items.map(presentListItem) }
  })

  // Add an item to the grocery list.
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

  // Check / uncheck an item.
  api.patch('/api/list-items/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'item not found' })
    const body = (req.body ?? {}) as { checked?: unknown }
    if (typeof body.checked !== 'boolean') {
      return res.status(400).json({ error: 'BadRequest', message: 'checked (boolean) is required' })
    }
    const item = await setItemChecked(tenant, id, body.checked)
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
