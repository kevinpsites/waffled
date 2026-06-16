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
import { getRecipe, listIngredients, getOverrides } from './meals'
import { aisleFor, isStaple } from './aisles'

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
  const subs = getOverrides(recipe).subs ?? {}
  const existing = await query<{ id: string; name: string; quantity: string | null; source_recipe_ids: string[] | null }>(
    `select id, name, quantity, source_recipe_ids from list_items
       where household_id=$1 and list_id=$2 and deleted_at is null`,
    [tenant.householdId, list.id]
  )
  const have = new Map(existing.rows.map((r) => [r.name.trim().toLowerCase(), r]))

  const added: ListItemRow[] = []
  for (const ing of ingredients) {
    // honor an in-app substitution: shop for the swap, not the original.
    const sub = subs[ing.name.trim().toLowerCase()]
    const name = (sub && sub.trim() ? sub.trim() : ing.name).trim()
    const row = ing as { aisle?: string | null; is_staple?: boolean }
    // pantry staples are assumed in-house — leave them off the list (matches the
    // weekly auto-build and the mock's "Pantry check").
    if (row.is_staple || isStaple(name)) continue
    const key = name.toLowerCase()
    const quantity = ing.amount != null && ing.unit ? `${Number(ing.amount)} ${ing.unit}` : ing.amount != null ? `${Number(ing.amount)}` : null
    const aisle = row.aisle && row.aisle !== 'Other' ? row.aisle : aisleFor(name, ing.unit)

    const dupe = have.get(key)
    if (dupe) {
      // already on the list — bump the quantity and credit this recipe too,
      // rather than silently skipping (so two recipes' limes become "2").
      const mergedQty = mergeQuantity(dupe.quantity, quantity)
      const ids = [...new Set([...(dupe.source_recipe_ids ?? []), recipeId])]
      await query(`update list_items set quantity=$1, source_recipe_ids=$2 where id=$3`, [mergedQty, ids, dupe.id])
      continue
    }
    have.set(key, { id: '', name, quantity, source_recipe_ids: [recipeId] })
    const { rows } = await query<ListItemRow>(
      `insert into list_items
         (household_id, list_id, name, quantity, category, source, source_recipe_ids, created_by)
       values ($1,$2,$3,$4,$5,'auto',$6,$7) returning *`,
      [tenant.householdId, list.id, name, quantity, aisle, [recipeId], tenant.personId]
    )
    added.push(rows[0])
  }
  return added
}

// Combine two freeform grocery quantities. Same unit (or both unit-less) → sum
// the numbers ("1 lb" + "0.5 lb" → "1.5 lb", "1" + "1" → "2"). Otherwise keep
// both ("1 cup" + "2 tbsp" → "1 cup + 2 tbsp").
function parseQuantity(q: string | null): { n: number | null; unit: string } {
  if (!q) return { n: null, unit: '' }
  const m = q.trim().match(/^([\d.]+)\s*(.*)$/)
  if (!m) return { n: null, unit: q.trim() }
  return { n: parseFloat(m[1]), unit: m[2].trim() }
}
export function mergeQuantity(a: string | null, b: string | null): string | null {
  const pa = parseQuantity(a)
  const pb = parseQuantity(b)
  if (pa.n != null && pb.n != null && pa.unit.toLowerCase() === pb.unit.toLowerCase()) {
    const sum = +(pa.n + pb.n).toFixed(2)
    return pb.unit ? `${sum} ${pb.unit}` : `${sum}`
  }
  if (a && b) return `${a} + ${b}`
  return a ?? b
}

// ---- pantry staples (assumed in-house; excluded from the auto-build) --------

const DEFAULT_STAPLES = ['Olive oil', 'Garlic', 'Rice', 'Parmesan', 'Butter', 'Salt & pepper', 'Pasta', 'Eggs']

export async function listPantryStaples(householdId: string): Promise<Array<{ id: string; name: string }>> {
  const { rows } = await query<{ id: string; name: string }>(
    `select id, name from pantry_staples where household_id=$1 and deleted_at is null order by lower(name)`,
    [householdId]
  )
  return rows
}

export async function ensureDefaultStaples(householdId: string): Promise<void> {
  const { rowCount } = await query(`select 1 from pantry_staples where household_id=$1 limit 1`, [householdId])
  if (rowCount) return
  for (const name of DEFAULT_STAPLES) {
    await query(`insert into pantry_staples (household_id, name) values ($1,$2) on conflict do nothing`, [householdId, name])
  }
}

export async function addPantryStaple(householdId: string, name: string): Promise<{ id: string; name: string }> {
  const { rows } = await query<{ id: string; name: string }>(
    `insert into pantry_staples (household_id, name) values ($1,$2)
       on conflict (household_id, lower(name)) where deleted_at is null do update set deleted_at = null
     returning id, name`,
    [householdId, name]
  )
  return rows[0]
}

export async function removePantryStaple(householdId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `update pantry_staples set deleted_at = now() where household_id=$1 and id=$2 and deleted_at is null`,
    [householdId, id]
  )
  return !!rowCount
}

function isoAddDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// Rebuild the auto portion of the grocery list from a week's planned meals
// (breakfast, lunch, dinner, snack): gather ingredients, drop staples, aggregate
// same-name (sum same-unit amounts), tag each with source recipes (per-meal
// dots), set the aisle.
export async function rebuildGroceryFromWeek(tenant: Tenant, weekStart: string): Promise<number> {
  const list = await getOrCreateGroceryList(tenant)
  const weekEnd = isoAddDays(weekStart, 6)
  const dinners = await query<{ recipe_id: string; overrides: unknown }>(
    `select distinct e.recipe_id, r.overrides from meal_plan_entries e
       join recipes r on r.id = e.recipe_id and r.deleted_at is null
      where e.household_id=$1 and e.recipe_id is not null
        and e.deleted_at is null and e.date >= $2 and e.date <= $3`,
    [tenant.householdId, weekStart, weekEnd]
  )
  await ensureDefaultStaples(tenant.householdId)
  const staples = new Set((await listPantryStaples(tenant.householdId)).map((s) => s.name.trim().toLowerCase()))

  type Agg = { name: string; aisle: string | null; unit: string | null; amount: number | null; recipeIds: Set<string> }
  const byName = new Map<string, Agg>()
  for (const { recipe_id, overrides } of dinners.rows) {
    const subs = ((overrides ?? {}) as { subs?: Record<string, string> }).subs ?? {}
    const ings = await listIngredients(tenant.householdId, recipe_id)
    for (const ing of ings) {
      const row = ing as typeof ing & { aisle?: string | null; is_staple?: boolean }
      // honor an in-app substitution before aggregating / filtering staples.
      const sub = subs[ing.name.trim().toLowerCase()]
      const name = sub && sub.trim() ? sub.trim() : ing.name.trim()
      const key = name.toLowerCase()
      if (row.is_staple || staples.has(key)) continue
      const amt = ing.amount == null ? null : Number(ing.amount)
      let g = byName.get(key)
      if (!g) {
        g = { name, aisle: row.aisle ?? 'Other', unit: ing.unit, amount: amt, recipeIds: new Set() }
        byName.set(key, g)
      } else if (amt != null && (ing.unit ?? '') === (g.unit ?? '')) {
        // same unit (or both unit-less, e.g. "1 lime" ×2 → "2")
        g.amount = (g.amount ?? 0) + amt
      }
      g.recipeIds.add(recipe_id)
    }
  }

  // remember which auto items were already checked off (so a refresh doesn't
  // un-check what's in the cart), then replace the auto set; manual items stay.
  const prevChecked = new Set(
    (
      await query<{ name: string }>(
        `select name from list_items where household_id=$1 and list_id=$2 and source='auto' and checked and deleted_at is null`,
        [tenant.householdId, list.id]
      )
    ).rows.map((r) => r.name.trim().toLowerCase())
  )
  await query(`delete from list_items where household_id=$1 and list_id=$2 and source='auto'`, [tenant.householdId, list.id])
  let order = 0
  for (const g of byName.values()) {
    const qty = g.amount != null ? `${Number(g.amount.toFixed(2))}${g.unit ? ` ${g.unit}` : ''}` : g.unit
    const checked = prevChecked.has(g.name.trim().toLowerCase())
    await query(
      `insert into list_items (household_id, list_id, name, quantity, category, source, source_recipe_ids, checked, checked_at, sort_order, created_by)
       values ($1,$2,$3,$4,$5,'auto',$6,$7,$8,$9,$10)`,
      [tenant.householdId, list.id, g.name, qty, g.aisle, [...g.recipeIds], checked, checked ? new Date() : null, order++, tenant.personId]
    )
  }
  return byName.size
}

const DINNER_COLORS = ['#2F7FED', '#EC6049', '#8B5CF6', '#E0A500', '#25A368', '#EC4899', '#14B8A6']
const MEAL_ORDER: Record<string, number> = { breakfast: 0, lunch: 1, dinner: 2, snack: 3 }

// The grocery "board": the list items + this week's planned meals (each with a
// color, so items can show per-meal dots) + the pantry staples. Powers the
// grocery view. Colors are stable per recipe so a dish keeps one dot color even
// when it's planned in more than one slot.
export async function groceryBoard(tenant: Tenant, weekStart: string) {
  const list = await getOrCreateGroceryList(tenant)
  const weekEnd = isoAddDays(weekStart, 6)
  const mealRows = await query<{ date: string; meal_type: string; recipe_id: string | null; title: string | null; emoji: string | null }>(
    `select e.date, e.meal_type, e.recipe_id, coalesce(r.title, e.title) as title, r.emoji
       from meal_plan_entries e left join recipes r on r.id = e.recipe_id and r.deleted_at is null
      where e.household_id=$1 and e.deleted_at is null
        and e.date >= $2 and e.date <= $3
      order by e.date`,
    [tenant.householdId, weekStart, weekEnd]
  )
  const colorByRecipe = new Map<string, string>()
  let nextColor = 0
  const meals = mealRows.rows
    .map((d) => {
      let color: string
      if (d.recipe_id) {
        if (!colorByRecipe.has(d.recipe_id)) colorByRecipe.set(d.recipe_id, DINNER_COLORS[nextColor++ % DINNER_COLORS.length])
        color = colorByRecipe.get(d.recipe_id)!
      } else {
        color = DINNER_COLORS[nextColor++ % DINNER_COLORS.length]
      }
      return { date: d.date, mealType: d.meal_type, recipeId: d.recipe_id, title: d.title, emoji: d.emoji, color }
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (MEAL_ORDER[a.mealType] ?? 9) - (MEAL_ORDER[b.mealType] ?? 9)))

  const itemRows = await query<ListItemRow & { source: string; source_recipe_ids: string[] | null }>(
    `select li.*, p.name as assignee_name, p.avatar_emoji as assignee_avatar, p.color_hex as assignee_color
       from list_items li left join persons p on p.id = li.assigned_to
      where li.household_id=$1 and li.list_id=$2 and li.deleted_at is null
      order by li.sort_order nulls last, li.created_at`,
    [tenant.householdId, list.id]
  )
  const items = itemRows.rows.map((i) => ({
    ...presentListItem(i),
    // fall back to name-based classification when a row has no/Other aisle (older
    // items, hand-added items) so the board stays cleanly grouped like the mock.
    aisle: i.category && i.category !== 'Other' ? i.category : aisleFor(i.name, i.quantity),
    source: i.source,
    sourceRecipeIds: i.source_recipe_ids ?? [],
  }))

  return {
    list: presentList(list),
    weekStart,
    meals,
    items,
    staples: await listPantryStaples(tenant.householdId),
  }
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

  api.get('/api/lists/grocery/board', async (req: Request) => {
    const tenant = await requireTenant(req)
    return groceryBoard(tenant, weekStartParam(req))
  })

  api.post('/api/lists/grocery/rebuild', async (req: Request) => {
    const tenant = await requireTenant(req)
    const weekStart = weekStartParam(req)
    const count = await rebuildGroceryFromWeek(tenant, weekStart)
    return { rebuilt: count, board: await groceryBoard(tenant, weekStart) }
  })

  api.get('/api/pantry-staples', async (req: Request) => {
    const tenant = await requireTenant(req)
    await ensureDefaultStaples(tenant.householdId)
    return { staples: await listPantryStaples(tenant.householdId) }
  })

  api.post('/api/pantry-staples', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const name = ((req.body ?? {}) as { name?: string }).name?.trim()
    if (!name) return res.status(400).json({ error: 'BadRequest', message: 'name is required' })
    return res.status(201).json({ staple: await addPantryStaple(tenant.householdId, name) })
  })

  api.delete('/api/pantry-staples/:id', async (req: Request, res: Response) => {
    const tenant = await requireTenant(req)
    const id = req.params.id ?? ''
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'NotFound', message: 'staple not found' })
    const ok = await removePantryStaple(tenant.householdId, id)
    if (!ok) return res.status(404).json({ error: 'NotFound', message: 'staple not found' })
    return res.status(204).send('')
  })
}
