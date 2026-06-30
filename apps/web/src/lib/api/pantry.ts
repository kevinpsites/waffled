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
  // OFF snapshot — set when adding/editing via a barcode lookup.
  barcode?: string | null
  brand?: string | null
  imageUrl?: string | null
  quantityText?: string | null
  servingBasis?: string | null
  nutrition?: PantryNutrition | null
  allergens?: string[] | null
  dietary?: string[] | null
  source?: string | null
}

// Canonical allergen keys (match the backend + OFF normalizer) with display labels.
export const ALLERGEN_LABELS: Record<string, string> = {
  gluten: 'Gluten', milk: 'Milk', soy: 'Soy', egg: 'Egg', peanut: 'Peanut',
  tree_nut: 'Tree nut', fish: 'Fish', shellfish: 'Shellfish', sesame: 'Sesame',
}
export const ALLERGEN_KEYS = Object.keys(ALLERGEN_LABELS)

export const pantryApi = {
  list: () => apiGet<{ items: PantryItem[]; locations: string[]; showOnToday: boolean; avoidAllergens: string[] }>('/api/pantry'),
  create: (input: PantryItemInput) => apiSend<{ item: PantryItem }>('POST', '/api/pantry', input).then((r) => r.item),
  update: (id: string, patch: PantryItemInput) => apiSend<{ item: PantryItem }>('PATCH', `/api/pantry/${id}`, patch).then((r) => r.item),
  remove: (id: string) => apiDelete(`/api/pantry/${id}`),
  // Barcode → Open Food Facts product (cached server-side). Returns null if not found.
  lookup: (barcode: string) =>
    apiGet<{ found: boolean; product?: OffProduct }>(`/api/pantry/lookup/${encodeURIComponent(barcode)}`)
      .then((r) => (r.found ? r.product! : null))
      .catch(() => null),
  // Module config: locations, the Today-card toggle, and/or the avoid-allergen list.
  setConfig: (patch: { locations?: string[]; showOnToday?: boolean; avoidAllergens?: string[] }) =>
    apiSend<{ locations: string[]; showOnToday: boolean; avoidAllergens: string[] }>('PUT', '/api/pantry/config', patch),
}

export interface PantryState {
  items: PantryItem[]
  locations: string[]
  showOnToday: boolean
  avoidAllergens: string[]
  loading: boolean
  error: boolean
  refetch: () => void
}

export function usePantry(): PantryState {
  const [items, setItems] = useState<PantryItem[]>([])
  const [locations, setLocations] = useState<string[]>([])
  const [showOnToday, setShowOnToday] = useState(true)
  const [avoidAllergens, setAvoidAllergens] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    pantryApi
      .list()
      .then((d) => alive && (setItems(d.items), setLocations(d.locations), setShowOnToday(d.showOnToday), setAvoidAllergens(d.avoidAllergens ?? []), setLoading(false), setError(false)))
      .catch(() => alive && (setError(true), setLoading(false)))
    return () => {
      alive = false
    }
  }, [nonce])
  return { items, locations, showOnToday, avoidAllergens, loading, error, refetch: () => setNonce((n) => n + 1) }
}

// Which of an item's allergens are on the household's avoid list (for red warnings).
export function flaggedAllergens(item: { allergens: string[] | null }, avoid: string[]): string[] {
  if (!item.allergens || !avoid.length) return []
  const set = new Set(avoid)
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
