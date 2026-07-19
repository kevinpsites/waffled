// Shared timezone / wall-clock helpers for the capture pipeline. A LEAF module — it
// imports nothing from feature modules or the capture dispatcher, so both the dispatcher
// (capture.ts) and individual targets (events-capture.ts) share one DST-correct
// implementation instead of copy-pasting it. The copies had already diverged (PR #83
// review): `tzOffsetMs`'s hour-24 quirk was hand-duplicated byte-for-byte, and
// `whenLabel` showed "· All day" in create previews but a bare day in the mutate picker.
// All of it is `Intl`-based — no timezone library.

export interface Wall {
  y: number
  mo: number
  d: number
  h: number
  mi: number
}

// The tz's offset (ms) from UTC at a given instant.
export function tzOffsetMs(at: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const m: Record<string, string> = {}
  for (const p of dtf.formatToParts(at)) m[p.type] = p.value
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +(m.hour === '24' ? '0' : m.hour), +m.minute, +m.second)
  return asUTC - at.getTime()
}

// The wall-clock (household-local) components of an instant.
export function wallParts(at: Date, tz: string): Wall {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const m: Record<string, string> = {}
  for (const p of dtf.formatToParts(at)) m[p.type] = p.value
  return { y: +m.year, mo: +m.month, d: +m.day, h: +(m.hour === '24' ? '0' : m.hour), mi: +m.minute }
}

// Wall-clock components in a tz → the UTC instant (offset re-checked at the guess, so
// DST transitions land on the right side).
export function wallToUtc(w: Wall, tz: string): Date {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, 0)
  const off = tzOffsetMs(new Date(guess), tz)
  return new Date(guess - off)
}

// The local calendar date (YYYY-MM-DD) of an instant in a tz.
export function localYmd(at: Date, tz: string): string {
  const m: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at)) m[p.type] = p.value
  return `${m.year}-${m.month}-${m.day}`
}

// Normalize a model datetime to a UTC ISO string. A naive local value (no zone suffix)
// is interpreted in the household timezone; an explicit offset/Z is kept.
export function zonedToUtc(value: string, tz: string): string {
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(value.trim())
  if (hasZone) return new Date(value).toISOString()
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value.trim())
  if (!m) return new Date(value).toISOString() // let Date try; finalize validates
  const [, y, mo, d, h, mi, s] = m
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0))
  const off = tzOffsetMs(new Date(guess), tz)
  return new Date(guess - off).toISOString()
}

// "Fri Jul 18 · 7:00 PM" (all-day events show "Fri Jul 18 · All day").
export function whenLabel(at: Date, allDay: boolean, tz: string): string {
  const day = at.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz })
  if (allDay) return `${day} · All day`
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
  return `${day} · ${time}`
}
