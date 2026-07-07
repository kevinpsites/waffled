// Pantry module — client slice (REST). Gated behind the optional `pantry` module.
import { useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'

// Open Food Facts nutrition snapshot (per-serving or per-100g). Keys are optional —
// OFF coverage varies. nutrition/allergens are null when an item was added manually.
export interface PantryNutrition {
  calories?: number
  protein_g?: number
  fat_g?: number
  carbs_g?: number
  sodium_mg?: number
}

// The OFF fields carried by both a looked-up product and a pantry item's snapshot.
export interface OffFields {
  barcode: string | null
  brand: string | null
  imageUrl: string | null
  quantityText: string | null
  servingBasis: string | null
  nutrition: PantryNutrition | null
  allergens: string[] | null
  traces: string[] | null
  dietary: string[] | null
  source: string | null
}

export interface PantryItem extends OffFields {
  id: string
  name: string
  amount: string
  unit: string
  location: string
  expiresOn: string | null
  note: string
  usedUp: boolean
  lowAt: number | null
  isMeal: boolean
  addedOn: string
  createdAt: string
}

// A normalized Open Food Facts product (from GET /api/pantry/lookup/:barcode).
export interface OffProduct {
  barcode: string
  name: string | null
  brand: string | null
  imageUrl: string | null
  quantityText: string | null
  servingBasis: string | null
  nutrition: PantryNutrition
  allergens: string[]
  traces: string[]
  dietary: string[]
  nutriscore: string | null
  nova: number | null
  source: string
  fetchedAt: string
}

export type PantryItemInput = {
  name?: string
  amount?: string
  unit?: string
  location?: string
  expiresOn?: string | null
  note?: string
  usedUp?: boolean
  lowAt?: number | null
  isMeal?: boolean
  addedOn?: string
  // OFF snapshot — set when adding/editing via a barcode lookup.
  barcode?: string | null
  brand?: string | null
  imageUrl?: string | null
  quantityText?: string | null
  servingBasis?: string | null
  nutrition?: PantryNutrition | null
  allergens?: string[] | null
  traces?: string[] | null
  dietary?: string[] | null
  source?: string | null
}

// Canonical allergen keys (match the backend + OFF normalizer) with display labels.
// Display labels for the canonical allergen keys. `milk` is OFF's tag for all dairy,
// so we surface it as "Dairy".
export const ALLERGEN_LABELS: Record<string, string> = {
  gluten: 'Gluten', milk: 'Dairy', soy: 'Soy', egg: 'Egg', peanut: 'Peanut',
  tree_nut: 'Tree nut', fish: 'Fish', shellfish: 'Shellfish', sesame: 'Sesame',
}
export const ALLERGEN_KEYS = Object.keys(ALLERGEN_LABELS)

// Attribution labels for the Open * Facts database a product came from. Non-food
// items resolve from the sibling databases; we credit whichever answered.
export const PRODUCT_SOURCE_LABELS: Record<string, string> = {
  openfoodfacts: 'Open Food Facts',
  openbeautyfacts: 'Open Beauty Facts',
  openproductsfacts: 'Open Products Facts',
  openpetfoodfacts: 'Open Pet Food Facts',
  manual: 'Saved by your family', // recalled from a past manual scan-and-name
}
// A friendly attribution for an item's `source`, or null for manual/unknown adds.
export function productSourceLabel(source: string | null | undefined): string | null {
  return source ? PRODUCT_SOURCE_LABELS[source] ?? null : null
}

// "Cook from your pantry" payload (from /api/pantry/cookable).
export interface CookReady { recipeId: string; title: string; emoji: string | null; have: string[]; expiringItem: string | null }
export interface CookMainRecipe { recipeId: string; title: string; have: number; total: number; missing: string[] }
export interface CookMain {
  protein: string
  item: { name: string; amount: string; unit: string; expiresOn: string | null } | null
  count: number
  recipes: CookMainRecipe[]
}
export interface ItemRecipe { recipeId: string; title: string; emoji: string | null }

// "Used from your pantry" confirm sheet: items a just-cooked recipe likely used, with
// a suggested action (skip = a staple we don't nag you to restock).
export type ConsumeMode = 'used_up' | 'decrement' | 'skip'
export interface RecipeMatch { id: string; name: string; amount: string; unit: string; isStaple: boolean; suggested: ConsumeMode }

// Dietary flags captured from Open Food Facts (ingredients analysis).
export const DIETARY_LABELS: Record<string, string> = {
  vegan: 'Vegan', vegetarian: 'Vegetarian', palm_oil_free: 'Palm-oil-free',
}

export const pantryApi = {
  list: () => apiGet<{ items: PantryItem[]; locations: string[]; showOnToday: boolean; avoidAllergens: string[]; allergenPeople: Record<string, string[]>; lowThreshold: number; locationIcons: Record<string, string>; staleMonths: number }>('/api/pantry'),
  create: (input: PantryItemInput) => apiSend<{ item: PantryItem }>('POST', '/api/pantry', input).then((r) => r.item),
  // Scan upsert: increments a matching on-hand item (by barcode, else name) instead
  // of duplicating. Returns whether it incremented an existing item.
  scan: (input: PantryItemInput) => apiSend<{ item: PantryItem; incremented: boolean }>('POST', '/api/pantry/scan', input),
  update: (id: string, patch: PantryItemInput) => apiSend<{ item: PantryItem }>('PATCH', `/api/pantry/${id}`, patch).then((r) => r.item),
  remove: (id: string) => apiDelete(`/api/pantry/${id}`),
  // Barcode → Open Food Facts product (cached server-side). Returns null if not found.
  lookup: (barcode: string) =>
    apiGet<{ found: boolean; product?: OffProduct }>(`/api/pantry/lookup/${encodeURIComponent(barcode)}`)
      .then((r) => (r.found ? r.product! : null))
      .catch(() => null),
  // "Cook from your pantry": recipes makeable now + nearly (1–2 short).
  cookable: () => apiGet<{ ready: CookReady[]; mains: CookMain[] }>('/api/pantry/cookable'),
  // Recipes that use a given pantry item (detail "Plan it in").
  itemRecipes: (id: string) => apiGet<{ recipes: ItemRecipe[] }>(`/api/pantry/${id}/recipes`),
  // On-hand items a just-cooked recipe likely used (for the confirm sheet).
  forRecipe: (recipeId: string) => apiGet<{ matches: RecipeMatch[] }>(`/api/pantry/for-recipe/${recipeId}`).then((r) => r.matches),
  // Apply confirmed consumption; returns the updated items.
  consume: (items: Array<{ id: string; mode: 'used_up' | 'decrement' }>) =>
    apiSend<{ items: PantryItem[] }>('POST', '/api/pantry/consume', { items }).then((r) => r.items),
  // Module config: locations, Today-card toggle, avoid-allergens, the running-low
  // threshold, and/or per-location icons.
  setConfig: (patch: { locations?: string[]; showOnToday?: boolean; avoidAllergens?: string[]; lowThreshold?: number; locationIcons?: Record<string, string>; staleMonths?: number }) =>
    apiSend<{ locations: string[]; showOnToday: boolean; avoidAllergens: string[]; lowThreshold: number; locationIcons: Record<string, string>; staleMonths: number }>('PUT', '/api/pantry/config', patch),
}

export interface PantryState {
  items: PantryItem[]
  locations: string[]
  showOnToday: boolean
  avoidAllergens: string[]
  allergenPeople: Record<string, string[]>
  lowThreshold: number
  locationIcons: Record<string, string>
  staleMonths: number
  loading: boolean
  error: boolean
  refetch: () => void
}

export function usePantry(): PantryState {
  const [items, setItems] = useState<PantryItem[]>([])
  const [locations, setLocations] = useState<string[]>([])
  const [showOnToday, setShowOnToday] = useState(true)
  const [avoidAllergens, setAvoidAllergens] = useState<string[]>([])
  const [allergenPeople, setAllergenPeople] = useState<Record<string, string[]>>({})
  const [lowThreshold, setLowThreshold] = useState(1)
  const [locationIcons, setLocationIcons] = useState<Record<string, string>>({})
  const [staleMonths, setStaleMonths] = useState(6)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    pantryApi
      .list()
      .then((d) => alive && (setItems(d.items), setLocations(d.locations), setShowOnToday(d.showOnToday), setAvoidAllergens(d.avoidAllergens ?? []), setAllergenPeople(d.allergenPeople ?? {}), setLowThreshold(d.lowThreshold ?? 1), setLocationIcons(d.locationIcons ?? {}), setStaleMonths(d.staleMonths ?? 6), setLoading(false), setError(false)))
      .catch(() => alive && (setError(true), setLoading(false)))
    return () => {
      alive = false
    }
  }, [nonce])
  return { items, locations, showOnToday, avoidAllergens, allergenPeople, lowThreshold, locationIcons, staleMonths, loading, error, refetch: () => setNonce((n) => n + 1) }
}

// Months an item has been on hand (from its added_on date), and a short age label.
export function monthsOnHand(addedOn: string | null | undefined): number | null {
  if (!addedOn) return null
  const d = new Date(`${addedOn}T00:00:00`)
  if (Number.isNaN(d.getTime())) return null
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44)
}
export function ageLabel(addedOn: string | null | undefined): string {
  const m = monthsOnHand(addedOn)
  if (m == null) return ''
  const days = m * 30.44
  if (days < 14) return `${Math.max(1, Math.round(days))}d`
  if (m < 1.5) return `${Math.round(days / 7)}w`
  if (m < 12) return `${Math.round(m)} mo`
  const y = m / 12
  return y < 1.95 ? '1 yr' : `${Math.round(y)} yr`
}

// Which of an item's allergens are flagged for this household (red warnings) — the
// union of the household avoid-list and any allergen a member has.
export function flaggedAllergens(item: { allergens: string[] | null }, avoid: string[], allergenPeople: Record<string, string[]> = {}): string[] {
  if (!item.allergens) return []
  const set = new Set([...avoid, ...Object.keys(allergenPeople)])
  return item.allergens.filter((a) => set.has(a))
}

// Days until an item expires (null if no date). Negative = already past.
export function daysUntil(expiresOn: string | null): number | null {
  if (!expiresOn) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const d = new Date(`${expiresOn}T00:00:00`)
  return Math.round((d.getTime() - today.getTime()) / 86400000)
}
