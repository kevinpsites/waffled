// Person + family overview domain — client slice, types, hooks. Read-only rollups
// powering the per-person profile and the family dashboard.
import { useEffect, useState } from 'react'
import { apiGet } from './client'
import { useRefetchOn } from './bus'

export interface OverviewGoal {
  id: string
  title: string
  emoji: string | null
  category: string | null
  goalType: string
  unit: string | null
  progress: number
  target: number | null
  pct: number | null
  streakDays: number
  milestoneReached: number
  milestoneTotal: number
}

export interface CategoryBalance {
  category: string
  emoji: string
  label: string
  goalCount: number
  avgPct: number
}

export interface OverviewLedgerEntry {
  amount: number
  reason: string
  currency: string
  createdAt: string
}

export interface PersonRedemption {
  id: string
  title: string
  emoji: string | null
  cost: number
  currency: string
  status: string
  createdAt: string
}

export interface OverviewCurrency {
  id: string
  key: string
  label: string
  symbol: string | null
  color: string | null
  isDefault: boolean
  spendable: boolean
  sortOrder: number
}

export interface PersonOverview {
  person: { id: string; name: string | null; avatarEmoji: string | null; colorHex: string | null; age: number | null; memberType: string }
  activeGoals: number
  topStreak: number
  stars: number
  currencies: OverviewCurrency[]
  balances: { currency: string; balance: number }[]
  goals: OverviewGoal[]
  categoryBalance: CategoryBalance[]
  insight: { lean: string[]; light: string[]; suggestions: string[]; text: string }
  recentLedger: OverviewLedgerEntry[]
  redemptions: PersonRedemption[]
}

export interface FamilyMember {
  personId: string
  name: string | null
  avatarEmoji: string | null
  colorHex: string | null
  age: number | null
  activeGoals: number
  avgProgressPct: number
  topStreak: number
  stars: number
}

export const overviewApi = {
  family: () => apiGet<{ people: FamilyMember[] }>('/api/family/overview'),
  person: (id: string) => apiGet<PersonOverview>(`/api/persons/${id}/overview`),
}

export function useFamilyOverview() {
  const [state, setState] = useState<{ people: FamilyMember[]; loading: boolean; error: boolean }>({ people: [], loading: true, error: false })
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    overviewApi
      .family()
      .then((d) => alive && setState({ people: d.people, loading: false, error: false }))
      .catch(() => alive && setState({ people: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [nonce])
  // family numbers shift when goals are logged or chores award stars
  useRefetchOn(['goals', 'chores', 'rewards'], () => setNonce((n) => n + 1))
  return state
}

export function usePersonOverview(id: string | null) {
  const [state, setState] = useState<{ data: PersonOverview | null; loading: boolean; error: boolean }>({ data: null, loading: true, error: false })
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!id) return
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    overviewApi
      .person(id)
      .then((d) => alive && setState({ data: d, loading: false, error: false }))
      .catch(() => alive && setState({ data: null, loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [id, nonce])
  useRefetchOn(['goals', 'chores', 'rewards'], () => setNonce((n) => n + 1))
  return state
}
