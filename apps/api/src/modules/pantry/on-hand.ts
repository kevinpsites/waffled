// "How much of this do we already have?" — a general, REAL pantry-matched on-hand
// count for an arbitrary recipe or set of recipes (a Meal Builder plate, a library
// card, the recipe-detail banner). Generalised from cook.ts, which could only answer
// this for recipes inside the Cook-from-pantry modal.
//
// Two DIFFERENT numbers come out of here, and only one of them is pantry-derived:
//
//   onHand {have,total} — pantry-derived. When the household has the `pantry` module
//     OFF we do NOT know what's on hand, so this is `null` (omit it) rather than
//     `have: 0` — "you have nothing" would be a lie, and falling back to the old
//     staple-count proxy is exactly the bug this replaces.
//   toBuy — NOT pantry-derived: how many ingredients will land on the grocery list.
//     Staple exclusion is a *lists* concept, so this keeps working with pantry off.
//     Pantry ON  ⇒ non-staple AND not matched in the pantry.
//     Pantry OFF ⇒ non-staple.
//
// Matching is presence-only (see ./match) — quantities and units are never compared.
import { query } from '../../platform/db'
import { moduleEnabled } from '../../platform/modules'
import { listPantryStaples } from '../lists/lists.service'
import { tokens, matches } from './match'

export interface OnHandCount {
  have: number
  total: number
}

export interface RecipeOnHand {
  // null ⇒ the pantry module is off; the client shows no on-hand claim at all.
  onHand: OnHandCount | null
  toBuy: number
}

export interface OnHandResult {
  pantryEnabled: boolean
  byRecipe: Map<string, RecipeOnHand>
  // Across the whole set, deduped by ingredient name — two dishes both wanting
  // mayonnaise is ONE thing to have/buy, matching how the grocery build aggregates.
  total: RecipeOnHand
}

const EMPTY = (pantryEnabled: boolean): OnHandResult => ({
  pantryEnabled,
  byRecipe: new Map(),
  total: { onHand: pantryEnabled ? { have: 0, total: 0 } : null, toBuy: 0 },
})

export async function pantryModuleEnabled(householdId: string): Promise<boolean> {
  const { rows } = await query<{ settings: unknown }>(`select settings from households where id = $1`, [householdId])
  return moduleEnabled(rows[0]?.settings, 'pantry')
}

// On-hand + to-buy counts for a set of recipes, in one pass (no N+1): one settings
// read, one staples read, one ingredients read, one pantry read.
export async function onHandForRecipes(householdId: string, recipeIds: readonly string[]): Promise<OnHandResult> {
  const ids = [...new Set(recipeIds)].filter(Boolean)
  const pantryEnabled = await pantryModuleEnabled(householdId)
  if (!ids.length) return EMPTY(pantryEnabled)

  const staples = new Set((await listPantryStaples(householdId)).map((s) => s.name.trim().toLowerCase()))
  const { rows: ings } = await query<{ recipe_id: string; name: string; is_staple: boolean }>(
    `select recipe_id, name, is_staple from recipe_ingredients
      where household_id = $1 and recipe_id = any($2::uuid[]) and deleted_at is null`,
    [householdId, ids]
  )

  // is_meal items are finished meals (leftovers, a frozen pot pie) — not cooking
  // ingredients — so they never count toward having an ingredient.
  const onHandTokens: Array<Set<string>> = pantryEnabled
    ? (
        await query<{ name: string }>(
          `select name from pantry_items
            where household_id = $1 and used_up_at is null and deleted_at is null and is_meal = false`,
          [householdId]
        )
      ).rows.map((r) => tokens(r.name))
    : []

  const hasIt = (name: string) => {
    const t = tokens(name)
    return onHandTokens.some((o) => matches(t, o))
  }

  // Required = non-staple, via the established dual mechanism: the ingredient's own
  // is_staple flag OR a name in the household's pantry_staples.
  const required = ings.filter((i) => !i.is_staple && !staples.has(i.name.trim().toLowerCase()))

  const perRecipe = new Map<string, { total: number; have: number }>()
  for (const id of ids) perRecipe.set(id, { total: 0, have: 0 })
  const seenNames = new Map<string, boolean>() // deduped plate-level name → matched?

  for (const i of required) {
    const acc = perRecipe.get(i.recipe_id)
    const key = i.name.trim().toLowerCase()
    const matched = pantryEnabled ? (seenNames.has(key) ? seenNames.get(key)! : hasIt(i.name)) : false
    if (acc) {
      acc.total += 1
      if (matched) acc.have += 1
    }
    if (!seenNames.has(key)) seenNames.set(key, matched)
  }

  const byRecipe = new Map<string, RecipeOnHand>()
  for (const [id, acc] of perRecipe) {
    byRecipe.set(id, {
      onHand: pantryEnabled ? { have: acc.have, total: acc.total } : null,
      toBuy: acc.total - (pantryEnabled ? acc.have : 0),
    })
  }

  const totalCount = seenNames.size
  const totalHave = [...seenNames.values()].filter(Boolean).length
  return {
    pantryEnabled,
    byRecipe,
    total: {
      onHand: pantryEnabled ? { have: totalHave, total: totalCount } : null,
      toBuy: totalCount - (pantryEnabled ? totalHave : 0),
    },
  }
}

// Convenience for the single-recipe case (the recipe-detail banner).
export async function onHandForRecipe(householdId: string, recipeId: string): Promise<RecipeOnHand> {
  const res = await onHandForRecipes(householdId, [recipeId])
  return res.byRecipe.get(recipeId) ?? { onHand: res.pantryEnabled ? { have: 0, total: 0 } : null, toBuy: 0 }
}
