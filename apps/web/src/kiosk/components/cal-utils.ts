// Shared date/time helpers for the calendar views (month / week / agenda / detail).
// Day bucketing uses the household timezone (via localDate) so evening events land
// on the right day on an out-of-zone kiosk; clock positioning uses the device
// clock (new Date().getHours()), matching the rest of the app's assumption that
// the kiosk runs in the household's zone.
import type { AgendaEvent } from '../../lib/api'
export { localDate } from '../../lib/powersync/events-local'

export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const DOW_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Local YYYY-MM-DD for a Date (device zone) — for grid keys and "today".
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(d.getDate() + n)
  return r
}

// The Sunday that starts the week containing d.
export function startOfWeek(d: Date): Date {
  return addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -d.getDay())
}

// "4:00 PM" / "4:30 PM"; "all day" for all-day events.
export function fmtTime(e: AgendaEvent): string {
  if (e.allDay) return 'all day'
  const d = new Date(e.startsAt)
  const h = d.getHours()
  const m = d.getMinutes()
  const ap = h < 12 ? 'AM' : 'PM'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ap}`
}

// "7 AM", "12 PM" — the week-view hour rail.
export function fmtHour(h: number): string {
  if (h === 0) return '12 AM'
  if (h === 12) return '12 PM'
  return h < 12 ? `${h} AM` : `${h - 12} PM`
}

// Minutes from midnight (device clock) — week-view vertical positioning.
export function minutesOfDay(iso: string): number {
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}

// Event duration in minutes (defaults to 60 when there's no end).
export function durationMin(e: AgendaEvent): number {
  if (!e.endsAt) return 60
  const ms = new Date(e.endsAt).getTime() - new Date(e.startsAt).getTime()
  return Math.max(15, Math.round(ms / 60000))
}

// The participant set for avatars; falls back to the single owner for old events.
export function eventPeople(e: AgendaEvent) {
  if (e.participants?.length) return e.participants
  if (e.personEmoji || e.personName)
    return [{ id: '_', name: e.personName ?? '', colorHex: e.personColor, avatarEmoji: e.personEmoji }]
  return []
}
