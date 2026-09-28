// Multi-day all-day events in the month grid: which days an event covers, and each week row's
// bars. Mirrors iOS `Agenda.dayKeys` and `PhoneCalendar.weekSpans`. All-day ends are EXCLUSIVE
// (the day after the last day), the shape Google sends; timed events stay on their start day.
import type { AgendaEvent } from '../../lib/api'
import { localDate } from './cal-utils'

// A corrupt end can't spread an event across more than a year.
export const MAX_SPAN_DAYS = 366
export const MAX_SPAN_LANES = 2

function nextKey(key: string): string {
  const d = new Date(`${key}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

// Null for anything that stays on one day. Day keys are YYYY-MM-DD, so string order is date order.
function exclusiveEndKey(e: AgendaEvent, tz: string): string | null {
  if (!e.allDay || !e.endsAt) return null
  const end = localDate(e.endsAt, tz)
  return end > localDate(e.startsAt, tz) ? end : null
}

export function eventCoversDay(e: AgendaEvent, day: string, tz: string): boolean {
  const start = localDate(e.startsAt, tz)
  const end = exclusiveEndKey(e, tz)
  return end ? start <= day && day < end : start === day
}

export function eventDayKeys(e: AgendaEvent, tz: string): string[] {
  const start = localDate(e.startsAt, tz)
  const end = exclusiveEndKey(e, tz)
  const keys = [start]
  if (!end) return keys
  for (let key = nextKey(start); key < end && keys.length < MAX_SPAN_DAYS; key = nextKey(key)) keys.push(key)
  return keys
}

export function eventsByDay(events: AgendaEvent[], tz: string): Record<string, AgendaEvent[]> {
  const map: Record<string, AgendaEvent[]> = {}
  for (const e of events) for (const key of eventDayKeys(e, tz)) (map[key] ??= []).push(e)
  return map
}

export interface SpanBar {
  event: AgendaEvent
  startCol: number
  endCol: number
  lane: number
  // The event started before this row / runs on past it, so that end is square.
  continuesBefore: boolean
  continuesAfter: boolean
}

export interface WeekSpans {
  bars: SpanBar[]
  lanes: number
  // Each day's events that still draw as chips: everything the bars didn't take.
  chipsByDay: Record<string, AgendaEvent[]>
}

// One row's bars, like Google's month view: earliest start first, longer first on a tie, each in
// the first lane free by its start. Past `maxLanes` an event stays a chip in each of its days.
export function weekSpans(
  days: string[],
  byDay: Record<string, AgendaEvent[]>,
  tz: string,
  maxLanes: number = MAX_SPAN_LANES,
): WeekSpans {
  const first = days[0]
  const last = days[days.length - 1]
  if (!first || !last) return { bars: [], lanes: 0, chipsByDay: {} }
  const afterRow = nextKey(last)
  const seen = new Set<string>()
  const candidates: { event: AgendaEvent; start: number; end: number; before: boolean; after: boolean }[] = []
  days.forEach((key, col) => {
    for (const e of byDay[key] ?? []) {
      if (!e.allDay || seen.has(e.id)) continue
      const endExclusive = exclusiveEndKey(e, tz)
      if (!endExclusive) continue
      seen.add(e.id)
      let end = col
      days.forEach((d, i) => { if (d < endExclusive) end = Math.max(end, i) })
      const before = localDate(e.startsAt, tz) < first
      const after = endExclusive > afterRow
      // A one-day all-day event has an exclusive end too; it only spans if it leaves this cell.
      if (!before && !after && end === col) continue
      candidates.push({ event: e, start: col, end, before, after })
    }
  })
  candidates.sort((a, b) => a.start - b.start || b.end - a.end || a.event.id.localeCompare(b.event.id))
  const laneEnds: number[] = []
  const bars: SpanBar[] = []
  for (const c of candidates) {
    let lane = laneEnds.findIndex((end) => end < c.start)
    if (lane === -1) lane = laneEnds.length
    if (lane >= maxLanes) continue
    laneEnds[lane] = c.end
    bars.push({ event: c.event, startCol: c.start, endCol: c.end, lane, continuesBefore: c.before, continuesAfter: c.after })
  }
  const barIds = new Set(bars.map((b) => b.event.id))
  const chipsByDay: Record<string, AgendaEvent[]> = {}
  for (const key of days) chipsByDay[key] = (byDay[key] ?? []).filter((e) => !barIds.has(e.id))
  return { bars, lanes: laneEnds.length, chipsByDay }
}
