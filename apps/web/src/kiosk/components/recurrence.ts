// Pure helpers for the event modal's "Repeats" picker: turn the picker state into
// an RFC5545 RRULE string, and parse an existing rule back into picker state for
// editing. Kept separate so they're unit-tested without rendering the modal.

export type RepeatFreq = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom'

export interface RepeatState {
  freq: RepeatFreq
  byday: string[] // for 'weekly': ['MO','WE'] etc.
  custom: string // for 'custom': a raw RRULE the user typed
}

export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const
const WEEKDAY_SET = 'MO,TU,WE,TH,FR'

export const NO_REPEAT: RepeatState = { freq: 'none', byday: [], custom: '' }

// The RRULE weekday code for a given Date (its local weekday).
export function weekdayCode(d: Date): string {
  return WEEKDAYS[d.getDay()]
}

// Build the RRULE string for the picker state. `weekday` is the event's own weekday
// code, used as the default day when 'weekly' has nothing selected. Returns null for
// 'none' (or an empty custom rule) — i.e. a non-recurring event.
export function buildRrule(r: RepeatState, weekday: string): string | null {
  switch (r.freq) {
    case 'none':
      return null
    case 'daily':
      return 'FREQ=DAILY'
    case 'weekdays':
      return `FREQ=WEEKLY;BYDAY=${WEEKDAY_SET}`
    case 'weekly': {
      const days = r.byday.length ? r.byday : [weekday]
      return `FREQ=WEEKLY;BYDAY=${days.join(',')}`
    }
    case 'monthly':
      // No BYMONTHDAY → rrule repeats on the start date's day-of-month.
      return 'FREQ=MONTHLY'
    case 'custom': {
      const c = r.custom.trim().replace(/^RRULE:/i, '')
      return c || null
    }
  }
}

// Parse an existing RRULE back into picker state (best-effort). Anything the simple
// picker can't represent (INTERVAL, COUNT, nth-weekday, …) falls back to 'custom'
// so the rule is preserved and editable verbatim.
export function parseRepeat(rrule: string | null | undefined): RepeatState {
  if (!rrule) return { ...NO_REPEAT }
  const raw = rrule.replace(/^RRULE:/i, '').trim()
  const parts: Record<string, string> = {}
  for (const seg of raw.toUpperCase().split(';')) {
    const [k, v] = seg.split('=')
    if (k && v) parts[k] = v
  }
  const freq = parts.FREQ
  const byday = parts.BYDAY ? parts.BYDAY.split(',') : []
  const simpleEnd = !parts.COUNT && !parts.UNTIL && !parts.INTERVAL
  if (freq === 'DAILY' && !parts.BYDAY && simpleEnd) return { freq: 'daily', byday: [], custom: '' }
  if (freq === 'WEEKLY' && simpleEnd) {
    if (byday.join(',') === WEEKDAY_SET) return { freq: 'weekdays', byday: [], custom: '' }
    if (byday.length && byday.every((d) => (WEEKDAYS as readonly string[]).includes(d))) {
      return { freq: 'weekly', byday, custom: '' }
    }
  }
  if (freq === 'MONTHLY' && !parts.BYDAY && !parts.BYMONTHDAY && simpleEnd) {
    return { freq: 'monthly', byday: [], custom: '' }
  }
  return { freq: 'custom', byday: [], custom: raw }
}
