// Calendar events domain — client slice, types, and hooks.
import { useEffect, useRef, useState } from 'react'
import { apiGet, apiSend, apiDelete, localToday } from './client'
import { watchAgendaRows, eventsForDay, eventsForRange, getHouseholdTz } from '../powersync/events-local'

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
  personName: string | null
  personColor: string | null
  personEmoji: string | null
  participants: Participant[]
}

export const eventsApi = {
  eventsToday: (date: string) => apiGet<{ date: string; events: AgendaEvent[] }>(`/api/events/today?date=${date}`),
  eventsRange: (from: string, to: string) =>
    apiGet<{ from: string; to: string; events: AgendaEvent[] }>(`/api/events?from=${from}&to=${to}`),
  createEvent: (input: {
    title: string
    startsAt: string
    endsAt?: string | null
    allDay?: boolean
    personId?: string | null
    participantIds?: string[]
    location?: string | null
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
      .then((d) => alive && !localActive.current && setState({ events: d.events, loading: false, error: false }))
      .catch(() => alive && !localActive.current && setState({ events: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [date, nonce])

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
      .then((d) => alive && !localActive.current && setState({ events: d.events, loading: false, error: false }))
      .catch(() => alive && !localActive.current && setState({ events: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [from, to, nonce])

  return { ...state, refetch: () => setNonce((n) => n + 1) }
}
