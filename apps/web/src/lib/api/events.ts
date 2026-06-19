// Calendar events domain — client slice, types, and hooks.
import { useEffect, useRef, useState } from 'react'
import { apiGet, apiGetCached, apiSend, apiDelete, localToday } from './client'
import { useRefetchOn } from './bus'
import { watchAgendaRows, eventsForDay, eventsForRange, getHouseholdTz, getLocalEvent, dropTombstoned, isEventTombstoned } from '../powersync/events-local'

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
  location: string | null
  personId: string | null
  goalId?: string | null
  personName: string | null
  personColor: string | null
  personEmoji: string | null
  participants: Participant[]
  // Detail-screen fields (present on the single-event fetch; description also
  // streams from the local DB). rrule/calendar are REST-only for now.
  description?: string | null
  rrule?: string | null
  calendarName?: string | null
  syncState?: string | null
  // origin='meal_plan' events link to a meal_plan_entry via originRefId — the
  // calendar opens the linked recipe when one is tapped.
  origin?: string | null
  originRefId?: string | null
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
    personId?: string | null
    participantIds?: string[]
    location?: string | null
    goalId?: string | null
    calendarId?: string | null
  }) => apiSend<{ event: AgendaEvent }>('POST', '/api/events', input),
  updateEvent: (id: string, patch: Record<string, unknown>) =>
    apiSend<{ event: AgendaEvent }>('PATCH', `/api/events/${id}`, patch),
  deleteEvent: (id: string) => apiDelete(`/api/events/${id}`),
}

export interface AgendaState {
  events: AgendaEvent[]
  loading: boolean
  error: boolean
}

// Offline-first reads: the local PowerSync DB drives state once it streams a
// result (live + works offline); REST is the baseline for the first paint and
// whenever PowerSync isn't available. `localActive` stops a REST response (incl. a
// failure while offline) from clobbering local data once local has taken over.
export function useEventsToday(): AgendaState & { refetch: () => void } {
  const date = localToday()
  const [state, setState] = useState<AgendaState>({ events: [], loading: true, error: false })
  const [nonce, setNonce] = useState(0)
  const localActive = useRef(false)

  // Local-first: stream agenda rows straight from the local DB.
  useEffect(() => {
    let alive = true
    let dispose = () => {}
    void (async () => {
      const tz = await getHouseholdTz()
      if (!alive) return
      dispose = watchAgendaRows(
        (rows) => {
          if (!alive) return
          localActive.current = true
          setState({ events: eventsForDay(rows, tz, date), loading: false, error: false })
        },
        () => {
          localActive.current = false // local failed → let REST drive
        }
      )
    })()
    return () => {
      alive = false
      dispose()
    }
  }, [date])

  // REST baseline — only applies while local hasn't taken over.
  useEffect(() => {
    let alive = true
    eventsApi
      .eventsToday(date)
      .then((d) => alive && !localActive.current && setState({ events: dropTombstoned(d.events), loading: false, error: false }))
      .catch(() => alive && !localActive.current && setState({ events: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [date, nonce])

  // Planning a meal now creates a calendar event — refresh the agenda when meals
  // change (covers the REST path; PowerSync streams it live on its own).
  useRefetchOn(['meals'], () => setNonce((n) => n + 1))

  return { ...state, refetch: () => setNonce((n) => n + 1) }
}

export function useEventsRange(from: string, to: string): AgendaState & { refetch: () => void } {
  const [state, setState] = useState<AgendaState>({ events: [], loading: true, error: false })
  const [nonce, setNonce] = useState(0)
  const localActive = useRef(false)

  useEffect(() => {
    localActive.current = false
    let alive = true
    let dispose = () => {}
    void (async () => {
      const tz = await getHouseholdTz()
      if (!alive) return
      dispose = watchAgendaRows(
        (rows) => {
          if (!alive) return
          localActive.current = true
          setState({ events: eventsForRange(rows, tz, from, to), loading: false, error: false })
        },
        () => {
          localActive.current = false
        }
      )
    })()
    return () => {
      alive = false
      dispose()
    }
  }, [from, to])

  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    eventsApi
      .eventsRange(from, to)
      .then((d) => alive && !localActive.current && setState({ events: dropTombstoned(d.events), loading: false, error: false }))
      .catch(() => alive && !localActive.current && setState({ events: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [from, to, nonce])

  // Planning a meal now creates a calendar event — refresh when meals change
  // (covers the REST path; PowerSync streams it live on its own).
  useRefetchOn(['meals'], () => setNonce((n) => n + 1))

  return { ...state, refetch: () => setNonce((n) => n + 1) }
}

// One event with its full detail (the EventDetail screen). Paints instantly from
// the local DB when available, then REST fills the richer fields (rrule, calendar
// name) the local schema doesn't carry. `notFound` distinguishes a deleted event
// from a slow load.
export function useEvent(id: string): { event: AgendaEvent | null; loading: boolean; notFound: boolean; refetch: () => void } {
  const [event, setEvent] = useState<AgendaEvent | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [nonce, setNonce] = useState(0)
  const restLoaded = useRef(false)

  useEffect(() => {
    let alive = true
    restLoaded.current = false
    setLoading(true)
    setNotFound(false)
    // Local-first paint (instant, offline). It must NOT clobber the REST result —
    // the local row lacks the richer fields (calendar name, rrule) — so it only
    // fills in before REST lands (the two race; local can resolve last).
    void (async () => {
      const tz = await getHouseholdTz()
      const local = await getLocalEvent(id, tz)
      if (alive && local && !restLoaded.current) setEvent((cur) => cur ?? local)
    })()
    eventsApi
      .event(id)
      .then((d) => {
        if (!alive) return
        restLoaded.current = true
        // A just-deleted event can still come back from a stale read inside the
        // replication window — treat a tombstoned id as gone.
        if (isEventTombstoned(id)) { setNotFound(true); setLoading(false); return }
        setEvent(d.event)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (!alive) return
        // 404 → gone; other errors (offline) keep whatever local gave us.
        if (err instanceof Error && /->\s*404/.test(err.message)) setNotFound(true)
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [id, nonce])

  useRefetchOn(['meals'], () => setNonce((n) => n + 1))

  return { event, loading, notFound, refetch: () => setNonce((n) => n + 1) }
}
