// Rhythms domain — the standing intentions that should keep happening, and the one
// place to confirm they actually will. See docs/product/rhythms-plan.md.
//
// Two shapes, and the difference is what closes out a period:
//   'completion' — you did the thing. Surfaces as `kind: 'due'`.
//   'scheduling' — a calendar event exists for the period. Surfaces as
//                  `kind: 'unscheduled'`. We never ask whether it happened; getting
//                  the opportunity onto the calendar IS the outcome.
//
// That second sentence is the whole line between a rhythm and a goal, and it is a
// copy rule as much as a data one: nothing here says "streak", "completed" or
// "on track" for a scheduling rhythm. The question is "did this get scheduled?".
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiSend, localToday } from './client'
import { useRefetchOn, emit } from './bus'

export type SatisfiedBy = 'completion' | 'scheduling'

export interface Rhythm {
  id: string
  title: string
  emoji: string | null
  notes: string | null
  personId: string | null
  satisfiedBy: SatisfiedBy
  /** Postgres interval text — '7 days', '3 mons'. Render via cadenceLabel. */
  every: string
  /** scheduling only: the anchor the period grid is measured from (YYYY-MM-DD). */
  startsOn: string | null
  autoSchedule: boolean
  rrule: string | null
  /** Postgres interval text, clamped server-side to at most half of `every`. */
  leadTime: string
  lastCompletedAt: string | null
  nextDueAt: string | null
  isActive: boolean
}

export type AttentionItem =
  | { kind: 'due'; rhythm: Rhythm; dueAt: string; overdue: boolean }
  | { kind: 'unscheduled'; rhythm: Rhythm; periodStart: string; periodEnd: string }

export interface Completion {
  id: string
  personId: string | null
  completedAt: string
  notes: string | null
}

export interface CreateRhythmInput {
  title: string
  emoji?: string | null
  notes?: string | null
  personId?: string | null
  satisfiedBy: SatisfiedBy
  /** An interval Postgres understands — '3 months', '7 days'. */
  every: string
  leadTime?: string
  // completion shape
  nextDueAt?: string
  // scheduling shape
  startsOn?: string
  autoSchedule?: boolean
  rrule?: string | null
}

export interface ScheduleRhythmInput {
  startsAt: string
  endsAt?: string | null
  allDay?: boolean
}

export const rhythmsApi = {
  list: () => apiGet<{ rhythms: Rhythm[] }>('/api/rhythms'),
  // Both dates are required server-side, and `to` is load-bearing twice over: it is
  // the horizon AND the date that picks which period a scheduling rhythm reports on.
  // Widening it to "see further ahead" silently answers about a LATER period, so
  // every caller here passes today.
  attention: (from: string, to: string) =>
    apiGet<{ items: AttentionItem[] }>(`/api/rhythms/attention?from=${from}&to=${to}`),
  create: (input: CreateRhythmInput) =>
    apiSend<{ rhythm: Rhythm }>('POST', '/api/rhythms', input).then((r) => { emit('rhythms'); return r }),
  complete: (id: string, body: { completedAt?: string; notes?: string } = {}) =>
    apiSend<{ rhythm: Rhythm }>('POST', `/api/rhythms/${id}/complete`, body).then((r) => { emit('rhythms'); return r }),
  // Books a period into a REAL calendar event. Title and assignee come from the
  // rhythm itself, so a booking UI needs a time picker and nothing else — retyping
  // the title is precisely the friction that keeps these things off the calendar.
  schedule: (id: string, input: ScheduleRhythmInput) =>
    apiSend<{ event: { id: string } }>('POST', `/api/rhythms/${id}/schedule`, input).then((r) => {
      emit('rhythms')
      return r
    }),
  // How a period goes quiet without inventing a calendar entry for something that
  // genuinely isn't happening this time round.
  skip: (id: string, periodStart: string) =>
    apiSend<{ ok: true }>('POST', `/api/rhythms/${id}/skip`, { periodStart }).then((r) => { emit('rhythms'); return r }),
  completions: (id: string) => apiGet<{ completions: Completion[] }>(`/api/rhythms/${id}/completions`),
}

// ── Rendering Postgres intervals ────────────────────────────────────────────────
// `interval::text` comes back in Postgres shorthand ('3 mons', '3 days 12:00:00'),
// which is not something to put in front of a person.

interface Parts { year: number; mon: number; week: number; day: number; hour: number; min: number }

function parseInterval(text: string): Parts {
  const p: Parts = { year: 0, mon: 0, week: 0, day: 0, hour: 0, min: 0 }
  if (!text) return p
  const re = /(-?\d+)\s*(years?|yrs?|mons?|months?|weeks?|days?|hours?|hrs?|mins?|minutes?|secs?|seconds?)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1])
    const u = m[2]
    if (u.startsWith('year') || u.startsWith('yr')) p.year += n
    else if (u.startsWith('mon')) p.mon += n
    else if (u.startsWith('week')) p.week += n
    else if (u.startsWith('day')) p.day += n
    else if (u.startsWith('hour') || u.startsWith('hr')) p.hour += n
    else if (u.startsWith('min')) p.min += n
  }
  // The HH:MM:SS tail Postgres appends for sub-day remainders ('3 days 12:00:00').
  const clock = /(-?\d+):(\d{2}):(\d{2})/.exec(text)
  if (clock) {
    p.hour += Number(clock[1])
    p.min += Number(clock[2])
  }
  return p
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${Math.abs(n) === 1 ? '' : 's'}`
}

/** '3 mons' → '3 months'; '7 days' → '1 week'; '3 days 12:00:00' → '3 days 12 hours'. */
export function formatInterval(text: string): string {
  const p = parseInterval(text ?? '')
  const out: string[] = []
  if (p.year) out.push(plural(p.year, 'year'))
  if (p.mon) out.push(plural(p.mon, 'month'))
  // Whole weeks read better than "14 days"; a remainder stays in days.
  let weeks = p.week
  let days = p.day
  if (days && days % 7 === 0) {
    weeks += days / 7
    days = 0
  }
  if (weeks) out.push(plural(weeks, 'week'))
  if (days) out.push(plural(days, 'day'))
  if (p.hour) out.push(plural(p.hour, 'hour'))
  if (p.min) out.push(plural(p.min, 'minute'))
  return out.join(' ')
}

/** '7 days' → 'every week'; '3 mons' → 'every 3 months'. */
export function cadenceLabel(every: string): string {
  const text = formatInterval(every)
  if (!text) return ''
  // A single "1 <unit>" reads as "every week", not "every 1 week".
  const one = /^1 (year|month|week|day|hour|minute)$/.exec(text)
  return one ? `every ${one[1]}` : `every ${text}`
}

// Whole calendar days between two moments, counted on the VIEWER's clock. Doing
// this in UTC reads correct all afternoon and then slips a day every evening west
// of UTC (and every small hour east of it) — which is when a kitchen kiosk is
// actually being looked at. Matches localToday().
function dayDiff(target: Date, now: Date): number {
  const a = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate())
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((a - b) / 86400000)
}

/**
 * The completion shape's status line. Overdue is stated plainly — this is a
 * maintenance register, not a scorecard, so there is no "missed" or "broken".
 */
export function dueLabel(dueAt: string, overdue: boolean, now: Date = new Date()): string {
  const days = dayDiff(new Date(dueAt), now)
  if (overdue || days < 0) {
    const late = Math.max(1, -days)
    return `${plural(late, 'day')} overdue`
  }
  if (days === 0) return 'due today'
  if (days === 1) return 'due tomorrow'
  return `due in ${plural(days, 'day')}`
}

/**
 * The scheduling shape's status line. Deliberately about the booking window
 * closing — never about following through, which is the question a rhythm
 * does not ask.
 */
export function periodLabel(periodEnd: string, now: Date = new Date()): string {
  // periodEnd is a calendar DATE, not an instant, so it is read as local midnight.
  const days = dayDiff(new Date(`${periodEnd}T00:00:00`), now)
  if (days < 0) return 'this period has ended'
  if (days === 0) return 'this period ends today'
  return `${plural(days, 'day')} left to book it`
}

// ── Hooks ───────────────────────────────────────────────────────────────────────

export function useRhythms() {
  const [rhythms, setRhythms] = useState<Rhythm[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  const refetch = useCallback(() => setNonce((n) => n + 1), [])
  useRefetchOn(['rhythms'], refetch)
  useEffect(() => {
    let alive = true
    rhythmsApi.list()
      .then((d) => { if (alive) { setRhythms(d.rhythms ?? []); setError(false); setLoading(false) } })
      .catch(() => { if (alive) { setError(true); setLoading(false) } })
    return () => { alive = false }
  }, [nonce])
  return { rhythms, loading, error, refetch }
}

/**
 * What needs attention today. The window is deliberately one day on every surface:
 * `to` doubles as the date that decides WHICH period a scheduling rhythm reports
 * on, so a wider window would answer about a later period.
 */
export function useRhythmAttention() {
  const [items, setItems] = useState<AttentionItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [nonce, setNonce] = useState(0)
  const refetch = useCallback(() => setNonce((n) => n + 1), [])
  useRefetchOn(['rhythms'], refetch)
  useEffect(() => {
    let alive = true
    const today = localToday()
    rhythmsApi.attention(today, today)
      .then((d) => { if (alive) { setItems(d.items ?? []); setError(false); setLoading(false) } })
      .catch(() => { if (alive) { setError(true); setLoading(false) } })
    return () => { alive = false }
  }, [nonce])
  return { items, loading, error, refetch }
}
