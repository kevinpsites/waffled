// Whether this household is connected to Mealie. Mounted inside AuthGate so it never
// fires for signed-out screens. Reports connected:false while loading or on error so the
// built-in screens show by default.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { mealieApi } from './api/mealie'
import { useRefetchOn, useLiveRefresh } from './api/bus'

export interface MealieState {
  connected: boolean
  hasShoppingList: boolean
  loading: boolean
  refresh: () => void
}

const DEFAULT: MealieState = { connected: false, hasShoppingList: false, loading: false, refresh: () => {} }
const Ctx = createContext<MealieState>(DEFAULT)

export function MealieProvider({ children }: { children: ReactNode }) {
  const [conn, setConn] = useState<{ connected: boolean; hasShoppingList: boolean } | null>(null)
  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  useRefetchOn(['mealie'], refresh)
  useLiveRefresh(refresh, 60000)
  useEffect(() => {
    let alive = true
    mealieApi.connection()
      .then((c) => alive && setConn({ connected: !!c.connected, hasShoppingList: !!c.connected && !!c.shoppingListId }))
      .catch(() => alive && setConn({ connected: false, hasShoppingList: false }))
    return () => { alive = false }
  }, [nonce])
  const value = useMemo<MealieState>(
    () => ({ connected: conn?.connected ?? false, hasShoppingList: conn?.hasShoppingList ?? false, loading: conn === null, refresh }),
    [conn, refresh]
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useMealie(): MealieState {
  return useContext(Ctx)
}
