// Chores / tasks domain — client slice, types, and hooks.
import { useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'

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
}

export const choresApi = {
  choresToday: () => apiGet<{ date: string; people: PersonChores[] }>('/api/chores/today'),
  choreInstancesToday: () => apiGet<{ date: string; instances: ChoreInstance[] }>('/api/chore-instances/today'),
  completeInstance: (id: string) =>
    apiSend<{ instance: { id: string; status: string } }>('POST', `/api/chore-instances/${id}/complete`),
  uncompleteInstance: (id: string) =>
    apiSend<{ instance: { id: string; status: string } }>('POST', `/api/chore-instances/${id}/uncomplete`),
  createChore: (input: { title: string; personId?: string | null; emoji?: string | null; rewardAmount?: number }) =>
    apiSend<{ chore: { id: string } }>('POST', '/api/chores', input),
  updateChore: (id: string, patch: Record<string, unknown>) =>
    apiSend<{ chore: { id: string } }>('PATCH', `/api/chores/${id}`, patch),
  deleteChore: (id: string) => apiDelete(`/api/chores/${id}`),
}

export interface ChoresState {
  people: PersonChores[]
  loading: boolean
  error: boolean
}

export function useChoresToday(): ChoresState {
  const [state, setState] = useState<ChoresState>({ people: [], loading: true, error: false })
  useEffect(() => {
    let alive = true
    choresApi
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
    choresApi
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
      await (done ? choresApi.completeInstance(id) : choresApi.uncompleteInstance(id))
    } catch {
      setInstances(snapshot)
    }
  }

  return { instances, loading, error, setDone, refetch: () => setNonce((n) => n + 1) }
}
