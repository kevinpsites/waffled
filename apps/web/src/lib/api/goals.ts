// Goals domain — client slice, types, and hooks. Matches the goal-lists mocks.
import { useEffect, useRef, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'
import { tap, useRefetchOn } from './bus'

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
  // Shared-goal counting rule: count_once | split (see GoalCreate PARTICIPANT_TYPES).
  participantMode: string
  // For each_tracks goals: 'family' (flat shared target) | 'per_person' (ring = target × members).
  targetBasis: string
  logMethod: string
  autoFromCalendar: boolean
  deadline: string | null
  isFeatured: boolean
  // The one hero goal per list. Tier is derived spotlight > featured > normal.
  isSpotlight: boolean
  hasRewards: boolean
  target: number | null
  totalProgress: number
  milestoneTotal: number
  milestoneReached: number
  periodDone: number
  stepTotal: number
  stepDone: number
  streakDays: number
  loggedTodayBy: string[]
  participants: GoalParticipant[]
}

// ── Display helpers (shared by the goals list, goal detail, and the Today card) ──
// A goal is shown on its TYPE's axis: a habit shows completions THIS PERIOD vs its
// cadence (not a lifetime total), a checklist shows steps done, everything else the
// cumulative amount. Keeping these in one place stops the Today card from drifting
// from the list/detail.
export function goalDisplayProgress(g: Goal): number {
  if (g.goalType === 'habit') return g.periodDone
  if (g.goalType === 'checklist') return g.stepDone
  return g.totalProgress
}
// The target the progress is measured against. For an each_tracks / per_person goal
// the ring target is the per-person number × household size (read 12 EACH → 48 for
// four), so it grows as people join — matching the goals list and detail.
export function goalDisplayTarget(g: Goal): number | null {
  if (g.goalType === 'habit') return g.habitTargetPerPeriod ?? g.target
  if (g.goalType === 'checklist') return g.stepTotal || null
  if (g.targetBasis === 'per_person' && g.target != null) return g.target * Math.max(1, g.participants.length)
  return g.target
}
// 0..1 completion, clamped. 0 when there's no positive target (e.g. an empty checklist).
export function goalFraction(g: Goal): number {
  const t = goalDisplayTarget(g)
  const p = goalDisplayProgress(g)
  return t != null && t > 0 ? Math.min(p / t, 1) : 0
}
// The one place goal amounts get formatted for display: at most 2 decimals, trailing
// zeros dropped, with thousands grouping (2.5833… → "2.58", 1.5 → "1.5", 6.16667 →
// "6.17", 1000 → "1,000"). Amounts are stored exact — an hours+minutes log is 1h5m =
// 1.0833… hours — so every amount/progress the UI shows MUST route through here rather
// than render the raw repeating decimal. (Shared so the list, detail, Today card, and
// person profile can't drift.)
export function fmtGoalNum(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

export interface GoalMilestone {
  id: string
  threshold: number
  emoji: string | null
  label: string | null
  rewardText: string | null
  reached: boolean
}

export interface GoalStep {
  id: string
  label: string
  done: boolean
  doneBy: string | null
}

export interface GoalLogParticipant {
  personId: string | null
  name: string | null
  avatarEmoji: string | null
  colorHex: string | null
}

export interface GoalLogEntry {
  id: string
  amount: number
  loggedAt: string
  note: string | null
  // Split-pool logs write one row per person but collapse to a single entry here —
  // `amount` is the summed total and `participants` lists everyone credited.
  participants: GoalLogParticipant[]
}

export interface GoalDetail extends Goal {
  createdAt: string
  milestones: GoalMilestone[]
  steps: GoalStep[]
  recent: GoalLogEntry[]
  thisWeek: number
  streakDays: number
}

// Day-bucketed log history powering the goal-detail data views (Week/Month/Pace/
// Year/By-person/Year-ring). `perMember` may include a key at 0 (a count_once
// shared event's attendee — present, not credited): key on presence, not amount>0.
export interface GoalActivityDay {
  dateKey: string // YYYY-MM-DD, household-local
  total: number
  perMember: Record<string, number>
}

export interface GoalActivity {
  startDate: string // YYYY-MM-DD, household-local — goal.createdAt's local date
  endDate: string | null // goal.deadline
  today: string // YYYY-MM-DD, household-local
  days: GoalActivityDay[]
}

export const goalsApi = {
  goalLists: () => apiGet<{ lists: GoalList[] }>('/api/goal-lists'),
  createGoalList: (input: Record<string, unknown>) => apiSend<{ list: { id: string } }>('POST', '/api/goal-lists', input),
  updateGoalList: (id: string, patch: Record<string, unknown>) => apiSend<{ ok: boolean }>('PATCH', `/api/goal-lists/${id}`, patch),
  deleteGoalList: (id: string) => apiDelete(`/api/goal-lists/${id}`),
  goals: (listId?: string | null) =>
    apiGet<{ goals: Goal[] }>(listId ? `/api/goals?listId=${listId}` : '/api/goals'),
  goal: (id: string) => apiGet<{ goal: GoalDetail }>(`/api/goals/${id}`),
  activity: (id: string) => apiGet<GoalActivity>(`/api/goals/${id}/activity`),
  createGoal: (input: Record<string, unknown>) => apiSend<{ goal: { id: string } }>('POST', '/api/goals', input).then(tap('goals')),
  updateGoal: (id: string, patch: Record<string, unknown>) => apiSend<{ goal: GoalDetail }>('PATCH', `/api/goals/${id}`, patch).then(tap('goals')),
  logGoal: (id: string, body: { amount?: number; hours?: number; minutes?: number; personIds?: string[]; personId?: string | null; note?: string | null; loggedOn?: string | null }) =>
    apiSend<{ ok: boolean }>('POST', `/api/goals/${id}/log`, body).then(tap('goals')),
  toggleStep: (goalId: string, stepId: string, done: boolean) =>
    apiSend<{ ok: boolean }>('PATCH', `/api/goals/${goalId}/steps/${stepId}`, { done }).then(tap('goals')),
  deleteGoal: (id: string) => apiDelete(`/api/goals/${id}`).then(tap('goals')),
  // Edit or remove a single logged entry (keyed on the grouped id in recent activity).
  editGoalLog: (goalId: string, logId: string, patch: { amount?: number; note?: string | null; loggedOn?: string | null; personIds?: string[] }) =>
    apiSend<{ goal: GoalDetail }>('PATCH', `/api/goals/${goalId}/logs/${logId}`, patch).then(tap('goals')),
  deleteGoalLog: (goalId: string, logId: string) =>
    apiSend<{ goal: GoalDetail }>('DELETE', `/api/goals/${goalId}/logs/${logId}`).then(tap('goals')),
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
  const idRef = useRef(id)
  useEffect(() => {
    if (!id) return
    let alive = true
    // Blank to "Loading…" only when switching to a different goal (or first
    // load) — NOT on a refetch of the same goal (e.g. ticking a checklist step),
    // which would otherwise flash the whole page.
    if (idRef.current !== id) {
      idRef.current = id
      setGoal(null)
      setLoading(true)
    }
    goalsApi
      .goal(id)
      .then((d) => alive && (setGoal(d.goal), setLoading(false), setError(false)))
      .catch(() => alive && (setError(true), setLoading(false)))
    return () => {
      alive = false
    }
  }, [id, nonce])
  // Refetch when anything taps the goals bus (a calendar-recap confirm, a log from
  // elsewhere, etc.). Same-id refetch is silent (no loading flash) per the effect above.
  useRefetchOn(['goals'], () => setNonce((n) => n + 1))
  return { goal, loading, error, refetch: () => setNonce((n) => n + 1) }
}

export interface GoalActivityState {
  activity: GoalActivity | null
  loading: boolean
  error: boolean
}

export function useGoalActivity(id: string | null): GoalActivityState {
  const [activity, setActivity] = useState<GoalActivity | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!id) return
    let alive = true
    setLoading(true)
    goalsApi
      .activity(id)
      .then((d) => alive && (setActivity(d), setLoading(false), setError(false)))
      .catch(() => alive && (setError(true), setLoading(false)))
    return () => {
      alive = false
    }
  }, [id, nonce])
  useRefetchOn(['goals'], () => setNonce((n) => n + 1))
  return { activity, loading, error }
}
