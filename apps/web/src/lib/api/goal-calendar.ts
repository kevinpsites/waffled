// Calendar → goal auto-counting — client slice. The "did these happen?" recap
// queue (linked events whose occurrence has ended, not yet confirmed/skipped) and
// the confirm/skip writes. Confirming taps the goals + meals refetch buses so the
// goal detail / Today refresh once progress lands.
import { useEffect, useState } from 'react'
import { apiGet, apiSend } from './client'
import { tap, useRefetchOn } from './bus'

export interface RecapItem {
  eventId: string
  occurrenceDate: string
  title: string
  startsAt: string
  endsAt: string | null
  allDay: boolean
  goalId: string
  goalTitle: string
  goalEmoji: string | null
  goalType: string
  unit: string | null
  trackingMode: string
  suggestedAmount: number
  defaultPersonIds: string[]
  goalParticipantIds: string[]
  goalStepId: string | null
  stepLabel: string | null
}

export const goalCalendarApi = {
  recap: (goalId?: string | null) =>
    apiGet<{ items: RecapItem[] }>(goalId ? `/api/goal-calendar/recap?goalId=${goalId}` : '/api/goal-calendar/recap'),
  confirm: (body: { eventId: string; occurrenceDate: string; amount: number; personIds: string[]; note?: string | null }) =>
    apiSend<{ status: string }>('POST', '/api/goal-calendar/recap/confirm', body).then(tap('goals')),
  skip: (body: { eventId: string; occurrenceDate: string }) =>
    apiSend<{ ok: boolean }>('POST', '/api/goal-calendar/recap/skip', body).then(tap('goals')),
}

export interface RecapState {
  items: RecapItem[]
  loading: boolean
  error: boolean
  refetch: () => void
}

// The recap queue. Pass a goalId to scope it to one goal (goal detail); omit for
// the household-wide Today queue. Refetches when goals or meals (which create
// events) change.
export function useGoalRecap(goalId?: string | null): RecapState {
  const [items, setItems] = useState<RecapItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    goalCalendarApi
      .recap(goalId)
      .then((d) => alive && (setItems(d.items), setLoading(false), setError(false)))
      .catch(() => alive && (setError(true), setLoading(false)))
    return () => {
      alive = false
    }
  }, [goalId, nonce])
  useRefetchOn(['goals', 'meals'], () => setNonce((n) => n + 1))
  return { items, loading, error, refetch: () => setNonce((n) => n + 1) }
}
