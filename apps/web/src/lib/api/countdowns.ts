// Countdowns domain — "N days until X". A merged, read-only list from three sources
// (standalone items, is_countdown events, member birthdays); standalone items are CRUD.
import { useEffect, useState } from 'react'
import { apiGet, apiSend, apiDelete } from './client'
import { useRefetchOn, emit } from './bus'

export type CountdownSource = 'standalone' | 'event' | 'birthday'
export interface Countdown {
  id: string
  title: string
  date: string // YYYY-MM-DD
  daysLeft: number
  source: CountdownSource
  emoji: string | null
  color: string | null
  personId: string | null
}

export interface CountdownInput {
  title: string
  date: string
  emoji?: string | null
  color?: string | null
}

// How far ahead a birthday may appear on the countdown list (days). Beyond this it's
// noise; a just-passed birthday's far-off next occurrence also stays hidden until it's
// this close. Mirrors the server default (~6 months).
export const DEFAULT_BIRTHDAY_HORIZON_DAYS = 183

export const countdownsApi = {
  list: () => apiGet<{ countdowns: Countdown[]; sleeps: boolean; birthdayHorizonDays: number }>('/api/countdowns'),
  create: (input: CountdownInput) => apiSend<{ id: string }>('POST', '/api/countdowns', input).then((r) => { emit('countdowns'); return r }),
  update: (id: string, patch: Partial<CountdownInput>) => apiSend('PATCH', `/api/countdowns/${id}`, patch).then((r) => { emit('countdowns'); return r }),
  remove: (id: string) => apiDelete(`/api/countdowns/${id}`).then((r) => { emit('countdowns'); return r }),
  setSleeps: (sleeps: boolean) => apiSend<{ sleeps: boolean }>('PUT', '/api/countdowns/config', { sleeps }).then((r) => { emit('countdowns'); return r }),
  setBirthdayHorizonDays: (birthdayHorizonDays: number) =>
    apiSend<{ birthdayHorizonDays: number }>('PUT', '/api/countdowns/config', { birthdayHorizonDays }).then((r) => { emit('countdowns'); return r }),
}

// Human label for a day distance. `sleeps` swaps "days" → "sleeps" (kid-friendly).
export function countdownLabel(daysLeft: number, sleeps = false): string {
  if (daysLeft <= 0) return 'Today!'
  if (daysLeft === 1) return sleeps ? '1 sleep' : 'Tomorrow'
  return `${daysLeft} ${sleeps ? 'sleeps' : 'days'}`
}

export function useCountdowns() {
  const [countdowns, setCountdowns] = useState<Countdown[]>([])
  const [sleeps, setSleeps] = useState(false)
  const [birthdayHorizonDays, setBirthdayHorizonDays] = useState(DEFAULT_BIRTHDAY_HORIZON_DAYS)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const refetch = () => setNonce((n) => n + 1)
  useRefetchOn(['countdowns'], refetch)
  useEffect(() => {
    let alive = true
    countdownsApi.list().then((d) => {
      if (!alive) return
      setCountdowns(d.countdowns ?? [])
      setSleeps(!!d.sleeps)
      if (typeof d.birthdayHorizonDays === 'number') setBirthdayHorizonDays(d.birthdayHorizonDays)
      setLoading(false)
    }).catch(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [nonce])
  return { countdowns, sleeps, birthdayHorizonDays, loading, refetch }
}
