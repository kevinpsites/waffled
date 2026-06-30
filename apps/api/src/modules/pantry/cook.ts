// "Cook from your pantry" — deterministic, staple-aware matching of recipes against
// what's on hand. A recipe is "makeable" when every non-staple ingredient matches a
// pantry item; "nearly" when only 1–2 are missing. No AI: name matching is token-
// subset (so "ground beef" ↔ "beef, ground", "chicken" ↔ "chicken breast", but not
// "egg" ↔ "eggplant").
import { query } from '../../platform/db'
import { listPantryStaples, ensureDefaultStaples } from '../lists/lists.service'

const STOPWORDS = new Set(['and', 'the', 'with', 'for', 'fresh', 'large', 'small', 'whole', 'ground'])

// Significant tokens of a name (lowercased words, length ≥ 3, minus stopwords).
// `ground` is a stopword on its own but kept as part of multi-word matches via subset.
function tokens(name: string): Set<string> {
  return new Set(
    name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  )
}

// True when one token set is a (non-empty) subset of the other.
function matches(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return false
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const t of small) if (!big.has(t)) return false
  return true
}

export interface CookableRecipe {
  recipeId: string
  title: string
  emoji: string | null
  total: number
  onHand: number
  missing: string[]
  usesExpiring: boolean
  mainItem: string | null // the on-hand item that is the recipe's protein/"main", if any
}

const COVERAGE_FALLBACK = 0.6 // when a recipe has no protein tagged, "have the main" ≈ this much on hand
const MAX_MISSING_MAIN = 4 // "have the main" = the main + only a few sides to buy (not a whole shop)
const MAX_RESULTS = 12 // cap each tier so a big recipe library doesn't flood the card

// Days until a YYYY-MM-DD date (null if none); negative = past.
function daysUntil(d: string | null): number | null {
  if (!d) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((new Date(`${d}T00:00:00`).getTime() - today.getTime()) / 86_400_000)
}

interface OnHand { name: string; tokens: Set<string>; expiring: boolean }

async function pantryOnHand(householdId: string): Promise<OnHand[]> {
  // is_meal items are finished meals (a frozen pot pie, leftovers) — not cooking
  // ingredients — so they don't count toward matching a recipe's ingredients/protein.
  const { rows } = await query<{ name: string; expires_on: string | null }>(
    `select name, expires_on::text as expires_on from pantry_items
       where household_id = $1 and used_up_at is null and deleted_at is null and is_meal = false`,
    [householdId]
  )
  return rows.map((r) => { const d = daysUntil(r.expires_on); return { name: r.name, tokens: tokens(r.name), expiring: d != null && d <= 3 } })
}

// All recipes with their ingredients, in one pass (avoids N+1).
async function recipeIngredients(householdId: string) {
  const recipes = await query<{ id: string; title: string; emoji: string | null; protein: string | null }>(
    `select id, title, emoji, protein from recipes where household_id = $1 and deleted_at is null order by title`,
    [householdId]
  )
  const ings = await query<{ recipe_id: string; name: string; is_staple: boolean }>(
    `select recipe_id, name, is_staple from recipe_ingredients where household_id = $1 and deleted_at is null`,
    [householdId]
  )
  const byRecipe = new Map<string, { name: string; is_staple: boolean }[]>()
  for (const i of ings.rows) (byRecipe.get(i.recipe_id) ?? byRecipe.set(i.recipe_id, []).get(i.recipe_id)!).push(i)
  return { recipes: recipes.rows, byRecipe }
}

// Recipes you can cook now ("ready", nothing to buy) and ones where you already have
// the MAIN ingredient ("haveMain") — the recipe's protein is on hand (or, when no
// protein is tagged, you have most of it) even if a few sides are missing. The point:
// lean into the protein you already own instead of buying a new one.
export async function cookableRecipes(householdId: string): Promise<{ ready: CookableRecipe[]; haveMain: CookableRecipe[] }> {
  await ensureDefaultStaples(householdId)
  const staples = new Set((await listPantryStaples(householdId)).map((s) => s.name.trim().toLowerCase()))
  const onHand = await pantryOnHand(householdId)
  const { recipes, byRecipe } = await recipeIngredients(householdId)

  const ready: CookableRecipe[] = []
  const haveMain: CookableRecipe[] = []
  for (const r of recipes) {
    const ings = byRecipe.get(r.id) ?? []
    const required = ings.filter((i) => !i.is_staple && !staples.has(i.name.trim().toLowerCase()))
    if (required.length === 0) continue
    const proteinTok = r.protein ? tokens(r.protein) : null
    const missing: string[] = []
    let usesExpiring = false
    let mainItem: string | null = null // the on-hand item that is the recipe's protein
    for (const ing of required) {
      const ingTok = tokens(ing.name)
      const hit = onHand.find((o) => matches(ingTok, o.tokens))
      if (hit) { if (hit.expiring) usesExpiring = true } else { missing.push(ing.name.trim()); continue }
      // Is THIS ingredient the recipe's protein, and is it the one we have on hand?
      // (ties "the main" to the actual protein ingredient, not a coincidental meal).
      if (proteinTok && proteinTok.size && matches(proteinTok, ingTok)) mainItem = hit.name
    }
    const coverage = (required.length - missing.length) / required.length
    const entry: CookableRecipe = {
      recipeId: r.id, title: r.title, emoji: r.emoji, total: required.length,
      onHand: required.length - missing.length, missing, usesExpiring, mainItem,
    }
    if (missing.length === 0) { ready.push(entry); continue }
    // "Have the main": if you genuinely have the recipe's protein on hand, show it no
    // matter how many sides are missing — the point is you own the protein and will buy
    // the sides. The tight "only a few missing" cap applies only to the no-protein
    // "you already have most of it" fallback.
    const haveMost = !r.protein && required.length >= 3 && coverage >= COVERAGE_FALLBACK
    if (mainItem || (haveMost && missing.length <= MAX_MISSING_MAIN)) haveMain.push(entry)
  }
  ready.sort((a, b) => Number(b.usesExpiring) - Number(a.usesExpiring) || a.title.localeCompare(b.title))
  // Have-the-main: fewest missing first (closest to ready), then uses-expiring.
  haveMain.sort((a, b) => a.missing.length - b.missing.length || Number(b.usesExpiring) - Number(a.usesExpiring) || a.title.localeCompare(b.title))
  return { ready: ready.slice(0, MAX_RESULTS), haveMain: haveMain.slice(0, MAX_RESULTS) }
}

// Recipes whose ingredients include a given item (for the detail "Plan it in").
export async function recipesUsingItem(householdId: string, itemName: string): Promise<Array<{ recipeId: string; title: string; emoji: string | null }>> {
  const target = tokens(itemName)
  if (!target.size) return []
  const { recipes, byRecipe } = await recipeIngredients(householdId)
  const out: Array<{ recipeId: string; title: string; emoji: string | null }> = []
  for (const r of recipes) {
    const ings = byRecipe.get(r.id) ?? []
    if (ings.some((i) => matches(target, tokens(i.name)))) out.push({ recipeId: r.id, title: r.title, emoji: r.emoji })
  }
  return out
}
