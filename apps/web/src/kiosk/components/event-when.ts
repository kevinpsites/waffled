// The event editor's When card (EventWhenField), mirroring iOS `EventEnd`. Days are local
// YYYY-MM-DD and times HH:MM, as the form holds them. An all-day end is EXCLUSIVE — noon the day
// after the last day, so a zone gap can't pull it onto a neighbouring day — and a timed event
// keeps its length in minutes, so moving the start keeps the length.
import { MONTHS_SHORT, ymd } from './cal-utils'

const pad = (n: number) => String(n).padStart(2, '0')

function at(day: string, time: string): Date {
  return new Date(`${day}T${time}`)
}

export function addDaysKey(day: string, n: number): string {
  const d = at(day, '12:00')
  d.setDate(d.getDate() + n)
  return ymd(d)
}

// "Sep 14, 2026" — the iPhone editor's pill.
export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return `${MONTHS_SHORT[m - 1]} ${d}, ${y}`
}

// "5:00 PM".
export function timeLabel(time: string): string {
  const [h, m] = time.split(':').map(Number)
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`
}

export function allDayExclusiveEnd(lastDay: string): string {
  return at(addDaysKey(lastDay, 1), '12:00').toISOString()
}

// The last day an all-day event covers. No end, or one on or before the next day, is one day.
export function allDayLastDay(startsAt: string, endsAt: string | null): string {
  const first = ymd(new Date(startsAt))
  if (!endsAt) return first
  const endDay = ymd(new Date(endsAt))
  return endDay > first ? addDaysKey(endDay, -1) : first
}

export function endOf(day: string, time: string, minutes: number): { day: string; time: string } {
  const end = new Date(at(day, time).getTime() + minutes * 60000)
  return { day: ymd(end), time: `${pad(end.getHours())}:${pad(end.getMinutes())}` }
}

export function minutesUntil(day: string, time: string, endDay: string, endTime: string): number {
  return Math.max(15, Math.round((at(endDay, endTime).getTime() - at(day, time).getTime()) / 60000))
}

// Moving an all-day event's first day carries its last day with it.
export function keepSpan(oldDay: string, newDay: string, lastDay: string): string {
  const span = Math.round((at(lastDay, '12:00').getTime() - at(oldDay, '12:00').getTime()) / 86400000)
  return addDaysKey(newDay, Math.max(0, span))
}

export function timeSlots(): string[] {
  return Array.from({ length: 96 }, (_, i) => `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`)
}
