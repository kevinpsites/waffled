// Goals domain — client slice, types, and hooks. Matches the goal-lists mocks.
import { useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'

export interface GoalListMember {
  personId: string
  name: string
  avatarEmoji: string | null
  colorHex: string | null
}

export interface GoalList {
  id: string
  name: string
  emoji: string | null
  colorHex: string | null
  isPrivate: boolean
  sortOrder: number
  members: GoalListMember[]
  goalCount: number
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
  goalListId: string | null
  title: string
  emoji: string | null
  category: string | null
  goalType: string
  unit: string | null
  habitPeriod: string | null
  habitTargetPerPeriod: number | null
  trackingMode: string
  logMethod: string
  deadline: string | null
  isFeatured: boolean
  hasRewards: boolean
  target: number | null
  totalProgress: number
  milestoneTotal: number
  milestoneReached: number
  streakDays: number
  participants: GoalParticipant[]
}

export interface GoalMilestone {
  id: string
  threshold: number
  emoji: string | null
  label: string | null
  rewardText: string | null
  reached: boolean
}

export interface GoalLogEntry {
  id: string
  amount: number
  loggedAt: string
  note: string | null
  personId: string | null
  name: string | null
  avatarEmoji: string | null
  colorHex: string | null
}

export interface GoalDetail extends Goal {
  createdAt: string
  milestones: GoalMilestone[]
  recent: GoalLogEntry[]
  thisWeek: number
  streakDays: number
}

export const goalsApi = {
  goalLists: () => apiGet<{ lists: GoalList[] }>('/api/goal-lists'),
  createGoalList: (input: Record<string, unknown>) => apiSend<{ list: { id: string } }>('POST', '/api/goal-lists', input),
  deleteGoalList: (id: string) => apiDelete(`/api/goal-lists/${id}`),
  goals: (listId?: string | null) =>
    apiGet<{ goals: Goal[] }>(listId ? `/api/goals?listId=${listId}` : '/api/goals'),
  goal: (id: string) => apiGet<{ goal: GoalDetail }>(`/api/goals/${id}`),
  createGoal: (input: Record<string, unknown>) => apiSend<{ goal: { id: string } }>('POST', '/api/goals', input),
  updateGoal: (id: string, patch: Record<string, unknown>) => apiSend<{ goal: GoalDetail }>('PATCH', `/api/goals/${id}`, patch),
  logGoal: (id: string, body: { amount: number; personIds?: string[]; personId?: string | null; note?: string | null }) =>
    apiSend<{ ok: boolean }>('POST', `/api/goals/${id}/log`, body),
  deleteGoal: (id: string) => apiDelete(`/api/goals/${id}`),
}

export interface GoalListsState {
  lists: GoalList[]
  loading: boolean
  error: boolean
  refetch: () => void
}

export function useGoalLists(): GoalListsState {
  const [lists, setLists] = useState<GoalList[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    goalsApi
      .goalLists()
      .then((d) => alive && (setLists(d.lists), setLoading(false)))
      .catch(() => alive && (setError(true), setLoading(false)))
    return () => {
      alive = false
    }
  }, [nonce])
  return { lists, loading, error, refetch: () => setNonce((n) => n + 1) }
}

export interface GoalsState {
  goals: Goal[]
  loading: boolean
  error: boolean
  refetch: () => void
}

export function useGoals(listId?: string | null): GoalsState {
  const [goals, setGoals] = useState<Goal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    setLoading(true)
    goalsApi
      .goals(listId)
      .then((d) => alive && (setGoals(d.goals), setLoading(false), setError(false)))
      .catch(() => alive && (setError(true), setLoading(false)))
    return () => {
      alive = false
    }
  }, [listId, nonce])
  return { goals, loading, error, refetch: () => setNonce((n) => n + 1) }
}

export interface GoalDetailState {
  goal: GoalDetail | null
  loading: boolean
  error: boolean
  refetch: () => void
}

export function useGoalDetail(id: string | null): GoalDetailState {
  const [goal, setGoal] = useState<GoalDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!id) return
    let alive = true
    setLoading(true)
    goalsApi
      .goal(id)
      .then((d) => alive && (setGoal(d.goal), setLoading(false), setError(false)))
      .catch(() => alive && (setError(true), setLoading(false)))
    return () => {
      alive = false
    }
  }, [id, nonce])
  return { goal, loading, error, refetch: () => setNonce((n) => n + 1) }
}
