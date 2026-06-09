// Lists / grocery domain — client slice, types, and hook.
import { useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'

export interface GroceryItem {
  id: string
  name: string
  quantity: string | null
  checked: boolean
}

export const groceryApi = {
  grocery: () => apiGet<{ items: GroceryItem[] }>('/api/lists/grocery'),
  addGroceryItem: (name: string) =>
    apiSend<{ item: GroceryItem }>('POST', '/api/lists/grocery/items', { name }).then((r) => r.item),
  setItemChecked: (id: string, checked: boolean) =>
    apiSend<{ item: GroceryItem }>('PATCH', `/api/list-items/${id}`, { checked }).then((r) => r.item),
  deleteItem: (id: string) => apiDelete(`/api/list-items/${id}`),
  groceryFromRecipe: (recipeId: string) =>
    apiSend<{ added: number }>('POST', `/api/lists/grocery/from-recipe/${recipeId}`),
}

export interface GroceryState {
  items: GroceryItem[]
  loading: boolean
  error: boolean
  add: (name: string) => Promise<void>
  toggle: (id: string, checked: boolean) => Promise<void>
  remove: (id: string) => Promise<void>
}

export function useGrocery(): GroceryState {
  const [items, setItems] = useState<GroceryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    groceryApi
      .grocery()
      .then((d) => {
        if (alive) {
          setItems(d.items)
          setLoading(false)
        }
      })
      .catch(() => {
        if (alive) {
          setError(true)
          setLoading(false)
        }
      })
    return () => {
      alive = false
    }
  }, [])

  async function add(name: string): Promise<void> {
    const item = await groceryApi.addGroceryItem(name)
    setItems((prev) => [...prev, item])
  }

  // Optimistic toggle; revert on failure.
  async function toggle(id: string, checked: boolean): Promise<void> {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, checked } : i)))
    try {
      await groceryApi.setItemChecked(id, checked)
    } catch {
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, checked: !checked } : i)))
    }
  }

  // Optimistic removal; restore on failure.
  async function remove(id: string): Promise<void> {
    let snapshot: GroceryItem[] = []
    setItems((prev) => {
      snapshot = prev
      return prev.filter((i) => i.id !== id)
    })
    try {
      await groceryApi.deleteItem(id)
    } catch {
      setItems(snapshot)
    }
  }

  return { items, loading, error, add, toggle, remove }
}
