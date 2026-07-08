// Chores / tasks domain — client slice, types, and hooks.
import { useCallback, useEffect, useRef, useState } from 'react'
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
  personAvatar: string | null
  personColor: string | null
  dueOn: string
  dueTime: string | null
  status: string
  rewardAmount: number | null
  rewardCurrency: string | null
  rrule: string | null
  requiresApproval: boolean
  requiresPhoto: boolean
  proofUrl: string | null
  hadProof: boolean
  streak: number
}

export const choresApi = {
  choresToday: () => apiGet<{ date: string; people: PersonChores[] }>('/api/chores/today'),
  // Optional date (YYYY-MM-DD) to look ahead/back; defaults to today.
  choreInstancesForDate: (date?: string) =>
    apiGet<{ date: string; instances: ChoreInstance[] }>(`/api/chore-instances/today${date ? `?date=${date}` : ''}`),
  // Every chore completion awaiting a parent's OK, across all dates (the approvals
  // queue) — the date-scoped list above misses ones submitted on earlier days.
  awaitingInstances: () => apiGet<{ instances: ChoreInstance[] }>('/api/chore-instances/awaiting'),
  // Optional photo proof ({ storageKey, contentType } from uploadImage) — required
  // for chores flagged requiresPhoto, else omitted.
  completeInstance: (id: string, proof?: { storageKey: string; contentType: string }) =>
    apiSend<{ instance: { id: string; status: string } }>('POST', `/api/chore-instances/${id}/complete`, proof).then(tap('chores')).then(tap('rewards')),
  uncompleteInstance: (id: string) =>
    apiSend<{ instance: { id: string; status: string } }>('POST', `/api/chore-instances/${id}/uncomplete`).then(tap('chores')).then(tap('rewards')),
  createChore: (input: { title: string; personId?: string | null; emoji?: string | null; rewardAmount?: number; rewardCurrency?: string; rrule?: string | null; requiresApproval?: boolean; requiresPhoto?: boolean; rollover?: boolean; dueOn?: string; dueTime?: string | null }) =>
    apiSend<{ chore: { id: string } }>('POST', '/api/chores', input).then(tap('chores')),
  updateChore: (id: string, patch: Record<string, unknown>) =>
    apiSend<{ chore: { id: string } }>('PATCH', `/api/chores/${id}`, patch).then(tap('chores')),
  deleteChore: (id: string) => apiDelete(`/api/chores/${id}`).then(tap('chores')),
  claimInstance: (id: string, personId: string) =>
    apiSend<{ instance: { id: string; status: string } }>('POST', `/api/chore-instances/${id}/claim`, { personId }).then(tap('chores')),
  // Reassign to a person, or unassign back to up-for-grabs (personId null).
  // Powers the board's drag-and-drop between columns.
  assignInstance: (id: string, personId: string | null) =>
    apiSend<{ instance: { id: string; status: string } }>('POST', `/api/chore-instances/${id}/assign`, { personId }).then(tap('chores')),
  approveInstance: (id: string) =>
    // approving awards stars → rewards balances change too
    apiSend<{ instance: { id: string; status: string } }>('POST', `/api/chore-instances/${id}/approve`).then(tap('chores')).then(tap('rewards')),
  rejectInstance: (id: string) =>
    apiSend<{ instance: { id: string; status: string } }>('POST', `/api/chore-instances/${id}/reject`).then(tap('chores')),
  // Household chore settings (Settings → Chores & rewards) — photo-proof retention
  // and the rewards sub-toggle (the spend half of the chores economy).
  getSettings: () => apiGet<{ proofTtlDays: number; rewards: boolean }>('/api/chores/settings'),
  setProofTtlDays: (proofTtlDays: number) =>
    apiSend<{ proofTtlDays: number }>('PUT', '/api/chores/settings', { proofTtlDays }).then((r) => r.proofTtlDays),
  setRewardsEnabled: (rewards: boolean) =>
    apiSend<{ rewards: boolean }>('PUT', '/api/chores/settings', { rewards }).then((r) => r.rewards),
  // Stored proof photos — review/manage surface (Settings → Chores & rewards).
  listProofs: () => apiGet<{ proofs: StoredProof[] }>('/api/chore-proofs'),
  deleteProof: (id: string) => apiDelete(`/api/chore-proofs/${id}`).then(tap('chores')),
  clearProofs: () => apiSend<{ cleared: number }>('DELETE', '/api/chore-proofs').then((r) => r.cleared).then(tap('chores')),
}

export interface StoredProof {
  instanceId: string
  choreTitle: string
  emoji: string | null
  personName: string | null
  personAvatar: string | null
  personColor: string | null
  proofUrl: string | null
  completedAt: string | null
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

export interface AwaitingState {
  chores: ChoreInstance[]
  loading: boolean
  refetch: () => void
}

// The cross-date queue of chores waiting on a parent's OK. Drives the Chores-tab
// "Needs your OK" banner and (combined with pending redemptions) the Today
// approvals bar. Re-pulls whenever a chore is completed/approved/rejected.
export function useAwaitingChores(): AwaitingState {
  const [chores, setChores] = useState<ChoreInstance[]>([])
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    choresApi
      .awaitingInstances()
      .then((d) => alive && (setChores(d.instances ?? []), setLoading(false)))
      .catch(() => alive && (setChores([]), setLoading(false)))
    return () => {
      alive = false
    }
  }, [nonce])
  const refetch = useCallback(() => setNonce((n) => n + 1), [])
  useRefetchOn(['chores'], refetch)
  return { chores, loading, refetch }
}

export interface InstancesState {
  instances: ChoreInstance[]
  loading: boolean
  error: boolean
  setDone: (id: string, done: boolean) => Promise<void>
  assign: (id: string, personId: string | null) => Promise<void>
  refetch: () => void
}

// Chore instances for a given day (defaults to today). Refetches when the day
// changes, and reacts to cross-surface chore edits via the bus.
export function useDayInstances(date?: string): InstancesState {
  const [instances, setInstances] = useState<ChoreInstance[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  // Only show the full-screen loader on the very first fetch. Day changes and
  // bus-triggered refetches (e.g. after a drag-drop reassign) swap the data in
  // place — blanking to "Loading…" mid-interaction caused a white flash.
  const didLoad = useRef(false)

  useEffect(() => {
    let alive = true
    if (!didLoad.current) setLoading(true)
    choresApi
      .choreInstancesForDate(date)
      .then((d) => {
        if (alive) {
          setInstances(d.instances)
          setError(false)
          setLoading(false)
          didLoad.current = true
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

  // Optimistically move a chore to another column (person, or up-for-grabs when
  // null). Only personId matters for column placement; the bus refetch reconciles
  // personName/streak afterwards. Reverts on failure.
  async function assign(id: string, personId: string | null): Promise<void> {
    let snapshot: ChoreInstance[] = []
    setInstances((prev) => {
      snapshot = prev
      return prev.map((i) => (i.id === id ? { ...i, personId } : i))
    })
    try {
      await choresApi.assignInstance(id, personId)
    } catch {
      setInstances(snapshot)
    }
  }

  return { instances, loading, error, setDone, assign, refetch }
}
