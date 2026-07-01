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

// A recipe you can make right now (nothing to buy). `have` = the non-staple
// ingredients you have (rendered as checked chips); `expiringItem` flags one that's
// about to spoil ("uses beef due today").
export interface CookReady {
  recipeId: string
  title: string
  emoji: string | null
  have: string[]
  expiringItem: string | null
}

// A recipe under a "main" group — you have its protein, need a few more things.
export interface CookMainRecipe { recipeId: string; title: string; have: number; total: number; missing: string[] }

// A "main" (protein) you have on hand: the on-hand item header (qty + expiry), the
// total library recipes for it (the whole group taps through to the filtered library),
// and the top few recipes you're closest to making.
export interface CookMain {
  protein: string
  item: { name: string; amount: string; unit: string; expiresOn: string | null } | null
  count: number
  recipes: CookMainRecipe[]
}

const MAX_RESULTS = 12 // cap the ready-now list so a big library doesn't flood the card

// Days until a YYYY-MM-DD date (null if none); negative = past.
function daysUntil(d: string | null): number | null {
  if (!d) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((new Date(`${d}T00:00:00`).getTime() - today.getTime()) / 86_400_000)
}

interface OnHand { name: string; amount: string; unit: string; tokens: Set<string>; expiring: boolean; expiresOn: string | null }

async function pantryOnHand(householdId: string): Promise<OnHand[]> {
  // is_meal items are finished meals (a frozen pot pie, leftovers) — not cooking
  // ingredients — so they don't count toward matching a recipe's ingredients/protein.
  const { rows } = await query<{ name: string; amount: string | null; unit: string | null; expires_on: string | null }>(
    `select name, amount, unit, expires_on::text as expires_on from pantry_items
       where household_id = $1 and used_up_at is null and deleted_at is null and is_meal = false`,
    [householdId]
  )
  return rows.map((r) => {
    const d = daysUntil(r.expires_on)
    return { name: r.name, amount: r.amount ?? '', unit: r.unit ?? '', tokens: tokens(r.name), expiring: d != null && d <= 3, expiresOn: r.expires_on }
  })
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

// Recipes you can cook right now ("ready" — nothing to buy), plus the "mains" (proteins)
// you have on hand that the library has recipes for. Rather than list every recipe for a
// protein you own, we surface the protein as a chip → the recipe library filtered to it.
export async function cookableRecipes(householdId: string): Promise<{ ready: CookReady[]; mains: CookMain[] }> {
  await ensureDefaultStaples(householdId)
  const staples = new Set((await listPantryStaples(householdId)).map((s) => s.name.trim().toLowerCase()))
  const onHand = await pantryOnHand(householdId)
  const { recipes, byRecipe } = await recipeIngredients(householdId)

  const ready: Array<CookReady & { sortExp: boolean }> = []
  const proteinTotals = new Map<string, number>() // protein → recipes in the library
  const mainAgg = new Map<string, { item: OnHand; recipes: CookMainRecipe[] }>()
  for (const r of recipes) {
    if (r.protein) proteinTotals.set(r.protein, (proteinTotals.get(r.protein) ?? 0) + 1)
    const ings = byRecipe.get(r.id) ?? []
    const required = ings.filter((i) => !i.is_staple && !staples.has(i.name.trim().toLowerCase()))
    if (required.length === 0) continue
    const proteinTok = r.protein ? tokens(r.protein) : null
    const have: string[] = []
    const missing: string[] = []
    let expiringItem: string | null = null
    let mainHit: OnHand | null = null
    for (const ing of required) {
      const ingTok = tokens(ing.name)
      const hit = onHand.find((o) => matches(ingTok, o.tokens))
      if (hit) {
        have.push(ing.name.trim())
        if (hit.expiring && !expiringItem) expiringItem = hit.name
        if (proteinTok && proteinTok.size && matches(proteinTok, ingTok)) mainHit = hit
      } else missing.push(ing.name.trim())
    }
    if (missing.length === 0) {
      ready.push({ recipeId: r.id, title: r.title, emoji: r.emoji, have, expiringItem, sortExp: !!expiringItem })
    } else if (mainHit && r.protein) {
      // You have this protein but still need a few things → goes under its "main" group.
      const agg = mainAgg.get(r.protein) ?? { item: mainHit, recipes: [] }
      agg.recipes.push({ recipeId: r.id, title: r.title, have: required.length - missing.length, total: required.length, missing })
      mainAgg.set(r.protein, agg)
    }
  }
  ready.sort((a, b) => Number(b.sortExp) - Number(a.sortExp) || a.title.localeCompare(b.title))

  const expDays = (m: CookMain) => daysUntil(m.item?.expiresOn ?? null) ?? Infinity
  const mains: CookMain[] = [...mainAgg.entries()].map(([protein, agg]) => ({
    protein,
    item: { name: agg.item.name, amount: agg.item.amount, unit: agg.item.unit, expiresOn: agg.item.expiresOn },
    count: proteinTotals.get(protein) ?? agg.recipes.length,
    recipes: agg.recipes.sort((a, b) => a.missing.length - b.missing.length || a.title.localeCompare(b.title)).slice(0, 3),
  }))
  mains.sort((a, b) => expDays(a) - expDays(b) || b.count - a.count)

  return { ready: ready.slice(0, MAX_RESULTS).map(({ sortExp, ...r }) => r), mains } // eslint-disable-line @typescript-eslint/no-unused-vars
}

// A pantry item that a just-cooked recipe likely used, with a suggested action:
//   used_up   → mark the item gone (single unit, non-numeric, or amount ≤ 1)
//   decrement → knock one off a countable amount (numeric > 1)
//   skip      → a staple (salt/oil/…) we shouldn't nag you to restock
export type ConsumeMode = 'used_up' | 'decrement' | 'skip'
export interface RecipeMatch {
  id: string
  name: string
  amount: string
  unit: string
  isStaple: boolean
  suggested: ConsumeMode
}

// Which on-hand pantry items match this recipe's ingredients (for the "Used from your
// pantry" confirm sheet after marking cooked). Same token-subset match as cookable, but
// keyed to item ids so the client can post back a consume list.
export async function pantryMatchesForRecipe(householdId: string, recipeId: string): Promise<RecipeMatch[]> {
  await ensureDefaultStaples(householdId)
  const staples = new Set((await listPantryStaples(householdId)).map((s) => s.name.trim().toLowerCase()))
  const { rows: items } = await query<{ id: string; name: string; amount: string | null; unit: string | null }>(
    `select id, name, amount, unit from pantry_items
       where household_id = $1 and used_up_at is null and deleted_at is null and is_meal = false`,
    [householdId]
  )
  const { rows: ings } = await query<{ name: string; is_staple: boolean }>(
    `select name, is_staple from recipe_ingredients where household_id = $1 and recipe_id = $2 and deleted_at is null`,
    [householdId, recipeId]
  )
  const ingToks = ings.map((i) => ({ tok: tokens(i.name), isStaple: i.is_staple || staples.has(i.name.trim().toLowerCase()) }))

  const out: RecipeMatch[] = []
  for (const it of items) {
    const itTok = tokens(it.name)
    const hit = ingToks.find((i) => matches(i.tok, itTok))
    if (!hit) continue
    const amountNum = Number((it.amount ?? '').trim())
    const isStaple = hit.isStaple || staples.has(it.name.trim().toLowerCase())
    const suggested: ConsumeMode = isStaple ? 'skip' : Number.isFinite(amountNum) && amountNum > 1 ? 'decrement' : 'used_up'
    out.push({ id: it.id, name: it.name, amount: it.amount ?? '', unit: it.unit ?? '', isStaple, suggested })
  }
  // Non-staples first, then alphabetical, so the actionable rows lead.
  out.sort((a, b) => Number(a.isStaple) - Number(b.isStaple) || a.name.localeCompare(b.name))
  return out
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
