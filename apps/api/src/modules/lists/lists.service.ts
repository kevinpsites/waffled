// Lists domain — matches the handoff Lists mock (multi-list, parameterized).
// The household has many named lists (Groceries, Lake trip packing, Target run,
// Costco, …) each with an emoji + live item count. Items carry a section
// (CLOTHES / GEAR / FOR THE KIDS via `category`), a freeform quantity ("×4"),
// an assignee (avatar) and a checked state. The grocery list keeps its existing
// get-or-create endpoints (the Today dashboard's Grocery card depends on them).
import { getPool, query } from '../../platform/db'
import { type Tenant } from '../households/households'
import { getRecipe, listIngredients, getOverrides } from '../meals/meals.service'
import { aisleFor, isStaple } from './aisles'
import type { ListRow, ListItemRow, CreateListInput, PatchItemInput } from './lists.types'

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
      where l.household_id = $1 and l.deleted_at is null and l.list_type <> 'template'
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

// Deleting a list takes its items with it — a shopping/packing list is throwaway,
// so any items not yet checked off go too (cascade, in one transaction) rather
// than lingering as orphaned rows.
export async function softDeleteList(householdId: string, id: string): Promise<boolean> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const r = await client.query(
      `update lists set deleted_at = now()
         where household_id = $1 and id = $2 and deleted_at is null`,
      [householdId, id]
    )
    const found = (r.rowCount ?? 0) > 0
    if (found) {
      await client.query(
        `update list_items set deleted_at = now()
           where household_id = $1 and list_id = $2 and deleted_at is null`,
        [householdId, id]
      )
    }
    await client.query('commit')
    return found
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// ---- list templates (mark-as-template / apply) ------------------------------
// A template is a `lists` row with list_type='template' whose items are stored
// unchecked; there's no separate table (Option A). Templates are filtered out of
// the normal rail (listLists filters list_type<>'template') and surfaced in their
// own "Templates" group. Marking a list as a template CONVERTS it in place (it
// stops being an active list and becomes the reusable one), so there's exactly
// one editable copy — edit it and every list you spin off it reflects the change.

// The household's saved templates (newest first).
export async function listTemplates(householdId: string) {
  const { rows } = await query<ListRow & { item_count: string }>(
    `select l.id, l.name, l.emoji, l.list_type, l.is_auto_built, l.sort_mode,
            (select count(*) from list_items i
              where i.list_id = l.id and i.deleted_at is null) as item_count
       from lists l
      where l.household_id = $1 and l.deleted_at is null and l.list_type = 'template'
      order by l.created_at desc`,
    [householdId]
  )
  return rows.map((r) => ({ ...presentList(r), itemCount: Number(r.item_count) }))
}

// Mark a list as a reusable template by CONVERTING it in place (list_type ->
// 'template'), unchecking its items so it reads as a clean starting point. No
// copy is made, so there's a single editable template — no drift, no duplicates.
// Only a plain 'custom' list can be converted (the auto grocery list is off
// limits, and templates/grocery return null). One transaction. Returns the
// updated row, or null if there's no eligible list.
export async function convertToTemplate(householdId: string, id: string): Promise<ListRow | null> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const upd = await client.query<ListRow>(
      `update lists set list_type = 'template'
         where household_id = $1 and id = $2 and deleted_at is null and list_type = 'custom'
         returning *`,
      [householdId, id]
    )
    const row = upd.rows[0]
    if (!row) {
      await client.query('rollback')
      return null
    }
    await client.query(
      `update list_items set checked = false, checked_at = null, checked_by = null
         where household_id = $1 and list_id = $2 and deleted_at is null`,
      [householdId, id]
    )
    await client.query('commit')
    return row
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

// Move a template back into the active Lists rail (list_type -> 'custom'), e.g.
// to undo an accidental convert. Returns the updated row, or null if it isn't a
// template in this household.
export async function convertToList(householdId: string, id: string): Promise<ListRow | null> {
  const { rows } = await query<ListRow>(
    `update lists set list_type = 'custom'
       where household_id = $1 and id = $2 and deleted_at is null and list_type = 'template'
       returning *`,
    [householdId, id]
  )
  return rows[0] ?? null
}

// Apply a template: spin up a fresh list_type='custom' list from the template's
// items, all unchecked, recording source_template_id for provenance. Returns null
// if the template isn't a live template in this household. One transaction.
export async function applyTemplate(
  tenant: Tenant,
  templateId: string,
  name?: string
): Promise<ListRow | null> {
  const client = await getPool().connect()
  try {
    await client.query('begin')
    const tpl = await client.query<ListRow>(
      `select * from lists where household_id = $1 and id = $2 and deleted_at is null and list_type = 'template'`,
      [tenant.householdId, templateId]
    )
    const template = tpl.rows[0]
    if (!template) {
      await client.query('rollback')
      return null
    }
    const created = await client.query<ListRow>(
      `insert into lists (household_id, name, emoji, list_type, is_auto_built, source_template_id, created_by)
       values ($1, $2, $3, 'custom', false, $4, $5)
       returning *`,
      [tenant.householdId, (name && name.trim()) || template.name, template.emoji, templateId, tenant.personId]
    )
    const list = created.rows[0]
    await client.query(
      `insert into list_items
         (household_id, list_id, name, quantity, category, source, sort_order, created_by, checked)
       select household_id, $2, name, quantity, category, source, sort_order, $3, false
         from list_items
        where household_id = $1 and list_id = $4 and deleted_at is null`,
      [tenant.householdId, list.id, tenant.personId, templateId]
    )
    await client.query('commit')
    return list
  } catch (err) {
    await client.query('rollback')
    throw err
  } finally {
    client.release()
  }
}

export async function listItems(householdId: string, listId: string): Promise<ListItemRow[]> {
  const { rows } = await query<ListItemRow>(
    `select i.*, p.name as assignee_name, p.avatar_emoji as assignee_avatar, p.color_hex as assignee_color,
            cb.name as creator_name, cb.avatar_emoji as creator_avatar, cb.color_hex as creator_color
       from list_items i
       left join persons p on p.id = i.assigned_to and p.deleted_at is null
       left join persons cb on cb.id = i.created_by and cb.deleted_at is null
      where i.household_id = $1 and i.list_id = $2 and i.deleted_at is null
      order by i.checked, i.priority desc, i.sort_order nulls last, i.created_at`,
    [householdId, listId]
  )
  return rows
}

export async function addItem(
  tenant: Tenant,
  listId: string,
  input: { name: string; quantity?: string | null; category?: string | null; assignedTo?: string | null; priority?: number }
): Promise<ListItemRow> {
  const { rows } = await query<ListItemRow>(
    `with ins as (
       insert into list_items (household_id, list_id, name, quantity, category, assigned_to, priority, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning *
     )
     select ins.*, p.name as assignee_name, p.avatar_emoji as assignee_avatar, p.color_hex as assignee_color,
            cb.name as creator_name, cb.avatar_emoji as creator_avatar, cb.color_hex as creator_color
       from ins
       left join persons p on p.id = ins.assigned_to and p.deleted_at is null
       left join persons cb on cb.id = ins.created_by and cb.deleted_at is null`,
    [
      tenant.householdId,
      listId,
      input.name,
      input.quantity ?? null,
      input.category ?? null,
      input.assignedTo ?? null,
      input.priority ?? 0,
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
     select upd.*, p.name as assignee_name, p.avatar_emoji as assignee_avatar, p.color_hex as assignee_color,
            cb.name as creator_name, cb.avatar_emoji as creator_avatar, cb.color_hex as creator_color
       from upd
       left join persons p on p.id = upd.assigned_to and p.deleted_at is null
       left join persons cb on cb.id = upd.created_by and cb.deleted_at is null`,
    [checked, tenant.personId, tenant.householdId, id]
  )
  return rows[0] ?? null
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
  if (typeof patch.priority === 'number') {
    sets.push(`priority = $${i++}`)
    vals.push(patch.priority)
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
     select upd.*, p.name as assignee_name, p.avatar_emoji as assignee_avatar, p.color_hex as assignee_color,
            cb.name as creator_name, cb.avatar_emoji as creator_avatar, cb.color_hex as creator_color
       from upd
       left join persons p on p.id = upd.assigned_to and p.deleted_at is null
       left join persons cb on cb.id = upd.created_by and cb.deleted_at is null`,
    vals
  )
  return rows[0] ?? null
}

async function listItemById(householdId: string, id: string): Promise<ListItemRow | null> {
  const { rows } = await query<ListItemRow>(
    `select i.*, p.name as assignee_name, p.avatar_emoji as assignee_avatar, p.color_hex as assignee_color,
            cb.name as creator_name, cb.avatar_emoji as creator_avatar, cb.color_hex as creator_color
       from list_items i
       left join persons p on p.id = i.assigned_to and p.deleted_at is null
       left join persons cb on cb.id = i.created_by and cb.deleted_at is null
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

// Add a recipe's ingredients to the grocery list from its page — an *explicit*
// user action, so rows get source='recipe' (not 'auto'): the weekly rebuild only
// recomputes derived 'auto' rows, and these must survive it. Merges into rows
// already on the list by name. Returns null if the recipe isn't in this household.
export async function addRecipeToGrocery(
  tenant: Tenant,
  recipeId: string
): Promise<ListItemRow[] | null> {
  const recipe = await getRecipe(tenant.householdId, recipeId)
  if (!recipe) return null

  const list = await getOrCreateGroceryList(tenant)
  const ingredients = await listIngredients(tenant.householdId, recipeId)
  const subs = getOverrides(recipe).subs ?? {}
  const existing = await query<{ id: string; name: string; quantity: string | null; source: string; source_recipe_ids: string[] | null }>(
    `select id, name, quantity, source, source_recipe_ids from list_items
       where household_id=$1 and list_id=$2 and deleted_at is null`,
    [tenant.householdId, list.id]
  )
  const have = new Map(existing.rows.map((r) => [r.name.trim().toLowerCase(), r]))
  // names written during THIS call — duplicate ingredient rows in one recipe
  // (same name in two steps) must still merge with each other, while a repeat
  // POST for an already-credited recipe must not re-add anything.
  const touched = new Set<string>()

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
      // An 'auto' row gains an off-plan stake here, so promote it to 'recipe' or
      // the next weekly rebuild would wipe it. Hand-added rows stay 'manual'.
      const source = dupe.source === 'auto' ? 'recipe' : dupe.source
      if ((dupe.source_recipe_ids ?? []).includes(recipeId) && !touched.has(key)) {
        // this recipe already contributed to the row (a repeat POST / double-tap)
        // — re-merging would double the quantity without bound. Just promote.
        if (source !== dupe.source) {
          await query(`update list_items set source=$1 where id=$2`, [source, dupe.id])
          dupe.source = source
        }
        continue
      }
      // already on the list — bump the quantity and credit this recipe too,
      // rather than silently skipping (so two recipes' limes become "2").
      const mergedQty = mergeQuantity(dupe.quantity, quantity)
      const ids = [...new Set([...(dupe.source_recipe_ids ?? []), recipeId])]
      await query(`update list_items set quantity=$1, source_recipe_ids=$2, source=$3 where id=$4`, [mergedQty, ids, source, dupe.id])
      dupe.quantity = mergedQty
      dupe.source_recipe_ids = ids
      dupe.source = source
      touched.add(key)
      continue
    }
    const { rows } = await query<ListItemRow>(
      `insert into list_items
         (household_id, list_id, name, quantity, category, source, source_recipe_ids, created_by)
       values ($1,$2,$3,$4,$5,'recipe',$6,$7) returning *`,
      [tenant.householdId, list.id, name, quantity, aisle, [recipeId], tenant.personId]
    )
    // cache the REAL inserted row (with its id) so a later duplicate name in this
    // same recipe merges into it instead of 500ing on an empty-id update.
    have.set(key, rows[0])
    touched.add(key)
    added.push(rows[0])
  }
  return added
}

// Undo an off-plan "add recipe to grocery": take that recipe's ingredients back
// off the list. Rows that exist ONLY for this recipe (source='recipe' crediting
// just this id) are soft-deleted; rows shared with another recipe or hand-added
// keep living — we only strip this recipe's credit (array_remove). Returns the
// number of rows removed, or null if the recipe isn't in this household.
export async function removeRecipeFromGrocery(
  tenant: Tenant,
  recipeId: string
): Promise<number | null> {
  const recipe = await getRecipe(tenant.householdId, recipeId)
  if (!recipe) return null
  const list = await getOrCreateGroceryList(tenant)

  // Delete rows solely owned by this recipe (an explicit off-plan add with no
  // other stake) — exactly [recipeId], and not a hand-added 'manual' row.
  const del = await query(
    `update list_items set deleted_at = now()
       where household_id = $1 and list_id = $2 and deleted_at is null
         and source = 'recipe' and source_recipe_ids = ARRAY[$3]::uuid[]`,
    [tenant.householdId, list.id, recipeId]
  )
  // Strip this recipe's credit from rows that survive (shared with another recipe,
  // or a 'manual' row this recipe had merged onto).
  await query(
    `update list_items set source_recipe_ids = array_remove(source_recipe_ids, $3::uuid)
       where household_id = $1 and list_id = $2 and deleted_at is null
         and $3 = ANY(source_recipe_ids)`,
    [tenant.householdId, list.id, recipeId]
  )
  return del.rowCount ?? 0
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

  type Agg = {
    name: string
    aisle: string | null
    unit: string | null
    amount: number | null
    recipeIds: Set<string>
    // per-recipe quantity strings, so the surviving-off-plan-row branch below can
    // merge exactly the portions of recipes that are NEW to that row.
    contribs: Array<{ recipeId: string; qty: string | null }>
  }
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
        g = { name, aisle: row.aisle ?? 'Other', unit: ing.unit, amount: amt, recipeIds: new Set(), contribs: [] }
        byName.set(key, g)
      } else if (amt != null && (ing.unit ?? '') === (g.unit ?? '')) {
        // same unit (or both unit-less, e.g. "1 lime" ×2 → "2")
        g.amount = (g.amount ?? 0) + amt
      }
      g.recipeIds.add(recipe_id)
      g.contribs.push({ recipeId: recipe_id, qty: amt != null ? `${amt}${ing.unit ? ` ${ing.unit}` : ''}` : null })
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

  // Explicit off-plan adds (source='recipe') survive the wipe above. When the
  // week's build needs a name one of them already covers, credit the planned
  // recipes on that row instead of inserting a duplicate — and merge in the
  // portions of recipes NEW to the row (a recipe already credited contributed
  // its amount when it was added/planned before, so re-merging it on every
  // rebuild would grow the quantity without bound).
  const recipeRows = await query<{ id: string; name: string; quantity: string | null; source_recipe_ids: string[] | null }>(
    `select id, name, quantity, source_recipe_ids from list_items
       where household_id=$1 and list_id=$2 and source='recipe' and deleted_at is null`,
    [tenant.householdId, list.id]
  )
  const offPlanByName = new Map(recipeRows.rows.map((r) => [r.name.trim().toLowerCase(), r]))

  let order = 0
  for (const g of byName.values()) {
    const surviving = offPlanByName.get(g.name.trim().toLowerCase())
    if (surviving) {
      const prevIds = new Set(surviving.source_recipe_ids ?? [])
      const newContribs = g.contribs.filter((c) => !prevIds.has(c.recipeId))
      const ids = [...new Set([...(surviving.source_recipe_ids ?? []), ...g.recipeIds])]
      if (newContribs.length || ids.length !== prevIds.size) {
        let qty = surviving.quantity
        for (const c of newContribs) qty = mergeQuantity(qty, c.qty)
        await query(`update list_items set quantity=$1, source_recipe_ids=$2 where id=$3`, [qty, ids, surviving.id])
      }
      continue
    }
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
  // the two board queries are independent — fetch them in one round-trip
  const [mealRows, itemRows] = await Promise.all([
    query<{ date: string; meal_type: string; recipe_id: string | null; title: string | null; emoji: string | null }>(
      `select e.date, e.meal_type, e.recipe_id, coalesce(r.title, e.title) as title, r.emoji
         from meal_plan_entries e left join recipes r on r.id = e.recipe_id and r.deleted_at is null
        where e.household_id=$1 and e.deleted_at is null
          and e.date >= $2 and e.date <= $3
        order by e.date`,
      [tenant.householdId, weekStart, weekEnd]
    ),
    query<ListItemRow>(
      `select li.*, p.name as assignee_name, p.avatar_emoji as assignee_avatar, p.color_hex as assignee_color,
              cb.name as creator_name, cb.avatar_emoji as creator_avatar, cb.color_hex as creator_color
         from list_items li
         left join persons p on p.id = li.assigned_to
         left join persons cb on cb.id = li.created_by and cb.deleted_at is null
        where li.household_id=$1 and li.list_id=$2 and li.deleted_at is null
        order by li.sort_order nulls last, li.created_at`,
      [tenant.householdId, list.id]
    ),
  ])
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

  const items = itemRows.rows.map((i) => ({
    ...presentListItem(i),
    // fall back to name-based classification when a row has no/Other aisle (older
    // items, hand-added items) so the board stays cleanly grouped like the mock.
    aisle: i.category && i.category !== 'Other' ? i.category : aisleFor(i.name, i.quantity),
  }))

  // Recipes explicitly added from their page that aren't planned this week —
  // surfaced so the by-meal view can give them their own section instead of
  // lumping them into "Other items". Explicit adds live on 'recipe' rows OR as
  // ids merged onto hand-added 'manual' rows; only derived 'auto' rows are
  // excluded — their ids come from a week build (plan-ahead / last week's
  // rollover) and would show phantom "Unscheduled" sections. Colors continue
  // the planned meals' rotation so their dots stay distinct.
  const plannedIds = new Set(mealRows.rows.map((d) => d.recipe_id).filter(Boolean))
  const offPlanIds = [
    ...new Set(items.filter((i) => i.source !== 'auto').flatMap((i) => i.sourceRecipeIds)),
  ].filter((id) => !plannedIds.has(id))
  const [unscheduledRecipes, staples] = await Promise.all([
    offPlanIds.length
      ? query<{ id: string; title: string; emoji: string | null }>(
          `select id, title, emoji from recipes
            where household_id=$1 and id = any($2) and deleted_at is null
            order by lower(title)`,
          [tenant.householdId, offPlanIds]
        ).then((r) => r.rows)
      : Promise.resolve([]),
    listPantryStaples(tenant.householdId),
  ])
  const unscheduled = unscheduledRecipes.map((r) => {
    if (!colorByRecipe.has(r.id)) colorByRecipe.set(r.id, DINNER_COLORS[nextColor++ % DINNER_COLORS.length])
    return { recipeId: r.id, title: r.title, emoji: r.emoji, color: colorByRecipe.get(r.id)! }
  })

  return {
    list: presentList(list),
    weekStart,
    meals,
    unscheduled,
    items,
    staples,
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
    priority: i.priority ?? 0,
    sortOrder: i.sort_order,
    source: i.source,
    sourceRecipeIds: i.source_recipe_ids ?? [],
    assignee:
      i.assigned_to == null
        ? null
        : {
            personId: i.assigned_to,
            name: i.assignee_name ?? null,
            avatarEmoji: i.assignee_avatar ?? null,
            colorHex: i.assignee_color ?? null,
          },
    addedBy:
      i.created_by == null
        ? null
        : {
            personId: i.created_by,
            name: i.creator_name ?? null,
            avatarEmoji: i.creator_avatar ?? null,
            colorHex: i.creator_color ?? null,
          },
  }
}
