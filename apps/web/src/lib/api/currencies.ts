// Currencies — the per-household reward-economy catalog (phase A). Lets families
// rename "stars" or run several currencies; chores/rewards pick one and the UI
// renders symbols/labels from here instead of hardcoding ⭐.
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'
import { useRefetchOn, emit } from './bus'

export interface Currency {
  id: string
  key: string
  label: string
  symbol: string | null
  color: string | null
  isDefault: boolean
  spendable: boolean
  sortOrder: number
}

export const currenciesApi = {
  list: () => apiGet<{ currencies: Currency[] }>('/api/currencies'),
  create: (body: { label: string; symbol?: string | null; color?: string | null; spendable?: boolean; isDefault?: boolean }) =>
    apiSend<{ currency: Currency }>('POST', '/api/currencies', body).then((r) => r.currency).then((c) => { emit('currencies'); return c }),
  update: (id: string, patch: Record<string, unknown>) =>
    apiSend<{ currency: Currency }>('PATCH', `/api/currencies/${id}`, patch).then((r) => r.currency).then((c) => { emit('currencies'); return c }),
  remove: (id: string) => apiDelete(`/api/currencies/${id}`).then(() => emit('currencies')),
}

// Render a balance/cost with its currency symbol, falling back to the key.
export function fmtCurrency(amount: number, c: Pick<Currency, 'symbol' | 'label'> | undefined): string {
  if (!c) return String(amount)
  return `${c.symbol ?? ''}${c.symbol ? ' ' : ''}${amount}`
}

export interface CurrenciesState {
  currencies: Currency[]
  defaultCurrency: Currency | null
  byKey: Record<string, Currency>
  loading: boolean
  error: boolean
  refetch: () => void
}

// The household's currency catalog (one fetch, shared by every reward surface).
export function useCurrencies(): CurrenciesState {
  const [currencies, setCurrencies] = useState<Currency[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  const refetch = useCallback(() => setNonce((n) => n + 1), [])
  useEffect(() => {
    let alive = true
    currenciesApi
      .list()
      .then((d) => alive && (setCurrencies(d.currencies), setLoading(false)))
      .catch(() => alive && (setError(true), setLoading(false)))
    return () => { alive = false }
  }, [nonce])
  useRefetchOn(['currencies'], refetch)
  const byKey = Object.fromEntries(currencies.map((c) => [c.key, c]))
  const defaultCurrency = currencies.find((c) => c.isDefault) ?? currencies[0] ?? null
  return { currencies, defaultCurrency, byKey, loading, error, refetch }
}
