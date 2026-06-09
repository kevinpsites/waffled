import { useEffect, useState } from 'react'

// Minimal api client. In dev, Vite proxies /api to the api container; in the
// stack, Caddy does. The kiosk token is a dev shortcut for now — a real device
// pairing flow (chunk 3.3) replaces it later. Set it via localStorage
// ('nook.token') at runtime, or VITE_KIOSK_TOKEN at build time.
function token(): string | undefined {
  try {
    const t = localStorage.getItem('nook.token')
    if (t) return t
  } catch {
    /* localStorage unavailable */
  }
  return import.meta.env.VITE_KIOSK_TOKEN || undefined
}

async function apiGet<T>(path: string): Promise<T> {
  const t = token()
  const res = await fetch(path, { headers: t ? { authorization: `Bearer ${t}` } : {} })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

async function apiSend<T>(method: string, path: string, body?: unknown): Promise<T> {
  const t = token()
  const res = await fetch(path, {
    method,
    headers: {
      ...(t ? { authorization: `Bearer ${t}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

async function apiDelete(path: string): Promise<void> {
  const t = token()
  const res = await fetch(path, { method: 'DELETE', headers: t ? { authorization: `Bearer ${t}` } : {} })
  if (!res.ok) throw new Error(`DELETE ${path} -> ${res.status}`)
}

export interface Person {
  id: string
  name: string
  memberType: string
  isAdmin: boolean
  avatarEmoji: string | null
  colorHex: string | null
}

export interface GroceryItem {
  id: string
  name: string
  quantity: string | null
  checked: boolean
}

export interface PersonChores {
  id: string
  name: string
  avatarEmoji: string | null
  colorHex: string | null
  memberType: string
  isAdmin: boolean
  total: number
  done: number
  stars: number
}

export const api = {
  persons: () => apiGet<{ persons: Person[] }>('/api/persons'),
  choresToday: () => apiGet<{ date: string; people: PersonChores[] }>('/api/chores/today'),
  mealsWeek: (start: string) =>
    apiGet<{ start: string; entries: WeekEntry[] }>(`/api/meals/week?start=${start}`),
  choreInstancesToday: () =>
    apiGet<{ date: string; instances: ChoreInstance[] }>('/api/chore-instances/today'),
  completeInstance: (id: string) =>
    apiSend<{ instance: { id: string; status: string } }>('POST', `/api/chore-instances/${id}/complete`),
  uncompleteInstance: (id: string) =>
    apiSend<{ instance: { id: string; status: string } }>('POST', `/api/chore-instances/${id}/uncomplete`),
  grocery: () => apiGet<{ items: GroceryItem[] }>('/api/lists/grocery'),
  addGroceryItem: (name: string) =>
    apiSend<{ item: GroceryItem }>('POST', '/api/lists/grocery/items', { name }).then((r) => r.item),
  setItemChecked: (id: string, checked: boolean) =>
    apiSend<{ item: GroceryItem }>('PATCH', `/api/list-items/${id}`, { checked }).then((r) => r.item),
  deleteItem: (id: string) => apiDelete(`/api/list-items/${id}`),
}

export interface PersonsState {
  persons: Person[]
  loading: boolean
  error: boolean
}

export function usePersons(): PersonsState {
  const [state, setState] = useState<PersonsState>({ persons: [], loading: true, error: false })
  useEffect(() => {
    let alive = true
    api
      .persons()
      .then((d) => alive && setState({ persons: d.persons, loading: false, error: false }))
      .catch(() => alive && setState({ persons: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [])
  return state
}

export interface MealRecipe {
  title: string | null
  emoji: string | null
  prepTimeMinutes: number | null
  cookTimeMinutes: number | null
  servings: number | null
  imageUrl: string | null
}

export interface WeekEntry {
  id: string
  date: string
  mealType: string
  title: string | null
  recipeId: string | null
  recipe: MealRecipe | null
}

// Local YYYY-MM-DD (kiosk timezone), used to match "tonight" and window the week.
export function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface ChoreInstance {
  id: string
  choreTitle: string
  emoji: string | null
  personId: string | null
  personName: string | null
  status: string
  rewardAmount: number | null
}

export interface ChoresState {
  people: PersonChores[]
  loading: boolean
  error: boolean
}

export interface MealsState {
  entries: WeekEntry[]
  loading: boolean
  error: boolean
}

export function useMealsWeek(): MealsState {
  const [state, setState] = useState<MealsState>({ entries: [], loading: true, error: false })
  useEffect(() => {
    let alive = true
    api
      .mealsWeek(localToday())
      .then((d) => alive && setState({ entries: d.entries, loading: false, error: false }))
      .catch(() => alive && setState({ entries: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [])
  return state
}

export function useChoresToday(): ChoresState {
  const [state, setState] = useState<ChoresState>({ people: [], loading: true, error: false })
  useEffect(() => {
    let alive = true
    api
      .choresToday()
      .then((d) => alive && setState({ people: d.people, loading: false, error: false }))
      .catch(() => alive && setState({ people: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [])
  return state
}

export interface InstancesState {
  instances: ChoreInstance[]
  loading: boolean
  error: boolean
  setDone: (id: string, done: boolean) => Promise<void>
}

export function useTodayInstances(): InstancesState {
  const [instances, setInstances] = useState<ChoreInstance[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .choreInstancesToday()
      .then((d) => {
        if (alive) {
          setInstances(d.instances)
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

  async function setDone(id: string, done: boolean): Promise<void> {
    let snapshot: ChoreInstance[] = []
    setInstances((prev) => {
      snapshot = prev
      return prev.map((i) => (i.id === id ? { ...i, status: done ? 'done' : 'pending' } : i))
    })
    try {
      await (done ? api.completeInstance(id) : api.uncompleteInstance(id))
    } catch {
      setInstances(snapshot)
    }
  }

  return { instances, loading, error, setDone }
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
    api
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
    const item = await api.addGroceryItem(name)
    setItems((prev) => [...prev, item])
  }

  // Optimistic toggle; revert on failure.
  async function toggle(id: string, checked: boolean): Promise<void> {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, checked } : i)))
    try {
      await api.setItemChecked(id, checked)
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
      await api.deleteItem(id)
    } catch {
      setItems(snapshot)
    }
  }

  return { items, loading, error, add, toggle, remove }
}
