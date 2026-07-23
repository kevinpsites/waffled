// Meal Builder — a "plate" is a named, multi-recipe meal (`meals` + `meal_recipes`):
// "BBQ Sunday" = BBQ Chicken (main) + Potato Salad + Coleslaw (sides) + Peach Cobbler
// (dessert). A plate can be saved to the library, scheduled into a meal_plan_entries
// slot, or added wholesale to the grocery list without ever being scheduled.
//
// Two rules worth remembering (docs/product/meal-builder-plan.md):
//   • `role` (main/side/dessert/…) is FREE TEXT and is never called meal_type — that
//     already means breakfast/lunch/dinner/snack elsewhere.
//   • Meals never nest: adding a saved meal to a plate FLATTENS it into individual,
//     independently editable dishes (decision 12).
import type { QueryResultRow } from 'pg'
import { query } from '../../platform/db'
import { type Tenant } from '../households/households'
import { mediaUrl } from '../../platform/storage'
import { onHandForRecipes, type OnHandCount } from '../pantry/on-hand'

export interface MealRow extends QueryResultRow {
  id: string
  household_id: string
  name: string
  servings: number
  is_saved: boolean
  created_by: string | null
  created_at: Date | string
}

interface MealRecipeRow extends QueryResultRow {
  meal_id: string
  recipe_id: string
  role: string
  sort_order: number
  cook_person_id: string | null
  title: string | null
  emoji: string | null
  category: string | null
  prep_time_minutes: number | null
  cook_time_minutes: number | null
  recipe_servings: number | null
  image_url: string | null
  storage_key: string | null
  cook_name: string | null
  cook_avatar: string | null
  cook_color: string | null
}

export interface MealRecipeInput {
  recipeId: string
  role?: string | null
  sortOrder?: number | null
  cookPersonId?: string | null
}

const DEFAULT_ROLE = 'side'

export async function getMeal(householdId: string, id: string): Promise<MealRow | null> {
  const { rows } = await query<MealRow>(
    `select * from meals where household_id = $1 and id = $2 and deleted_at is null`,
    [householdId, id]
  )
  return rows[0] ?? null
}

export async function createMeal(
  tenant: Tenant,
  input: { name: string; servings?: number | null; isSaved?: boolean }
): Promise<MealRow> {
  const { rows } = await query<MealRow>(
    `insert into meals (household_id, name, servings, is_saved, created_by)
     values ($1,$2,coalesce($3,4),coalesce($4,false),$5) returning *`,
    [tenant.householdId, input.name.trim(), input.servings ?? null, input.isSaved ?? null, tenant.personId]
  )
  return rows[0]
}

export async function updateMeal(
  householdId: string,
  id: string,
  patch: { name?: string; servings?: number; isSaved?: boolean }
): Promise<MealRow | null> {
  const sets: string[] = []
  const vals: unknown[] = []
  let i = 1
  if (typeof patch.name === 'string') {
    sets.push(`name = $${i++}`)
    vals.push(patch.name.trim())
  }
  if (typeof patch.servings === 'number') {
    sets.push(`servings = $${i++}`)
    vals.push(patch.servings)
  }
  if (typeof patch.isSaved === 'boolean') {
    sets.push(`is_saved = $${i++}`)
    vals.push(patch.isSaved)
  }
  if (!sets.length) return getMeal(householdId, id)
  vals.push(householdId, id)
  const { rows } = await query<MealRow>(
    `update meals set ${sets.join(', ')}
      where household_id = $${i++} and id = $${i++} and deleted_at is null returning *`,
    vals
  )
  return rows[0] ?? null
}

export async function softDeleteMeal(householdId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `update meals set deleted_at = now() where household_id = $1 and id = $2 and deleted_at is null`,
    [householdId, id]
  )
  return !!rowCount
}

// The dishes on a plate, in plate order, joined to the recipe + the assigned cook.
export async function listMealRecipes(householdId: string, mealId: string): Promise<MealRecipeRow[]> {
  const { rows } = await query<MealRecipeRow>(
    `select mr.meal_id, mr.recipe_id, mr.role, mr.sort_order, mr.cook_person_id,
            r.title, r.emoji, r.category, r.prep_time_minutes, r.cook_time_minutes,
            r.servings as recipe_servings, r.image_url, r.storage_key,
            p.name as cook_name, p.avatar_emoji as cook_avatar, p.color_hex as cook_color
       from meal_recipes mr
       join meals m on m.id = mr.meal_id and m.household_id = $1 and m.deleted_at is null
       left join recipes r on r.id = mr.recipe_id and r.deleted_at is null
       left join persons p on p.id = mr.cook_person_id and p.deleted_at is null
      where mr.meal_id = $2
      order by mr.sort_order, r.title nulls last`,
    [householdId, mealId]
  )
  return rows
}

async function nextSortOrder(mealId: string): Promise<number> {
  const { rows } = await query<{ next: number }>(
    `select coalesce(max(sort_order) + 1, 0) as next from meal_recipes where meal_id = $1`,
    [mealId]
  )
  return Number(rows[0]?.next ?? 0)
}

// Add a dish (or update it in place — (meal_id, recipe_id) is the primary key, so a
// plate holds a recipe at most once; re-adding just re-roles/re-orders it).
export async function setMealRecipe(mealId: string, input: MealRecipeInput): Promise<void> {
  const sortOrder = input.sortOrder ?? (await nextSortOrder(mealId))
  await query(
    `insert into meal_recipes (meal_id, recipe_id, role, sort_order, cook_person_id)
     values ($1,$2,coalesce($3,$6),$4,$5)
     on conflict (meal_id, recipe_id)
     do update set role = coalesce(excluded.role, meal_recipes.role),
                   sort_order = excluded.sort_order,
                   cook_person_id = excluded.cook_person_id`,
    [mealId, input.recipeId, input.role ?? null, sortOrder, input.cookPersonId ?? null, DEFAULT_ROLE]
  )
}

export async function patchMealRecipe(
  mealId: string,
  recipeId: string,
  patch: { role?: string; sortOrder?: number; cookPersonId?: string | null }
): Promise<boolean> {
  const sets: string[] = []
  const vals: unknown[] = []
  let i = 1
  if (typeof patch.role === 'string') {
    sets.push(`role = $${i++}`)
    vals.push(patch.role.trim() || DEFAULT_ROLE)
  }
  if (typeof patch.sortOrder === 'number') {
    sets.push(`sort_order = $${i++}`)
    vals.push(patch.sortOrder)
  }
  if ('cookPersonId' in patch) {
    sets.push(`cook_person_id = $${i++}`)
    vals.push(patch.cookPersonId ?? null)
  }
  if (!sets.length) return true
  vals.push(mealId, recipeId)
  const { rowCount } = await query(
    `update meal_recipes set ${sets.join(', ')} where meal_id = $${i++} and recipe_id = $${i++}`,
    vals
  )
  return !!rowCount
}

export async function removeMealRecipe(mealId: string, recipeId: string): Promise<boolean> {
  const { rowCount } = await query(`delete from meal_recipes where meal_id = $1 and recipe_id = $2`, [mealId, recipeId])
  return !!rowCount
}

// Reorder the plate. Ids not on the plate are ignored; dishes the caller left out
// keep their relative order and sort after the listed ones.
export async function reorderMealRecipes(householdId: string, mealId: string, recipeIds: string[]): Promise<void> {
  const current = await listMealRecipes(householdId, mealId)
  const wanted = recipeIds.filter((id) => current.some((c) => c.recipe_id === id))
  const rest = current.map((c) => c.recipe_id).filter((id) => !wanted.includes(id))
  const order = [...wanted, ...rest]
  for (const [i, recipeId] of order.entries()) {
    await query(`update meal_recipes set sort_order = $1 where meal_id = $2 and recipe_id = $3`, [i, mealId, recipeId])
  }
}

// Decision 12 — adding a SAVED MEAL to a plate under construction FLATTENS it: its
// recipes come in as individual, editable dishes (roles + cooks preserved), appended
// in the source plate's order. Meals never nest.
export async function flattenMealInto(householdId: string, targetMealId: string, sourceMealId: string): Promise<void> {
  const dishes = await listMealRecipes(householdId, sourceMealId)
  let order = await nextSortOrder(targetMealId)
  for (const d of dishes) {
    await setMealRecipe(targetMealId, {
      recipeId: d.recipe_id,
      role: d.role,
      sortOrder: order++,
      cookPersonId: d.cook_person_id,
    })
  }
}

// Copy a plate (a new unsaved meal with the same dishes). Scheduling a SAVED meal
// copies it, so editing next week's BBQ Sunday doesn't rewrite the plate that already
// went out last week.
export async function copyMeal(tenant: Tenant, sourceMealId: string): Promise<MealRow> {
  const src = await getMeal(tenant.householdId, sourceMealId)
  if (!src) throw new Error('meal not found')
  const copy = await createMeal(tenant, { name: src.name, servings: src.servings, isSaved: false })
  await flattenMealInto(tenant.householdId, copy.id, sourceMealId)
  return copy
}

function minutesFor(r: MealRecipeRow): number | null {
  const p = r.prep_time_minutes
  const c = r.cook_time_minutes
  if (p == null && c == null) return null
  return (p ?? 0) + (c ?? 0)
}

export function presentMealRecipe(r: MealRecipeRow, onHand?: { onHand: OnHandCount | null; toBuy: number }) {
  return {
    recipeId: r.recipe_id,
    title: r.title,
    emoji: r.emoji,
    category: r.category,
    role: r.role,
    sortOrder: r.sort_order,
    prepTimeMinutes: r.prep_time_minutes,
    cookTimeMinutes: r.cook_time_minutes,
    servings: r.recipe_servings,
    imageUrl: mediaUrl(r.storage_key) ?? r.image_url,
    cook: r.cook_person_id
      ? { personId: r.cook_person_id, name: r.cook_name, avatarEmoji: r.cook_avatar, colorHex: r.cook_color }
      : null,
    // Pantry-derived; null when the pantry module is off (see modules gate in
    // pantry/on-hand.ts) — clients render nothing rather than a fake "0 of N".
    onHand: onHand?.onHand ?? null,
    toBuy: onHand?.toBuy ?? 0,
  }
}

// The full plate DTO — the builder screen, the meal detail and the library card all
// read this shape (the library list just carries fewer dish fields).
export async function presentMeal(householdId: string, meal: MealRow, dishes?: MealRecipeRow[]) {
  const rows = dishes ?? (await listMealRecipes(householdId, meal.id))
  const counts = await onHandForRecipes(householdId, rows.map((r) => r.recipe_id))
  const mins = rows.map(minutesFor).filter((m): m is number => m != null)
  return {
    id: meal.id,
    name: meal.name,
    servings: meal.servings,
    isSaved: meal.is_saved,
    createdBy: meal.created_by,
    createdAt: meal.created_at,
    recipeCount: rows.length,
    emojis: rows.map((r) => r.emoji).filter((e): e is string => !!e),
    totalMinutes: mins.length ? mins.reduce((a, b) => a + b, 0) : null,
    // Plate-level counts dedupe shared ingredients across dishes (two dishes both
    // wanting mayonnaise is ONE thing to buy) — the same rule the grocery build uses.
    onHand: counts.total.onHand,
    toBuy: counts.total.toBuy,
    recipes: rows.map((r) => presentMealRecipe(r, counts.byRecipe.get(r.recipe_id))),
  }
}

// The saved-meal library: list + search. `q` matches the plate name or any dish
// title, so "chicken" finds "BBQ Sunday".
export async function listMeals(householdId: string, opts: { q?: string; limit?: number } = {}) {
  const q = (opts.q ?? '').trim()
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 100)))
  const { rows } = await query<MealRow>(
    `select m.* from meals m
      where m.household_id = $1 and m.deleted_at is null and m.is_saved
        and ($2::text is null or m.name ilike '%' || $2 || '%'
             or exists (select 1 from meal_recipes mr
                          join recipes r on r.id = mr.recipe_id and r.deleted_at is null
                         where mr.meal_id = m.id and r.title ilike '%' || $2 || '%'))
      order by m.created_at desc
      limit $3`,
    [householdId, q || null, limit]
  )
  return Promise.all(rows.map((m) => presentMeal(householdId, m)))
}
