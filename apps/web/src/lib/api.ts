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
  eventsToday: (date: string) =>
    apiGet<{ date: string; events: AgendaEvent[] }>(`/api/events/today?date=${date}`),
  eventsRange: (from: string, to: string) =>
    apiGet<{ from: string; to: string; events: AgendaEvent[] }>(`/api/events?from=${from}&to=${to}`),
  createEvent: (input: {
    title: string
    startsAt: string
    endsAt?: string | null
    allDay?: boolean
    personId?: string | null
    location?: string | null
  }) => apiSend<{ event: AgendaEvent }>('POST', '/api/events', input),
  updateEvent: (id: string, patch: Record<string, unknown>) =>
    apiSend<{ event: AgendaEvent }>('PATCH', `/api/events/${id}`, patch),
  deleteEvent: (id: string) => apiDelete(`/api/events/${id}`),
  choreInstancesToday: () =>
    apiGet<{ date: string; instances: ChoreInstance[] }>('/api/chore-instances/today'),
  completeInstance: (id: string) =>
    apiSend<{ instance: { id: string; status: string } }>('POST', `/api/chore-instances/${id}/complete`),
  uncompleteInstance: (id: string) =>
    apiSend<{ instance: { id: string; status: string } }>('POST', `/api/chore-instances/${id}/uncomplete`),
  createChore: (input: { title: string; personId?: string | null; emoji?: string | null; rewardAmount?: number }) =>
    apiSend<{ chore: { id: string } }>('POST', '/api/chores', input),
  updateChore: (id: string, patch: Record<string, unknown>) =>
    apiSend<{ chore: { id: string } }>('PATCH', `/api/chores/${id}`, patch),
  deleteChore: (id: string) => apiDelete(`/api/chores/${id}`),
  goals: () => apiGet<{ goals: Goal[] }>('/api/goals'),
  createGoal: (input: Record<string, unknown>) => apiSend<{ goal: { id: string } }>('POST', '/api/goals', input),
  logGoal: (id: string, amount: number, personId?: string | null) =>
    apiSend<{ ok: boolean }>('POST', `/api/goals/${id}/log`, { amount, personId: personId ?? null }),
  deleteGoal: (id: string) => apiDelete(`/api/goals/${id}`),
  grocery: () => apiGet<{ items: GroceryItem[] }>('/api/lists/grocery'),
  addGroceryItem: (name: string) =>
    apiSend<{ item: GroceryItem }>('POST', '/api/lists/grocery/items', { name }).then((r) => r.item),
  setItemChecked: (id: string, checked: boolean) =>
    apiSend<{ item: GroceryItem }>('PATCH', `/api/list-items/${id}`, { checked }).then((r) => r.item),
  deleteItem: (id: string) => apiDelete(`/api/list-items/${id}`),
  groceryFromRecipe: (recipeId: string) =>
    apiSend<{ added: number }>('POST', `/api/lists/grocery/from-recipe/${recipeId}`),
  recipe: (id: string) =>
    apiGet<{ recipe: RecipeDetail; ingredients: RecipeIngredient[] }>(`/api/recipes/${id}`),
}

export interface RecipeDetail {
  id: string
  title: string
  emoji: string | null
  description: string | null
  prepTimeMinutes: number | null
  cookTimeMinutes: number | null
  servings: number
  sourceName: string | null
}

export interface RecipeIngredient {
  id: string
  name: string
  amount: number | null
  unit: string | null
  prepNote: string | null
  display: string | null
  section: string | null
  sortOrder: number | null
}

export interface RecipeState {
  recipe: RecipeDetail | null
  ingredients: RecipeIngredient[]
  loading: boolean
  error: boolean
}

export function useRecipe(id: string | null): RecipeState {
  const [state, setState] = useState<RecipeState>({
    recipe: null,
    ingredients: [],
    loading: true,
    error: false,
  })
  useEffect(() => {
    if (!id) return
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    api
      .recipe(id)
      .then((d) => alive && setState({ recipe: d.recipe, ingredients: d.ingredients, loading: false, error: false }))
      .catch(() => alive && setState({ recipe: null, ingredients: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [id])
  return state
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

export interface Participant {
  id: string
  name: string
  colorHex: string | null
  avatarEmoji: string | null
}

export interface AgendaEvent {
  id: string
  title: string
  startsAt: string
  endsAt: string | null
  allDay: boolean
  location: string | null
  personId: string | null
  personName: string | null
  personColor: string | null
  personEmoji: string | null
  participants: Participant[]
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

export interface GoalParticipant {
  personId: string
  name: string
  colorHex: string | null
  avatarEmoji: string | null
  target: number | null
  progress: number
}

export interface Goal {
  id: string
  title: string
  emoji: string | null
  category: string | null
  goalType: string
  unit: string | null
  trackingMode: string
  deadline: string | null
  target: number | null
  totalProgress: number
  participants: GoalParticipant[]
}

export interface GoalsState {
  goals: Goal[]
  loading: boolean
  error: boolean
  refetch: () => void
}

export function useGoals(): GoalsState {
  const [goals, setGoals] = useState<Goal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    api
      .goals()
      .then((d) => {
        if (alive) {
          setGoals(d.goals)
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
  }, [nonce])
  return { goals, loading, error, refetch: () => setNonce((n) => n + 1) }
}

export interface ChoreInstance {
  id: string
  choreId: string
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

export interface AgendaState {
  events: AgendaEvent[]
  loading: boolean
  error: boolean
}

export function useEventsToday(): AgendaState & { refetch: () => void } {
  const [state, setState] = useState<AgendaState>({ events: [], loading: true, error: false })
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    api
      .eventsToday(localToday())
      .then((d) => alive && setState({ events: d.events, loading: false, error: false }))
      .catch(() => alive && setState({ events: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [nonce])
  return { ...state, refetch: () => setNonce((n) => n + 1) }
}

export function useEventsRange(from: string, to: string): AgendaState & { refetch: () => void } {
  const [state, setState] = useState<AgendaState>({ events: [], loading: true, error: false })
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    api
      .eventsRange(from, to)
      .then((d) => alive && setState({ events: d.events, loading: false, error: false }))
      .catch(() => alive && setState({ events: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [from, to, nonce])
  return { ...state, refetch: () => setNonce((n) => n + 1) }
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
  refetch: () => void
}

export function useTodayInstances(): InstancesState {
  const [instances, setInstances] = useState<ChoreInstance[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)

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
  }, [nonce])

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

  return { instances, loading, error, setDone, refetch: () => setNonce((n) => n + 1) }
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
