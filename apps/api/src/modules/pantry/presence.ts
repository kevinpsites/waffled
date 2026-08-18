// "Do we have this right now?" — the DB-backed presence layer for the pantry.
//
// This is the SINGLE definition of what a household has on hand, and it deliberately
// lives below both of its consumers so neither has to import the other:
//
//   pantry/on-hand.ts   counts a recipe's ingredients (the recipe banner, plates)
//   lists/lists.service groceryBoard's per-row "you already have this" badge
//
// lists.service is what owns pantry *staples*, and on-hand.ts imports it for them — so
// putting the pantry read here (importing only db/modules/match) is what keeps
// lists.service ↔ on-hand.ts from becoming a cycle.
//
// Matching is presence-only (see ./match): quantities and units are NEVER compared. That
// is why a hit carries the pantry item's own amount rather than a verdict — "you have a
// bag of rice" is a claim the data supports; "a bag is enough for 2 cups" is not. Callers
// show the amount and let a person judge.
import { query } from '../../platform/db'
import { moduleEnabled } from '../../platform/modules'
import { tokens, matches } from './match'

// The pantry item covering an ingredient. `amount`/`unit` are free text ("2", "half",
// "1", "bag") — they are for display, never for arithmetic.
export interface PantryHit {
  name: string
  amount: string
  unit: string
}

export interface PantryOnHand {
  hit: PantryHit
  tok: Set<string>
}

export async function pantryModuleEnabled(householdId: string): Promise<boolean> {
  const { rows } = await query<{ settings: unknown }>(`select settings from households where id = $1`, [householdId])
  return moduleEnabled(rows[0]?.settings, 'pantry')
}

// The raw on-hand read, with no module gate — for callers that have already checked.
// The three predicates are the whole contract and must not be duplicated with drift:
//   used_up_at is null — stepping an item below one marks it used up, not deleted
//   deleted_at is null — soft deletes
//   is_meal = false    — leftovers / a frozen pot pie are finished MEALS, not cooking
//                        ingredients, so they never satisfy an ingredient
export async function queryPantryOnHand(householdId: string): Promise<PantryOnHand[]> {
  const { rows } = await query<{ name: string; amount: string | null; unit: string | null }>(
    `select name, amount, unit from pantry_items
       where household_id = $1 and used_up_at is null and deleted_at is null and is_meal = false`,
    [householdId]
  )
  return rows.map((r) => ({
    hit: { name: r.name, amount: r.amount ?? '', unit: r.unit ?? '' },
    tok: tokens(r.name),
  }))
}

// Everything on hand, or null when the pantry module is OFF. null is load-bearing: with
// the module off we do not know what's in the house, and "nothing" would be a lie — so
// callers must make no on-hand claim at all rather than render an empty/zero one.
export async function loadPantryHits(householdId: string): Promise<PantryOnHand[] | null> {
  if (!(await pantryModuleEnabled(householdId))) return null
  return queryPantryOnHand(householdId)
}

// Match a set of names (grocery rows, recipe ingredients) against what's on hand.
// Returns a map keyed by each name's trimmed+lowercased form → the covering pantry item;
// names with no match are simply absent. null ⇒ the pantry module is off (see above).
export async function pantryHitsForNames(
  householdId: string,
  names: readonly string[]
): Promise<Map<string, PantryHit> | null> {
  const onHand = await loadPantryHits(householdId)
  if (!onHand) return null
  return matchNames(onHand, names)
}

// The pure half, so a caller holding an already-loaded pantry can reuse it.
export function matchNames(onHand: readonly PantryOnHand[], names: readonly string[]): Map<string, PantryHit> {
  const out = new Map<string, PantryHit>()
  // Memoised per key including misses — a week's grocery list repeats names across
  // recipes, and re-running the token match for a known miss is pure waste.
  const seen = new Map<string, PantryHit | null>()
  for (const name of names) {
    const key = name.trim().toLowerCase()
    if (!key) continue
    let hit = seen.get(key)
    if (hit === undefined) {
      hit = bestMatch(onHand, name)
      seen.set(key, hit)
    }
    if (hit) out.set(key, hit)
  }
  return out
}

// One name can match several pantry rows at once — "Chicken" is a token-subset of both
// "Chicken" and "Chicken breast" — and the badge NAMES the row it picked, so the pick is
// user-visible. Taking the first row that matched made that depend on Postgres's return
// order, i.e. on insert history: the same pantry could show "Chicken" today and "Chicken
// breast" tomorrow. Rank instead, most-specific-first:
//   1. the same name (a pantry row literally called "Chicken" beats anything else)
//   2. the fewest extra words ("Chicken" → "Chicken breast", not "Boneless chicken
//      breast tenderloin")
//   3. alphabetical, purely so ties are stable rather than arbitrary
// This changes WHICH row wins, never WHETHER one does — a generic match with no better
// candidate is still reported, because the badge names it and the cook can judge.
function bestMatch(onHand: readonly PantryOnHand[], name: string): PantryHit | null {
  const tok = tokens(name)
  const key = name.trim().toLowerCase()
  let best: PantryOnHand | null = null
  let bestScore = 0
  for (const o of onHand) {
    if (!matches(tok, o.tok)) continue
    const score = o.hit.name.trim().toLowerCase() === key ? -1 : Math.abs(o.tok.size - tok.size)
    if (!best || score < bestScore || (score === bestScore && o.hit.name.localeCompare(best.hit.name) < 0)) {
      best = o
      bestScore = score
    }
  }
  return best?.hit ?? null
}
