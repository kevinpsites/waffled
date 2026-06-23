// Pure helpers for the event modal's "Repeats" picker: turn the picker state into
// an RFC5545 RRULE string, parse an existing rule back into picker state, and
// describe a rule in plain English. Kept separate so they're unit-tested without
// rendering the modal.
//
// "Custom…" is a friendly builder ("repeat every N days/weeks/months/years", with
// weekday chips for weekly and a day-of-month / nth-weekday choice for monthly) —
// no one has to type an RRULE. A raw RRULE is still kept as an advanced escape
// hatch (and to preserve any imported rule the builder can't represent).

export type RepeatFreq = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom'
export type CustomUnit = 'day' | 'week' | 'month' | 'year'
export type MonthlyMode = 'day' | 'weekday' // by day-of-month vs the Nth weekday

export interface RepeatState {
  freq: RepeatFreq
  byday: string[] // weekly + custom-weekly days, e.g. ['MO','WE']
  interval: number // custom: "every N" (>= 1)
  unit: CustomUnit // custom: the unit N counts
  monthlyMode: MonthlyMode // custom monthly: day-of-month vs nth weekday
  custom: string // advanced raw RRULE — overrides the builder when set
}

export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const
const WEEKDAY_SET = 'MO,TU,WE,TH,FR'
const PLAIN_DAY = new Set<string>(WEEKDAYS)
const DAY_NAME: Record<string, string> = { SU: 'Sun', MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat' }
const FULL_DAY: Record<string, string> = { SU: 'Sunday', MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday' }
const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth']

export const NO_REPEAT: RepeatState = { freq: 'none', byday: [], interval: 1, unit: 'week', monthlyMode: 'day', custom: '' }

// The RRULE weekday code for a given Date (its local weekday).
export function weekdayCode(d: Date): string {
  return WEEKDAYS[d.getDay()]
}

// Which occurrence of its weekday a date is within its month (1 = first, …).
export function nthWeekdayOfMonth(d: Date): number {
  return Math.floor((d.getDate() - 1) / 7) + 1
}

// Build the RRULE string for the picker state. `start` is the event's start date,
// used for the default weekly day and the monthly nth-weekday ordinal. Returns
// null for 'none' (or an empty custom rule) — i.e. a non-recurring event.
export function buildRrule(r: RepeatState, start: Date): string | null {
  const weekday = weekdayCode(start)
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
      const raw = r.custom.trim().replace(/^RRULE:/i, '')
      if (raw) return raw // advanced override
      const n = Math.max(1, Math.round(r.interval || 1))
      const iv = n > 1 ? `;INTERVAL=${n}` : ''
      switch (r.unit) {
        case 'day':
          return `FREQ=DAILY${iv}`
        case 'week': {
          const days = r.byday.length ? r.byday : [weekday]
          return `FREQ=WEEKLY${iv};BYDAY=${days.join(',')}`
        }
        case 'month':
          return r.monthlyMode === 'weekday'
            ? `FREQ=MONTHLY${iv};BYDAY=${nthWeekdayOfMonth(start)}${weekday}`
            : `FREQ=MONTHLY${iv}`
        case 'year':
          return `FREQ=YEARLY${iv}`
      }
    }
  }
}

function ruleParts(raw: string): Record<string, string> {
  const parts: Record<string, string> = {}
  for (const seg of raw.toUpperCase().split(';')) {
    const [k, v] = seg.split('=')
    if (k && v) parts[k] = v
  }
  return parts
}

// Parse an existing RRULE back into picker state (best-effort). Common interval /
// yearly / monthly-nth-weekday rules map onto the friendly custom builder; anything
// it still can't represent (COUNT, UNTIL, multi-clause BY…) is preserved verbatim
// as an advanced custom rule so it stays editable and round-trips.
export function parseRepeat(rrule: string | null | undefined): RepeatState {
  if (!rrule) return { ...NO_REPEAT }
  const raw = rrule.replace(/^RRULE:/i, '').trim()
  const parts = ruleParts(raw)
  const freq = parts.FREQ
  const byday = parts.BYDAY ? parts.BYDAY.split(',') : []
  const plainByday = byday.filter((d) => PLAIN_DAY.has(d))
  const interval = parts.INTERVAL ? Math.max(1, parseInt(parts.INTERVAL, 10) || 1) : 1
  const bounded = !!parts.COUNT || !!parts.UNTIL

  // Simple presets — interval 1, no COUNT/UNTIL.
  if (!bounded && interval === 1) {
    if (freq === 'DAILY' && !parts.BYDAY) return { ...NO_REPEAT, freq: 'daily' }
    if (freq === 'WEEKLY') {
      if (byday.join(',') === WEEKDAY_SET) return { ...NO_REPEAT, freq: 'weekdays' }
      if (byday.length && byday.every((d) => PLAIN_DAY.has(d))) return { ...NO_REPEAT, freq: 'weekly', byday }
    }
    if (freq === 'MONTHLY' && !parts.BYDAY && !parts.BYMONTHDAY) return { ...NO_REPEAT, freq: 'monthly' }
  }

  // Friendly custom builder — interval > 1, yearly, or monthly-by-weekday; still no
  // COUNT/UNTIL (those need the advanced rule).
  if (!bounded) {
    if (freq === 'DAILY' && !parts.BYDAY) return { ...NO_REPEAT, freq: 'custom', unit: 'day', interval }
    if (freq === 'WEEKLY' && (!parts.BYDAY || plainByday.length === byday.length)) {
      return { ...NO_REPEAT, freq: 'custom', unit: 'week', interval, byday: plainByday }
    }
    if (freq === 'MONTHLY' && !parts.BYDAY && !parts.BYMONTHDAY) {
      return { ...NO_REPEAT, freq: 'custom', unit: 'month', interval, monthlyMode: 'day' }
    }
    if (freq === 'MONTHLY' && /^-?\d+[A-Z]{2}$/.test(parts.BYDAY ?? '')) {
      return { ...NO_REPEAT, freq: 'custom', unit: 'month', interval, monthlyMode: 'weekday' }
    }
    if (freq === 'YEARLY') return { ...NO_REPEAT, freq: 'custom', unit: 'year', interval }
  }

  // Anything else → preserve the raw rule in the advanced field.
  return { ...NO_REPEAT, freq: 'custom', custom: raw }
}

function dayList(codes: string[]): string {
  return codes.map((c) => DAY_NAME[c] ?? c).join(', ')
}

// Plain-English description of a rule (for the picker's live summary). `start` gives
// the monthly nth-weekday phrasing a weekday name. Falls back to the raw rule for
// shapes it doesn't recognise, so the summary is never empty for a real rule.
export function describeRrule(rule: string | null, start: Date): string {
  if (!rule) return 'Does not repeat'
  const parts = ruleParts(rule.replace(/^RRULE:/i, '').trim())
  const freq = parts.FREQ
  const n = parts.INTERVAL ? Math.max(1, parseInt(parts.INTERVAL, 10) || 1) : 1
  const byday = parts.BYDAY ? parts.BYDAY.split(',') : []
  const every = (unit: string) => (n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`)
  let base: string | null = null

  if (freq === 'DAILY' && !parts.BYDAY) base = every('day')
  else if (freq === 'WEEKLY') {
    if (byday.join(',') === WEEKDAY_SET) base = n === 1 ? 'Every weekday (Mon–Fri)' : `Every ${n} weeks on Mon–Fri`
    else if (byday.length && byday.every((d) => PLAIN_DAY.has(d))) base = `${every('week')} on ${dayList(byday)}`
    else if (!parts.BYDAY) base = `${every('week')} on ${DAY_NAME[weekdayCode(start)]}`
  } else if (freq === 'MONTHLY') {
    const m = /^(-?\d+)([A-Z]{2})$/.exec(parts.BYDAY ?? '')
    if (m) {
      const ord = Number(m[1]) === -1 ? 'last' : ORDINALS[Number(m[1])] ?? `${m[1]}th`
      base = `${every('month')} on the ${ord} ${FULL_DAY[m[2]]}`
    } else if (!parts.BYMONTHDAY) base = every('month')
  } else if (freq === 'YEARLY') base = every('year')

  if (!base) return rule // unrecognised — show the raw rule rather than nothing
  if (parts.COUNT) base += `, ${parts.COUNT} times`
  return base
}
