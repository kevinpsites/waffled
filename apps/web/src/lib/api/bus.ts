// A tiny cross-surface event bus so a mutation on one screen refreshes the others
// that show the same data (e.g. adding a grocery item on the Lists board updates
// the Today grocery card; planning a dinner refreshes the grocery board's "this
// week's dinners"). Mutations `emit(topic)`; data hooks `useRefetchOn(topics, …)`.
import { useEffect, useRef } from 'react'

export type Topic = 'grocery' | 'meals' | 'chores' | 'rewards' | 'goals'

export function emit(topic: Topic): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(`nook:${topic}`))
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
    const names = key.split(',').map((t) => `nook:${t}`)
    names.forEach((n) => window.addEventListener(n, handler))
    return () => names.forEach((n) => window.removeEventListener(n, handler))
  }, [key])
}
