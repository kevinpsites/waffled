// Calendar events domain — client slice, types, and hooks.
import { useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete, localToday } from './client'

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
    location?: string | null
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

export function useEventsToday(): AgendaState & { refetch: () => void } {
  const [state, setState] = useState<AgendaState>({ events: [], loading: true, error: false })
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    eventsApi
      .eventsToday(localToday())
      .then((d) => alive && setState({ events: d.events, loading: false, error: false }))
      .catch(() => alive && setState({ events: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [nonce])
  return { ...state, refetch: () => setNonce((n) => n + 1) }
}

export function useEventsRange(from: string, to: string): AgendaState & { refetch: () => void } {
  const [state, setState] = useState<AgendaState>({ events: [], loading: true, error: false })
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    eventsApi
      .eventsRange(from, to)
      .then((d) => alive && setState({ events: d.events, loading: false, error: false }))
      .catch(() => alive && setState({ events: [], loading: false, error: true }))
    return () => {
      alive = false
    }
  }, [from, to, nonce])
  return { ...state, refetch: () => setNonce((n) => n + 1) }
}
