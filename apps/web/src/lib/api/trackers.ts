// Trackers — tap-to-log items; every tap is kept as an entry. Mirrors the DTOs in
// apps/api/src/modules/trackers/trackers.ts.
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'
import { emit, useRefetchOn, useLiveRefresh } from './bus'

export interface Tracker {
  id: string
  title: string
  emoji: string | null
  askPerson: boolean
  sortOrder: number
  archivedAt: string | null
  lastEntry: { id: string; occurredAt: string; personId: string | null; personName: string | null } | null
}

export interface TrackerEntry {
  id: string
  trackerId: string
  occurredAt: string
  personId: string | null
  personName: string | null
  loggedBy: string | null
  loggedByName: string | null
  note: string | null
}

export interface TrackerInput {
  title: string
  emoji?: string | null
  askPerson?: boolean
}

export interface TrackerPatch {
  title?: string
  emoji?: string | null
  askPerson?: boolean
  sortOrder?: number
  archived?: boolean
}

export interface EntryInput {
  personId?: string | null
  occurredAt?: string
  note?: string | null
}

export interface EntryPatch {
  personId?: string | null
  occurredAt?: string
  note?: string | null
}

const done = <T>(r: T): T => { emit('trackers'); return r }

export const trackersApi = {
  list: (includeArchived = false) =>
    apiGet<{ trackers: Tracker[] }>(`/api/trackers${includeArchived ? '?includeArchived=1' : ''}`),
  create: (input: TrackerInput) => apiSend<{ tracker: Tracker }>('POST', '/api/trackers', input).then(done),
  update: (id: string, patch: TrackerPatch) => apiSend<{ tracker: Tracker }>('PATCH', `/api/trackers/${id}`, patch).then(done),
  remove: (id: string) => apiDelete(`/api/trackers/${id}`).then(done),
  log: (id: string, input: EntryInput = {}) => apiSend<{ entry: TrackerEntry }>('POST', `/api/trackers/${id}/entries`, input).then(done),
  // `before` is the opaque nextBefore cursor from the previous page; pass it back untouched.
  entries: (id: string, opts: { personId?: string; before?: string } = {}) => {
    const qs = new URLSearchParams()
    if (opts.personId) qs.set('personId', opts.personId)
    if (opts.before) qs.set('before', opts.before)
    const s = qs.toString()
    return apiGet<{ entries: TrackerEntry[]; nextBefore: string | null }>(`/api/trackers/${id}/entries${s ? `?${s}` : ''}`)
  },
  updateEntry: (id: string, patch: EntryPatch) => apiSend<{ entry: TrackerEntry }>('PATCH', `/api/tracker-entries/${id}`, patch).then(done),
  deleteEntry: (id: string) => apiDelete(`/api/tracker-entries/${id}`).then(done),
}

export function useTrackers(): { trackers: Tracker[] | null; error: string | null; refresh: () => void } {
  const [trackers, setTrackers] = useState<Tracker[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  useRefetchOn(['trackers'], refresh)
  useLiveRefresh(refresh)
  useEffect(() => {
    let alive = true
    trackersApi.list().then((d) => {
      if (!alive) return
      setTrackers(d.trackers ?? [])
      setError(null)
    }).catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Could not load trackers') })
    return () => { alive = false }
  }, [nonce])
  return { trackers, error, refresh }
}
