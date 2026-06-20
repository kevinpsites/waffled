// Today dashboard card layout — client slice + hook. Two tiers: a family default
// and a per-person override; the API returns the resolved 3-column layout plus
// which tier it came from. See modules/layout/today-layout.ts on the server.
import { useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'

export type LayoutScope = 'user' | 'family'

export interface TodayLayoutResponse {
  resolved: string[][]
  family: string[][] | null
  user: string[][] | null
  source: LayoutScope | 'default'
  cards: string[]
  canEditFamily: boolean
}

export const todayLayoutApi = {
  get: () => apiGet<TodayLayoutResponse>('/api/today-layout'),
  save: (scope: LayoutScope, layout: string[][]) =>
    apiSend<{ ok: boolean; layout: string[][] }>('PUT', '/api/today-layout', { scope, layout }),
  reset: (scope: LayoutScope) => apiDelete(`/api/today-layout?scope=${scope}`),
}

export interface TodayLayoutState {
  resolved: string[][]
  family: string[][] | null
  user: string[][] | null
  source: LayoutScope | 'default'
  canEditFamily: boolean
  loading: boolean
  error: boolean
  save: (scope: LayoutScope, layout: string[][]) => Promise<void>
  reset: (scope: LayoutScope) => Promise<void>
  refetch: () => void
}

const FALLBACK: string[][] = [['agenda'], ['tonight', 'week'], ['chores', 'grocery']]

export function useTodayLayout(): TodayLayoutState {
  const [data, setData] = useState<TodayLayoutResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let alive = true
    todayLayoutApi
      .get()
      .then((d) => alive && (setData(d), setError(false), setLoading(false)))
      .catch(() => alive && (setError(true), setLoading(false)))
    return () => {
      alive = false
    }
  }, [nonce])

  const refetch = () => setNonce((n) => n + 1)

  async function save(scope: LayoutScope, layout: string[][]): Promise<void> {
    const r = await todayLayoutApi.save(scope, layout)
    // Reflect the saved (server-reconciled) layout immediately.
    setData((d) =>
      d
        ? { ...d, [scope]: r.layout, resolved: scope === 'user' || d.user == null ? r.layout : d.resolved, source: scope }
        : d
    )
    refetch()
  }

  async function reset(scope: LayoutScope): Promise<void> {
    await todayLayoutApi.reset(scope)
    refetch()
  }

  return {
    resolved: data?.resolved ?? FALLBACK,
    family: data?.family ?? null,
    user: data?.user ?? null,
    source: data?.source ?? 'default',
    canEditFamily: data?.canEditFamily ?? false,
    loading,
    error,
    save,
    reset,
    refetch,
  }
}
