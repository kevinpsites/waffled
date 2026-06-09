// Goals domain — client slice, types, and hook.
import { useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'

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
  isFeatured: boolean
  target: number | null
  totalProgress: number
  participants: GoalParticipant[]
}

export const goalsApi = {
  goals: () => apiGet<{ goals: Goal[] }>('/api/goals'),
  createGoal: (input: Record<string, unknown>) => apiSend<{ goal: { id: string } }>('POST', '/api/goals', input),
  logGoal: (id: string, amount: number, personId?: string | null) =>
    apiSend<{ ok: boolean }>('POST', `/api/goals/${id}/log`, { amount, personId: personId ?? null }),
  deleteGoal: (id: string) => apiDelete(`/api/goals/${id}`),
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
    goalsApi
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
