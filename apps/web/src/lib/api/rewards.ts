// Rewards + balances domain — the "spend" half of the stars loop. A rewards
// catalog, per-person star balances, and the parent-approval redemption queue.
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'
import { tap, useRefetchOn } from './bus'
import type { Currency } from './currencies'

export interface Reward {
  id: string
  title: string
  emoji: string | null
  cost: number
  currency: string
  sortOrder: number
  requiresApproval: boolean
}

export interface LedgerEntry {
  amount: number
  reason: string
  currency: string
  createdAt: string
}

export interface CurrencyBalance {
  currency: string // currency key
  balance: number
}

export interface PersonBalance {
  personId: string
  name: string | null
  avatarEmoji: string | null
  colorHex: string | null
  stars: number // default-currency total (back-compat)
  balances: CurrencyBalance[]
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
  createReward: (body: { title: string; emoji?: string | null; cost: number; currency?: string; requiresApproval?: boolean }) =>
    apiSend<{ reward: Reward }>('POST', '/api/rewards', body).then((r) => r.reward),
  updateReward: (id: string, patch: { title?: string; emoji?: string | null; cost?: number; currency?: string; requiresApproval?: boolean }) =>
    apiSend<{ reward: Reward }>('PATCH', `/api/rewards/${id}`, patch).then((r) => r.reward),
  deleteReward: (id: string) => apiDelete(`/api/rewards/${id}`), // soft archive
  archivedRewards: () => apiGet<{ rewards: Reward[] }>('/api/rewards/archived'), // admin only
  restoreReward: (id: string) => apiSend<{ reward: Reward }>('POST', `/api/rewards/${id}/restore`).then((r) => r.reward),
  balances: () => apiGet<{ currencies: Currency[]; people: PersonBalance[] }>('/api/balances'),
  redemptions: (status?: string) =>
    apiGet<{ redemptions: Redemption[] }>(`/api/redemptions${status ? `?status=${status}` : ''}`),
  redeem: (rewardId: string, personId: string) =>
    apiSend<{ redemption: Redemption }>('POST', `/api/rewards/${rewardId}/redeem`, { personId }).then((r) => r.redemption).then(tap('rewards')),
  approve: (id: string) => apiSend<{ redemption: Redemption }>('POST', `/api/redemptions/${id}/approve`).then((r) => r.redemption).then(tap('rewards')),
  deny: (id: string) => apiSend<{ redemption: Redemption }>('POST', `/api/redemptions/${id}/deny`).then((r) => r.redemption).then(tap('rewards')),
  // Household reward-approval policy (Settings → Chores & rewards). Off = kids redeem instantly.
  settings: () => apiGet<{ requireApproval: boolean }>('/api/rewards/settings'),
  setSettings: (requireApproval: boolean) =>
    apiSend<{ requireApproval: boolean }>('PUT', '/api/rewards/settings', { requireApproval }).then((r) => r.requireApproval).then(tap('rewards')),
}

export interface RewardsHubState {
  rewards: Reward[]
  balances: PersonBalance[]
  currencies: Currency[]
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
    currencies: [],
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
      .then(([r, b, p]) => alive && setState({ rewards: r.rewards, balances: b.people, currencies: b.currencies, pending: p.redemptions, loading: false, error: false }))
      .catch(() => alive && setState({ rewards: [], balances: [], currencies: [], pending: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [nonce])
  // balances shift when chores award stars; rewards change on redeem/approve/deny;
  // currencies change when the catalog is edited in Settings
  useRefetchOn(['rewards', 'chores', 'currencies'], refetch)
  return { ...state, refetch }
}
