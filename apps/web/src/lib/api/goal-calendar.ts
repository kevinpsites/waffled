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

// An untagged event the matcher thinks might count toward a goal (Phase B).
export interface Suggestion {
  eventId: string
  title: string
  startsAt: string
  allDay: boolean
  goalId: string
  goalTitle: string
  goalEmoji: string | null
  via: 'memory' | 'keyword' | 'llm'
}

export const goalCalendarApi = {
  recap: (goalId?: string | null) =>
    apiGet<{ items: RecapItem[] }>(goalId ? `/api/goal-calendar/recap?goalId=${goalId}` : '/api/goal-calendar/recap'),
  confirm: (body: { eventId: string; occurrenceDate: string; amount: number; personIds: string[]; note?: string | null }) =>
    apiSend<{ status: string }>('POST', '/api/goal-calendar/recap/confirm', body).then(tap('goals')),
  skip: (body: { eventId: string; occurrenceDate: string }) =>
    apiSend<{ ok: boolean }>('POST', '/api/goal-calendar/recap/skip', body).then(tap('goals')),
  suggestions: () => apiGet<{ items: Suggestion[] }>('/api/goal-calendar/suggestions'),
  // Live preview for the modal: memory → keyword → LLM for one not-yet-saved
  // event. Pass an AbortSignal so a superseded request (attendees changed mid-
  // flight) is cancelled instead of racing the new one.
  suggestOne: (body: { title: string; participantIds: string[] }, signal?: AbortSignal) =>
    apiSend<{ suggestion: { goalId: string; goalTitle: string; goalEmoji: string | null; via: string } | null }>(
      'POST',
      '/api/goal-calendar/suggest-one',
      body,
      signal
    ),
  // Linking taps goals (a freshly-linked, already-ended event becomes a recap item)
  // and meals/events so the calendar reflects the new link.
  link: (body: { eventId: string; goalId: string }) =>
    apiSend<{ ok: boolean }>('POST', '/api/goal-calendar/suggestions/link', body).then(tap('goals')),
  dismiss: (body: { eventId: string }) =>
    apiSend<{ ok: boolean }>('POST', '/api/goal-calendar/suggestions/dismiss', body),
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

export interface SuggestionsState {
  items: Suggestion[]
  loading: boolean
  error: boolean
  refetch: () => void
}

// Household-wide smart suggestions for the Today review surface. Refetches when
// goals/meals change (e.g. after linking one, it should drop off the list).
export function useGoalSuggestions(): SuggestionsState {
  const [items, setItems] = useState<Suggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    goalCalendarApi
      .suggestions()
      .then((d) => alive && (setItems(d.items), setLoading(false), setError(false)))
      .catch(() => alive && (setError(true), setLoading(false)))
    return () => {
      alive = false
    }
  }, [nonce])
  useRefetchOn(['goals', 'meals'], () => setNonce((n) => n + 1))
  return { items, loading, error, refetch: () => setNonce((n) => n + 1) }
}
