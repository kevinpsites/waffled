// Lists domain — client slice, types, and hooks. Backs the Lists screen
// (multiple named lists, sectioned items, assignees) AND the Today dashboard's
// Grocery card (the original grocery exports are kept intact).
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { apiGet, apiSend, apiDelete } from './client'

// ---- grocery (Today dashboard) ---------------------------------------------

export interface GroceryItem {
  id: string
  name: string
  quantity: string | null
  checked: boolean
}

// ---- lists (the Lists screen) ----------------------------------------------

export interface ListSummary {
  id: string
  name: string
  emoji: string | null
  listType: string
  isAutoBuilt: boolean
  sortMode: string
  itemCount: number
}

export interface ListItemAssignee {
  personId: string
  name: string | null
  avatarEmoji: string | null
  colorHex: string | null
}

export interface ListItem {
  id: string
  name: string
  quantity: string | null
  checked: boolean
  checkedAt: string | null
  section: string | null
  sortOrder: number | null
  assignee: ListItemAssignee | null
}

export interface ListDetail {
  list: ListSummary | { id: string; name: string; emoji: string | null; listType: string; isAutoBuilt: boolean; sortMode: string }
  items: ListItem[]
}

export interface PatchItemBody {
  checked?: boolean
  assignedTo?: string | null
  quantity?: string | null
  section?: string | null
  name?: string
}

// PATCH /api/list-items uses `category` server-side for the section column.
function patchBody(b: PatchItemBody): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if ('checked' in b) out.checked = b.checked
  if ('assignedTo' in b) out.assignedTo = b.assignedTo
  if ('quantity' in b) out.quantity = b.quantity
  if ('section' in b) out.category = b.section
  if ('name' in b) out.name = b.name
  return out
}

export const groceryApi = {
  // grocery (unchanged surface for the Today card)
  grocery: () => apiGet<{ items: GroceryItem[] }>('/api/lists/grocery'),
  addGroceryItem: (name: string) =>
    apiSend<{ item: GroceryItem }>('POST', '/api/lists/grocery/items', { name }).then((r) => r.item),
  setItemChecked: (id: string, checked: boolean) =>
    apiSend<{ item: GroceryItem }>('PATCH', `/api/list-items/${id}`, { checked }).then((r) => r.item),
  deleteItem: (id: string) => apiDelete(`/api/list-items/${id}`),
  groceryFromRecipe: (recipeId: string) =>
    apiSend<{ added: number }>('POST', `/api/lists/grocery/from-recipe/${recipeId}`),

  // lists (the Lists screen)
  lists: () => apiGet<{ lists: ListSummary[] }>('/api/lists'),
  list: (id: string) => apiGet<ListDetail>(`/api/lists/${id}`),
  createList: (input: { name: string; emoji?: string | null }) =>
    apiSend<{ list: ListSummary }>('POST', '/api/lists', input).then((r) => r.list),
  renameList: (id: string, patch: { name?: string; emoji?: string | null }) =>
    apiSend<{ list: ListSummary }>('PATCH', `/api/lists/${id}`, patch).then((r) => r.list),
  deleteList: (id: string) => apiDelete(`/api/lists/${id}`),
  addListItem: (listId: string, input: { name: string; quantity?: string | null; section?: string | null; assignedTo?: string | null }) =>
    apiSend<{ item: ListItem }>('POST', `/api/lists/${listId}/items`, {
      name: input.name,
      quantity: input.quantity ?? null,
      category: input.section ?? null,
      assignedTo: input.assignedTo ?? null,
    }).then((r) => r.item),
  patchListItem: (id: string, patch: PatchItemBody) =>
    apiSend<{ item: ListItem }>('PATCH', `/api/list-items/${id}`, patchBody(patch)).then((r) => r.item),
}

// ---- grocery hook (Today dashboard) ----------------------------------------

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

// ---- lists hooks (the Lists screen) ----------------------------------------

export interface ListsState {
  lists: ListSummary[]
  loading: boolean
  error: boolean
  refetch: () => void
}

export function useLists(): ListsState {
  const [lists, setLists] = useState<ListSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    groceryApi
      .lists()
      .then((d) => alive && (setLists(d.lists), setLoading(false), setError(false)))
      .catch(() => alive && (setError(true), setLoading(false)))
    return () => {
      alive = false
    }
  }, [nonce])
  return { lists, loading, error, refetch: () => setNonce((n) => n + 1) }
}

export interface ListDetailState {
  items: ListItem[]
  loading: boolean
  error: boolean
  setItems: Dispatch<SetStateAction<ListItem[]>>
  refetch: () => void
}

export function useListDetail(id: string | null): ListDetailState {
  const [items, setItems] = useState<ListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!id) {
      setItems([])
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    groceryApi
      .list(id)
      .then((d) => alive && (setItems(d.items), setLoading(false), setError(false)))
      .catch(() => alive && (setError(true), setLoading(false)))
    return () => {
      alive = false
    }
  }, [id, nonce])
  return { items, loading, error, setItems, refetch: () => setNonce((n) => n + 1) }
}
