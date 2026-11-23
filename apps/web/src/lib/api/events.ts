// Calendar events domain — client slice, types, and hooks.
import { useEffect, useRef, useState } from 'react'
import { apiGet, apiGetCached, apiSend, apiDelete, localToday } from './client'
import { useRefetchOn, tap } from './bus'

export interface Participant {
  id: string
  name: string
  colorHex: string | null
  avatarEmoji: string | null
}

export interface AgendaEvent {
  id: string
  title: string
  startsAt: string
  endsAt: string | null
  allDay: boolean
  isCountdown?: boolean
  location: string | null
  personId: string | null
  goalId?: string | null
  goalStepId?: string | null
  // A scheduling-shape rhythm books an ordinary event and points it back at itself.
  rhythmId?: string | null
  personName: string | null
  personColor: string | null
  personEmoji: string | null
  participants: Participant[]
  // Detail-screen fields (present on the single-event fetch).
  description?: string | null
  rrule?: string | null
  recurrenceEndAt?: string | null
  calendarName?: string | null
  syncState?: string | null
  // origin='meal_plan' events link to a meal_plan_entry via originRefId — the
  // calendar opens the linked recipe when one is tapped.
  origin?: string | null
  originRefId?: string | null
  // Recurrence: seriesId is the master event (=== id for a single event);
  // occurrenceStart is the rule slot for a recurring occurrence (else null). These
  // are the handles for "edit this occurrence / this and following".
  seriesId?: string
  occurrenceStart?: string | null
}

export const eventsApi = {
  eventsToday: (date: string) => apiGet<{ date: string; events: AgendaEvent[] }>(`/api/events/today?date=${date}`),
  eventsRange: (from: string, to: string) =>
    apiGet<{ from: string; to: string; events: AgendaEvent[] }>(`/api/events?from=${from}&to=${to}`),
  event: (id: string) => apiGet<{ event: AgendaEvent }>(`/api/events/${id}`),
  // AI cards (honor the household's provider via the server; both fall back to a
  // deterministic summary server-side, so they always return something useful).
  // Cached briefly so leaving and returning to a screen doesn't re-run the model.
  headsUp: (from: string, to: string) =>
    apiGetCached<{ headline: string; body: string; via: string }>(`/api/calendar/heads-up?from=${from}&to=${to}`, 5 * 60_000),
  eventInsight: (id: string) =>
    apiGetCached<{ headline: string; body: string; leaveBy: string | null; reminder: string; via: string }>(`/api/events/${id}/insight`, 5 * 60_000),
  createEvent: (input: {
    title: string
    startsAt: string
    endsAt?: string | null
    allDay?: boolean
    isCountdown?: boolean
    personId?: string | null
    participantIds?: string[]
    location?: string | null
    goalId?: string | null
    goalStepId?: string | null
    calendarId?: string | null
    rrule?: string | null
    recurrenceEndAt?: string | null
    rdate?: string | null
    exdate?: string | null
  }) => apiSend<{ event: AgendaEvent }>('POST', '/api/events', input).then(tap('events')),
  updateEvent: (id: string, patch: Record<string, unknown>) =>
    apiSend<{ event: AgendaEvent }>('PATCH', `/api/events/${id}`, patch).then(tap('events')),
  // Recurring deletes pass a scope ('this'|'following') + the occurrence slot;
  // omit opts (or pass scope 'all'/none) to delete the whole series / a single event.
  deleteEvent: (id: string, opts?: { scope?: string; occurrenceStart?: string | null }) => {
    const q = new URLSearchParams()
    if (opts?.scope) q.set('scope', opts.scope)
    if (opts?.occurrenceStart) q.set('occurrenceStart', opts.occurrenceStart)
    const qs = q.toString()
    return apiDelete(`/api/events/${id}${qs ? `?${qs}` : ''}`).then(tap('events'))
  },
}

export interface AgendaState {
  events: AgendaEvent[]
  loading: boolean
  error: boolean
}

function useAgendaFeed(
  fetchRest: () => Promise<AgendaEvent[]>,
  deps: unknown[],
  loadingOnRefetch: boolean
): AgendaState & { refetch: () => void } {
  const [state, setState] = useState<AgendaState>({ events: [], loading: true, error: false })
  const [nonce, setNonce] = useState(0)
  // Latest closure without re-running the effect (its identity changes every render).
  const fetchRef = useRef(fetchRest)
  fetchRef.current = fetchRest

  useEffect(() => {
    let alive = true
    if (loadingOnRefetch) setState((s) => ({ ...s, loading: true }))
    fetchRef
      .current()
      .then((events) => {
        if (alive) setState({ events, loading: false, error: false })
      })
      .catch(() => {
        // A failed refetch never blanks rows already on screen.
        if (!alive) return
        setState((s) => (s.events.length ? { ...s, loading: false } : { events: [], loading: false, error: true }))
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const refetch = () => setNonce((n) => n + 1)
  useRefetchOn(['events'], refetch)
  return { ...state, refetch }
}

export function useEventsToday(): AgendaState & { refetch: () => void } {
  const date = localToday()
  // No spinner on refetch here: the Today card is always on screen, so flashing
  // it would be worse than briefly showing the previous day's rows.
  const feed = useAgendaFeed(() => eventsApi.eventsToday(date).then((d) => d.events), [date], false)
  // Meals and rhythms each create a calendar event when planned/booked.
  useRefetchOn(['meals', 'rhythms'], feed.refetch)
  return feed
}

export function useEventsRange(from: string, to: string): AgendaState & { refetch: () => void } {
  const feed = useAgendaFeed(() => eventsApi.eventsRange(from, to).then((d) => d.events), [from, to], true)
  useRefetchOn(['meals', 'rhythms'], feed.refetch)
  return feed
}

// One event with its full detail (the EventDetail screen). `notFound`
// distinguishes a deleted event from a slow load.
export function useEvent(id: string): { event: AgendaEvent | null; loading: boolean; notFound: boolean; refetch: () => void } {
  const [event, setEvent] = useState<AgendaEvent | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [nonce, setNonce] = useState(0)
  // The id whose event is on screen: a refetch of it must not flash a spinner or
  // surface a 404 (an `events` publish from this very delete lands before navigation).
  const shownId = useRef<string | null>(null)

  useEffect(() => {
    let alive = true
    const refetching = shownId.current === id
    if (!refetching) {
      setLoading(true)
      setNotFound(false)
    }
    eventsApi
      .event(id)
      .then((d) => {
        if (!alive) return
        shownId.current = id
        setEvent(d.event)
        setNotFound(false)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (!alive) return
        // 404 → gone, unless we're already showing it; other errors (offline) keep what is shown.
        if (!refetching && err instanceof Error && /->\s*404/.test(err.message)) setNotFound(true)
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [id, nonce])

  useRefetchOn(['meals', 'events'], () => setNonce((n) => n + 1))

  return { event, loading, notFound, refetch: () => setNonce((n) => n + 1) }
}
