// Chores / tasks domain — client slice, types, and hooks.
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'
import { tap, useRefetchOn } from './bus'

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

export interface ChoreInstance {
  id: string
  choreId: string
  choreTitle: string
  emoji: string | null
  personId: string | null
  personName: string | null
  status: string
  rewardAmount: number | null
  rewardCurrency: string | null
  rrule: string | null
  requiresApproval: boolean
  streak: number
}

export const choresApi = {
  choresToday: () => apiGet<{ date: string; people: PersonChores[] }>('/api/chores/today'),
  // Optional date (YYYY-MM-DD) to look ahead/back; defaults to today.
  choreInstancesForDate: (date?: string) =>
    apiGet<{ date: string; instances: ChoreInstance[] }>(`/api/chore-instances/today${date ? `?date=${date}` : ''}`),
  completeInstance: (id: string) =>
    apiSend<{ instance: { id: string; status: string } }>('POST', `/api/chore-instances/${id}/complete`).then(tap('chores')).then(tap('rewards')),
  uncompleteInstance: (id: string) =>
    apiSend<{ instance: { id: string; status: string } }>('POST', `/api/chore-instances/${id}/uncomplete`).then(tap('chores')).then(tap('rewards')),
  createChore: (input: { title: string; personId?: string | null; emoji?: string | null; rewardAmount?: number; rewardCurrency?: string; rrule?: string; requiresApproval?: boolean }) =>
    apiSend<{ chore: { id: string } }>('POST', '/api/chores', input).then(tap('chores')),
  updateChore: (id: string, patch: Record<string, unknown>) =>
    apiSend<{ chore: { id: string } }>('PATCH', `/api/chores/${id}`, patch).then(tap('chores')),
  deleteChore: (id: string) => apiDelete(`/api/chores/${id}`).then(tap('chores')),
  claimInstance: (id: string, personId: string) =>
    apiSend<{ instance: { id: string; status: string } }>('POST', `/api/chore-instances/${id}/claim`, { personId }).then(tap('chores')),
  approveInstance: (id: string) =>
    // approving awards stars → rewards balances change too
    apiSend<{ instance: { id: string; status: string } }>('POST', `/api/chore-instances/${id}/approve`).then(tap('chores')).then(tap('rewards')),
  rejectInstance: (id: string) =>
    apiSend<{ instance: { id: string; status: string } }>('POST', `/api/chore-instances/${id}/reject`).then(tap('chores')),
}

export interface ChoresState {
  people: PersonChores[]
  loading: boolean
  error: boolean
}

export function useChoresToday(): ChoresState {
  const [state, setState] = useState<ChoresState>({ people: [], loading: true, error: false })
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    choresApi
      .choresToday()
      .then((d) => alive && setState({ people: d.people, loading: false, error: false }))
      .catch(() => alive && setState({ people: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [nonce])
  // keep the Today rings in sync when chores are completed/approved elsewhere
  useRefetchOn(['chores'], () => setNonce((n) => n + 1))
  return state
}

export interface InstancesState {
  instances: ChoreInstance[]
  loading: boolean
  error: boolean
  setDone: (id: string, done: boolean) => Promise<void>
  refetch: () => void
}

// Chore instances for a given day (defaults to today). Refetches when the day
// changes, and reacts to cross-surface chore edits via the bus.
export function useDayInstances(date?: string): InstancesState {
  const [instances, setInstances] = useState<ChoreInstance[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    choresApi
      .choreInstancesForDate(date)
      .then((d) => {
        if (alive) {
          setInstances(d.instances)
          setError(false)
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
  }, [nonce, date])

  const refetch = useCallback(() => setNonce((n) => n + 1), [])
  // reflect chore changes made on other surfaces (Today rings, etc.)
  useRefetchOn(['chores'], refetch)

  async function setDone(id: string, done: boolean): Promise<void> {
    let snapshot: ChoreInstance[] = []
    setInstances((prev) => {
      snapshot = prev
      return prev.map((i) => (i.id === id ? { ...i, status: done ? 'done' : 'pending' } : i))
    })
    try {
      await (done ? choresApi.completeInstance(id) : choresApi.uncompleteInstance(id))
    } catch {
      setInstances(snapshot)
    }
  }

  return { instances, loading, error, setDone, refetch }
}
