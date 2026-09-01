// Calendar events domain — client slice, types, and hooks.
import { useEffect, useRef, useState } from 'react'
import { apiGet, apiGetCached, apiSend, apiDelete, localToday } from './client'
import { useRefetchOn } from './bus'
import { watchAgendaRows, eventsForDay, eventsForRange, getHouseholdTz, getLocalEvent, dropTombstoned, isEventTombstoned, type LocalEventRow } from '../powersync/events-local'
import { isReplicaTrusted, subscribeSyncHealth } from '../powersync/sync-health'

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
  // Present on both the REST payload and the local PowerSync read; null = not a rhythm.
  rhythmId?: string | null
  personName: string | null
  personColor: string | null
  personEmoji: string | null
  participants: Participant[]
  // Detail-screen fields (present on the single-event fetch; description also
  // streams from the local DB). rrule/calendar are REST-only for now.
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
  }) => apiSend<{ event: AgendaEvent }>('POST', '/api/events', input),
  updateEvent: (id: string, patch: Record<string, unknown>) =>
    apiSend<{ event: AgendaEvent }>('PATCH', `/api/events/${id}`, patch),
  // Recurring deletes pass a scope ('this'|'following') + the occurrence slot;
  // omit opts (or pass scope 'all'/none) to delete the whole series / a single event.
  deleteEvent: (id: string, opts?: { scope?: string; occurrenceStart?: string | null }) => {
    const q = new URLSearchParams()
    if (opts?.scope) q.set('scope', opts.scope)
    if (opts?.occurrenceStart) q.set('occurrenceStart', opts.occurrenceStart)
    const qs = q.toString()
    return apiDelete(`/api/events/${id}${qs ? `?${qs}` : ''}`)
  },
}

export interface AgendaState {
  events: AgendaEvent[]
  loading: boolean
  error: boolean
}

// Offline-first reads with replica-trust arbitration. The local PowerSync DB
// drives state (live, and it works offline) — but only while the replica is
// TRUSTED: it has completed a full sync and the engine isn't wedged (see
// sync-health). An untrusted replica may paint, but only until REST lands. That
// distinction is the fix for the incident where a wedged engine left an empty
// replica in charge and the kiosk rendered a blank calendar while REST had the
// real data all along.
//
// REST is therefore the baseline for the first paint, for REST-only mode, and
// whenever trust is lost. A REST failure never blanks rows already on screen.
function useAgendaFeed(
  computeLocal: (rows: LocalEventRow[], tz: string) => AgendaEvent[],
  fetchRest: () => Promise<AgendaEvent[]>,
  deps: unknown[],
  loadingOnRefetch: boolean
): AgendaState & { refetch: () => void } {
  const [state, setState] = useState<AgendaState>({ events: [], loading: true, error: false })
  const [nonce, setNonce] = useState(0)
  const localActive = useRef(false)
  const restLoaded = useRef(false)
  // Latest closures without re-running the effects (their identity changes every render).
  const computeRef = useRef(computeLocal)
  computeRef.current = computeLocal
  const fetchRef = useRef(fetchRest)
  fetchRef.current = fetchRest

  // Local-first: stream agenda rows straight from the local DB. A trusted replica
  // takes over from REST; an untrusted one only fills in before REST arrives.
  useEffect(() => {
    localActive.current = false
    restLoaded.current = false
    let alive = true
    let dispose = () => {}
    void (async () => {
      const tz = await getHouseholdTz()
      if (!alive) return
      dispose = watchAgendaRows(
        (rows) => {
          if (!alive) return
          const trusted = isReplicaTrusted()
          localActive.current = trusted
          if (trusted || !restLoaded.current) setState({ events: computeRef.current(rows, tz), loading: false, error: false })
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  // REST baseline — applies whenever the local replica hasn't (trustedly) taken
  // over. On failure keep whatever is already painted rather than blanking it.
  useEffect(() => {
    let alive = true
    if (loadingOnRefetch) setState((s) => ({ ...s, loading: true }))
    fetchRef
      .current()
      .then((events) => {
        if (!alive) return
        restLoaded.current = true
        if (!localActive.current) setState({ events, loading: false, error: false })
      })
      .catch(() => {
        if (!alive || localActive.current) return
        setState((s) => (s.events.length ? { ...s, loading: false } : { events: [], loading: false, error: true }))
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  // When replica trust flips (the engine stalls, or recovers), re-arbitrate: hand
  // the wheel straight back to REST on a stall; on recovery the replica re-takes
  // over at its next emission.
  const trustedRef = useRef(isReplicaTrusted())
  useEffect(
    () =>
      subscribeSyncHealth(() => {
        const trusted = isReplicaTrusted()
        if (trusted === trustedRef.current) return
        trustedRef.current = trusted
        if (!trusted) localActive.current = false
        setNonce((n) => n + 1)
      }),
    []
  )

  return { ...state, refetch: () => setNonce((n) => n + 1) }
}

export function useEventsToday(): AgendaState & { refetch: () => void } {
  const date = localToday()
  // No spinner on refetch here: the Today card is always on screen, so flashing
  // it would be worse than briefly showing the previous day's rows.
  const feed = useAgendaFeed(
    (rows, tz) => eventsForDay(rows, tz, date),
    () => eventsApi.eventsToday(date).then((d) => dropTombstoned(d.events)),
    [date],
    false
  )
  // Planning a meal now creates a calendar event — refresh the agenda when meals
  // change (covers the REST path; PowerSync streams it live on its own).
  // …and booking a rhythm creates one the same way, so it gets the same treatment:
  // without it a rhythm booked from the register wasn't on the calendar until a reload.
  useRefetchOn(['meals', 'rhythms'], feed.refetch)
  return feed
}

export function useEventsRange(from: string, to: string): AgendaState & { refetch: () => void } {
  const feed = useAgendaFeed(
    (rows, tz) => eventsForRange(rows, tz, from, to),
    () => eventsApi.eventsRange(from, to).then((d) => dropTombstoned(d.events)),
    [from, to],
    true
  )
  // Planning a meal now creates a calendar event — refresh when meals change
  // (covers the REST path; PowerSync streams it live on its own).
  // …and booking a rhythm creates one the same way, so it gets the same treatment:
  // without it a rhythm booked from the register wasn't on the calendar until a reload.
  useRefetchOn(['meals', 'rhythms'], feed.refetch)
  return feed
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
