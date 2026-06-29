// Pantry module — client slice (REST). Gated behind the optional `pantry` module.
import { useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'

export interface PantryItem {
  id: string
  name: string
  amount: string
  unit: string
  location: string
  expiresOn: string | null
  note: string
}

export type PantryItemInput = {
  name?: string
  amount?: string
  unit?: string
  location?: string
  expiresOn?: string | null
  note?: string
}

export const pantryApi = {
  list: () => apiGet<{ items: PantryItem[]; locations: string[] }>('/api/pantry'),
  create: (input: PantryItemInput) => apiSend<{ item: PantryItem }>('POST', '/api/pantry', input).then((r) => r.item),
  update: (id: string, patch: PantryItemInput) => apiSend<{ item: PantryItem }>('PATCH', `/api/pantry/${id}`, patch).then((r) => r.item),
  remove: (id: string) => apiDelete(`/api/pantry/${id}`),
  setLocations: (locations: string[]) =>
    apiSend<{ locations: string[] }>('PUT', '/api/pantry/locations', { locations }).then((r) => r.locations),
}

export interface PantryState {
  items: PantryItem[]
  locations: string[]
  loading: boolean
  error: boolean
  refetch: () => void
}

export function usePantry(): PantryState {
  const [items, setItems] = useState<PantryItem[]>([])
  const [locations, setLocations] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    pantryApi
      .list()
      .then((d) => alive && (setItems(d.items), setLocations(d.locations), setLoading(false), setError(false)))
      .catch(() => alive && (setError(true), setLoading(false)))
    return () => {
      alive = false
    }
  }, [nonce])
  return { items, locations, loading, error, refetch: () => setNonce((n) => n + 1) }
}

// Days until an item expires (null if no date). Negative = already past.
export function daysUntil(expiresOn: string | null): number | null {
  if (!expiresOn) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const d = new Date(`${expiresOn}T00:00:00`)
  return Math.round((d.getTime() - today.getTime()) / 86400000)
}
