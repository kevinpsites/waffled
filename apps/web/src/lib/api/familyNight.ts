// Family Night domain — a recurring family gathering with a customizable agenda of
// "parts" that auto-rotate among members (override per week). Config is admin-owned;
// any member can set who's doing what for the upcoming gathering.
import { useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'
import { useRefetchOn, emit } from './bus'

export interface FamilyNightPart {
  id: string
  label: string
  emoji: string
  rotates: boolean
}

export interface FamilyNightConfig {
  parts: FamilyNightPart[]
  dayOfWeek: number
  time: string
  rotationOrder: string[] | null
  eventId: string | null
  showOnToday: boolean
}

export interface FamilyNightMember {
  id: string
  name: string
  color: string | null
  emoji: string | null
}

export interface FamilyNightAssignment {
  partId: string
  label: string
  emoji: string
  personId: string | null
  personName: string | null
  suggested: boolean
}

export interface FamilyNightView {
  config: FamilyNightConfig
  members: FamilyNightMember[]
  next: {
    date: string
    occurrenceId: string | null
    theme: string | null
    notes: string | null
    status: string
    assignments: FamilyNightAssignment[]
  }
}

export interface OccurrenceInput {
  date: string
  theme?: string | null
  notes?: string | null
  status?: 'planned' | 'done' | 'skipped'
  assignments?: { partId: string; personId: string | null }[]
}

export const familyNightApi = {
  get: () => apiGet<FamilyNightView>('/api/family-night'),
  setConfig: (patch: Partial<FamilyNightConfig>) =>
    apiSend<{ config: FamilyNightConfig }>('PUT', '/api/family-night/config', patch).then((r) => { emit('familyNight'); return r }),
  saveOccurrence: (input: OccurrenceInput) =>
    apiSend<{ id: string }>('POST', '/api/family-night/occurrence', input).then((r) => { emit('familyNight'); return r }),
  schedule: () =>
    apiSend<{ eventId: string }>('POST', '/api/family-night/schedule', {}).then((r) => { emit('familyNight'); return r }),
  unschedule: () =>
    apiDelete('/api/family-night/schedule').then((r) => { emit('familyNight'); return r }),
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const weekdayName = (dow: number) => WEEKDAYS[((dow % 7) + 7) % 7] ?? 'Monday'

export function useFamilyNight() {
  const [view, setView] = useState<FamilyNightView | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const refetch = () => setNonce((n) => n + 1)
  useRefetchOn(['familyNight'], refetch)
  useEffect(() => {
    let alive = true
    familyNightApi.get()
      .then((d) => { if (alive) { setView(d); setLoading(false) } })
      .catch(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [nonce])
  return { view, loading, refetch }
}
