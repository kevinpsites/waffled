// Rewards + balances domain — the "spend" half of the stars loop. A rewards
// catalog, per-person star balances, and the parent-approval redemption queue.
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'
import { tap, useRefetchOn } from './bus'

export interface Reward {
  id: string
  title: string
  emoji: string | null
  cost: number
  currency: string
  sortOrder: number
}

export interface LedgerEntry {
  amount: number
  reason: string
  createdAt: string
}

export interface PersonBalance {
  personId: string
  name: string | null
  avatarEmoji: string | null
  colorHex: string | null
  stars: number
  recent: LedgerEntry[]
}

export interface Redemption {
  id: string
  rewardId: string
  personId: string
  personName: string | null
  personAvatar: string | null
  personColor: string | null
  title: string
  emoji: string | null
  cost: number
  currency: string
  status: 'pending' | 'approved' | 'denied'
  decidedAt: string | null
  createdAt: string
}

export const rewardsApi = {
  rewards: () => apiGet<{ rewards: Reward[] }>('/api/rewards'),
  createReward: (body: { title: string; emoji?: string | null; cost: number }) =>
    apiSend<{ reward: Reward }>('POST', '/api/rewards', body).then((r) => r.reward),
  deleteReward: (id: string) => apiDelete(`/api/rewards/${id}`),
  balances: () => apiGet<{ people: PersonBalance[] }>('/api/balances'),
  redemptions: (status?: string) =>
    apiGet<{ redemptions: Redemption[] }>(`/api/redemptions${status ? `?status=${status}` : ''}`),
  redeem: (rewardId: string, personId: string) =>
    apiSend<{ redemption: Redemption }>('POST', `/api/rewards/${rewardId}/redeem`, { personId }).then((r) => r.redemption).then(tap('rewards')),
  approve: (id: string) => apiSend<{ redemption: Redemption }>('POST', `/api/redemptions/${id}/approve`).then((r) => r.redemption).then(tap('rewards')),
  deny: (id: string) => apiSend<{ redemption: Redemption }>('POST', `/api/redemptions/${id}/deny`).then((r) => r.redemption).then(tap('rewards')),
}

export interface RewardsHubState {
  rewards: Reward[]
  balances: PersonBalance[]
  pending: Redemption[]
  loading: boolean
  error: boolean
  refetch: () => void
}

// One hook for the rewards panel — catalog + balances + pending approvals, with a
// shared refetch so any mutation re-pulls all three (balances move when approved).
export function useRewardsHub(): RewardsHubState {
  const [state, setState] = useState<Omit<RewardsHubState, 'refetch'>>({
    rewards: [],
    balances: [],
    pending: [],
    loading: true,
    error: false,
  })
  const [nonce, setNonce] = useState(0)
  const refetch = useCallback(() => setNonce((n) => n + 1), [])
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    Promise.all([rewardsApi.rewards(), rewardsApi.balances(), rewardsApi.redemptions('pending')])
      .then(([r, b, p]) => alive && setState({ rewards: r.rewards, balances: b.people, pending: p.redemptions, loading: false, error: false }))
      .catch(() => alive && setState({ rewards: [], balances: [], pending: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [nonce])
  // balances shift when chores award stars; rewards change on redeem/approve/deny
  useRefetchOn(['rewards', 'chores'], refetch)
  return { ...state, refetch }
}
