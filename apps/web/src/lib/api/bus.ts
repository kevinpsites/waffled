// A tiny cross-surface event bus so a mutation on one screen refreshes the others
// that show the same data (e.g. adding a grocery item on the Lists board updates
// the Today grocery card; planning a dinner refreshes the grocery board's "this
// week's dinners"). Mutations `emit(topic)`; data hooks `useRefetchOn(topics, …)`.
import { useEffect, useRef } from 'react'

export type Topic = 'grocery' | 'meals' | 'chores' | 'rewards' | 'goals' | 'currencies' | 'recipes' | 'countdowns' | 'familyNight' | 'waffledBites' | 'rhythms'

export function emit(topic: Topic): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(`waffled:${topic}`))
}

// Pass-through tap for promise chains: `.then(tap('grocery'))`.
export function tap<T>(topic: Topic): (v: T) => T {
  return (v: T) => {
    emit(topic)
    return v
  }
}

// Subscribe `refetch` to one or more topics. The callback is kept in a ref so an
// unstable `refetch` identity (common with inline nonce bumps) doesn't churn the
// listeners every render.
export function useRefetchOn(topics: Topic[], refetch: () => void): void {
  const ref = useRef(refetch)
  ref.current = refetch
  const key = topics.join(',')
  useEffect(() => {
    const handler = () => ref.current()
    const names = key.split(',').map((t) => `waffled:${t}`)
    names.forEach((n) => window.addEventListener(n, handler))
    return () => names.forEach((n) => window.removeEventListener(n, handler))
  }, [key])
}

// Cross-device liveness for a mounted view: poll every `intervalMs` while the tab is
// visible, and refetch immediately when the tab regains focus/visibility. The event
// bus (`useRefetchOn`) only syncs surfaces in the SAME tab, so without this a family
// member's check on another device wouldn't show until a manual reload. Polling pauses
// while hidden (no point fetching a backgrounded tab) and fires once on re-show.
export function useLiveRefresh(refetch: () => void, intervalMs = 20000): void {
  const ref = useRef(refetch)
  ref.current = refetch
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const start = () => {
      if (timer != null) return
      timer = setInterval(() => { if (document.visibilityState === 'visible') ref.current() }, intervalMs)
    }
    const stop = () => { if (timer != null) { clearInterval(timer); timer = undefined } }
    const onVisible = () => {
      if (document.visibilityState === 'visible') { ref.current(); start() }
      else stop()
    }
    const onFocus = () => ref.current()
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
    }
  }, [intervalMs])
}
