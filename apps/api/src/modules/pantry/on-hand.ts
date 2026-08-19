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
import { listPantryStaples } from '../lists/lists.service'
import { tokens, matches } from './match'
// The pantry read itself lives in ./presence — shared with groceryBoard's per-row badge,
// so both surfaces agree about which items count (used-up, soft-deleted, is_meal).
import { pantryModuleEnabled, queryPantryOnHand } from './presence'

export { pantryModuleEnabled }

export interface OnHandCount {
  have: number
  total: number
}

export interface RecipeOnHand {
  // null ⇒ the pantry module is off; the client shows no on-hand claim at all.
  onHand: OnHandCount | null
  toBuy: number
  // The ingredients behind `toBuy`, in recipe order — a count on its own tells you
  // the size of the problem and nothing about its content. Always exactly `toBuy`
  // long, with pantry off or on.
  toBuyNames: string[]
}

export interface OnHandResult {
  pantryEnabled: boolean
  byRecipe: Map<string, RecipeOnHand>
  // Across the whole set, deduped by ingredient name — two dishes both wanting
  // mayonnaise is ONE thing to have/buy, matching how the grocery build aggregates.
  total: RecipeOnHand
}

// Everything the counting needs, read ONCE. Hold one of these across a whole
// library page (many plates) so the per-plate counts stay four queries in total
// rather than four per plate.
export interface OnHandContext {
  pantryEnabled: boolean
  // recipe id → its non-staple ("required") ingredient names
  required: Map<string, string[]>
  // lowercased ingredient name → is it on hand? (memoised across every plate)
  matchCache: Map<string, boolean>
  onHandTokens: Array<Set<string>>
}

const EMPTY = (pantryEnabled: boolean): OnHandResult => ({
  pantryEnabled,
  byRecipe: new Map(),
  total: { onHand: pantryEnabled ? { have: 0, total: 0 } : null, toBuy: 0, toBuyNames: [] },
})

// One settings read, one staples read, one ingredients read, one pantry read —
// for however many recipes you name.
export async function loadOnHandContext(householdId: string, recipeIds: readonly string[]): Promise<OnHandContext> {
  const ids = [...new Set(recipeIds)].filter(Boolean)
  const pantryEnabled = await pantryModuleEnabled(householdId)
  const ctx: OnHandContext = { pantryEnabled, required: new Map(), matchCache: new Map(), onHandTokens: [] }
  if (!ids.length) return ctx

  const staples = new Set((await listPantryStaples(householdId)).map((s) => s.name.trim().toLowerCase()))
  const { rows: ings } = await query<{ recipe_id: string; name: string; is_staple: boolean }>(
    `select recipe_id, name, is_staple from recipe_ingredients
      where household_id = $1 and recipe_id = any($2::uuid[]) and deleted_at is null`,
    [householdId, ids]
  )
  // Required = non-staple, via the established dual mechanism: the ingredient's own
  // is_staple flag OR a name in the household's pantry_staples. Staples are a *lists*
  // concept, so this filtering is independent of the pantry module.
  for (const id of ids) ctx.required.set(id, [])
  for (const i of ings) {
    if (i.is_staple || staples.has(i.name.trim().toLowerCase())) continue
    ctx.required.get(i.recipe_id)?.push(i.name)
  }

  // Gated above, so this takes the ungated read directly. Which items count (used up,
  // soft-deleted, is_meal) is ./presence's call, shared with the grocery badge.
  if (pantryEnabled) ctx.onHandTokens = (await queryPantryOnHand(householdId)).map((o) => o.tok)
  return ctx
}

// Pure counting over a loaded context — no I/O, so a library page can call it once
// per plate for free.
export function countOnHand(ctx: OnHandContext, recipeIds: readonly string[]): OnHandResult {
  const ids = [...new Set(recipeIds)].filter(Boolean)
  if (!ids.length) return EMPTY(ctx.pantryEnabled)

  const hasIt = (name: string): boolean => {
    if (!ctx.pantryEnabled) return false
    const key = name.trim().toLowerCase()
    const cached = ctx.matchCache.get(key)
    if (cached != null) return cached
    const t = tokens(name)
    const hit = ctx.onHandTokens.some((o) => matches(t, o))
    ctx.matchCache.set(key, hit)
    return hit
  }

  const byRecipe = new Map<string, RecipeOnHand>()
  // Deduped across the whole set: two dishes both wanting mayonnaise is ONE thing to
  // have/buy, matching how the grocery build aggregates.
  const seenNames = new Map<string, boolean>()
  // Deduped by lowercased name but displayed in its original casing — first spelling
  // encountered wins, so "Mayonnaise" doesn't become "mayonnaise" for the plate.
  const firstSpelling = new Map<string, string>()
  for (const id of ids) {
    let have = 0
    const names = ctx.required.get(id) ?? []
    const toBuyNames: string[] = []
    for (const name of names) {
      const matched = hasIt(name)
      if (matched) have += 1
      else toBuyNames.push(name)
      const key = name.trim().toLowerCase()
      if (!seenNames.has(key)) {
        seenNames.set(key, matched)
        firstSpelling.set(key, name)
      }
    }
    byRecipe.set(id, {
      onHand: ctx.pantryEnabled ? { have, total: names.length } : null,
      toBuy: names.length - (ctx.pantryEnabled ? have : 0),
      toBuyNames,
    })
  }

  const totalCount = seenNames.size
  const totalHave = [...seenNames.values()].filter(Boolean).length
  return {
    pantryEnabled: ctx.pantryEnabled,
    byRecipe,
    total: {
      onHand: ctx.pantryEnabled ? { have: totalHave, total: totalCount } : null,
      toBuy: totalCount - (ctx.pantryEnabled ? totalHave : 0),
      toBuyNames: [...seenNames.entries()].filter(([, m]) => !m).map(([k]) => firstSpelling.get(k) ?? k),
    },
  }
}

// On-hand + to-buy counts for a set of recipes, in one pass (no N+1).
export async function onHandForRecipes(householdId: string, recipeIds: readonly string[]): Promise<OnHandResult> {
  const ctx = await loadOnHandContext(householdId, recipeIds)
  return countOnHand(ctx, recipeIds)
}

// Convenience for the single-recipe case (the recipe-detail banner).
export async function onHandForRecipe(householdId: string, recipeId: string): Promise<RecipeOnHand> {
  const res = await onHandForRecipes(householdId, [recipeId])
  return res.byRecipe.get(recipeId) ?? { onHand: res.pantryEnabled ? { have: 0, total: 0 } : null, toBuy: 0, toBuyNames: [] }
}
