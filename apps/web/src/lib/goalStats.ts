// Shared derived-stats layer for the goal-detail data views (Week/Month/Pace/Year/
// By-person/Year-ring/Collection/Consistency). Reads the goal + its day-bucketed log
// (GoalActivity, see lib/api/goals.ts) and computes everything the views need ONCE,
// memoized by the caller (useMemo in GoalDetail). Pure functions only — no fetching.
//
// Every day is keyed by a normalized LOCAL date string 'YYYY-MM-DD', never a
// millisecond timestamp: building dates by adding 86400000ms drifts off local
// midnight across DST, so `Date.getTime()` lookups can silently miss (this bit the
// prototype's Month view). All date math here manipulates calendar fields
// (year/month/day) via the local `Date` constructor and lets it normalize
// month/year rollover — never raw epoch-ms arithmetic.

export interface DayEntry {
  dateKey: string
  total: number
  perMember: Record<string, number>
}

// ---------------------------------------------------------------------------
// Local-date key helpers
// ---------------------------------------------------------------------------

export function toLocalDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function parseLocalDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

// Adds n calendar days (n may be negative) by nudging the Date's day field and
// letting the Date constructor normalize month/year rollover — never `+n*86400000`,
// which drifts across a DST transition.
export function addDaysKey(key: string, n: number): string {
  const d = parseLocalDateKey(key)
  d.setDate(d.getDate() + n)
  return toLocalDateKey(d)
}

// Whole calendar days between two keys (a - b). Safe across DST because both sides
// are constructed via the local Date constructor at local midnight, which the JS
// engine keeps aligned to the wall-clock day regardless of any DST shift between them.
export function diffDaysKey(a: string, b: string): number {
  const da = parseLocalDateKey(a)
  const db = parseLocalDateKey(b)
  return Math.round((da.getTime() - db.getTime()) / 86400000)
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

// ---------------------------------------------------------------------------
// Heat ramp — pale rgb(233,245,236) -> deep rgb(18,99,61). t=0 (no activity) should
// use --panel instead of heat(0) at the call site; heat() itself is the >0 ramp.
// ---------------------------------------------------------------------------

const HEAT_LO = [233, 245, 236]
const HEAT_HI = [18, 99, 61]

export function heat(t: number): string {
  const c = clamp(t, 0, 1)
  const [r, g, b] = HEAT_LO.map((lo, i) => Math.round(lo + (HEAT_HI[i] - lo) * c))
  return `rgb(${r},${g},${b})`
}

// Above this normalized intensity, cell text/dots should flip to white for legibility.
export const HEAT_DARK_THRESHOLD = 0.55

// ---------------------------------------------------------------------------
// Timeframe classification + goal-type -> view mapping
// ---------------------------------------------------------------------------

export type Timeframe = 'short' | 'long' | 'open-ended'
export type ViewKey = 'week' | 'month' | 'pace' | 'year' | 'byPerson' | 'yearRing' | 'collection' | 'consistency'

const SHORT_WINDOW_DAYS = 31 // "< ~1 month" per the design doc — never hard-code 365 elsewhere

export function classifyTimeframe(startDate: string, endDate: string | null): Timeframe {
  if (endDate == null) return 'open-ended'
  const totalDuration = diffDaysKey(endDate, startDate)
  return totalDuration < SHORT_WINDOW_DAYS ? 'short' : 'long'
}

// The full offer list per type, ordered signature-first (per the handoff's mapping
// table). Timeframe filtering is applied afterward by availableViews.
const TYPE_VIEWS: Record<string, ViewKey[]> = {
  total: ['week', 'month', 'year', 'pace', 'yearRing', 'byPerson'],
  count: ['month', 'pace', 'collection'],
  habit: ['consistency', 'week'],
  checklist: [],
}

const SIGNATURE_VIEW: Record<string, ViewKey | null> = {
  total: 'pace',
  count: 'collection',
  habit: 'consistency',
  checklist: null,
}

// Views tied to "the current month" or "the year so far" — meaningless (or too
// sparse) for a fixed goal whose whole window is under ~1 month.
const DROPS_FOR_SHORT_WINDOW = new Set<ViewKey>(['year', 'month', 'yearRing', 'consistency'])

export function availableViews(goalType: string, timeframe: Timeframe): ViewKey[] {
  const base = TYPE_VIEWS[goalType] ?? []
  if (timeframe !== 'short') return base
  return base.filter((v) => !DROPS_FOR_SHORT_WINDOW.has(v))
}

// Default to the goal type's signature view when it still fits this timeframe;
// otherwise fall back to the largest timeframe-appropriate view that does.
const FALLBACK_ORDER: ViewKey[] = ['year', 'month', 'consistency', 'pace', 'byPerson', 'collection', 'week', 'yearRing']

export function defaultView(goalType: string, timeframe: Timeframe): ViewKey | null {
  const offered = availableViews(goalType, timeframe)
  if (offered.length === 0) return null
  const signature = SIGNATURE_VIEW[goalType] ?? null
  if (signature && offered.includes(signature)) return signature
  for (const v of FALLBACK_ORDER) if (offered.includes(v)) return v
  return offered[0]
}

// ---------------------------------------------------------------------------
// computeGoalStats — the memoized derivation
// ---------------------------------------------------------------------------

export interface PaceStats {
  paceValue: number
  delta: number
  endLabel: string // the goal's end date (YYYY-MM-DD)
}

export interface GoalStats {
  today: string
  startDate: string
  endDate: string | null
  byDay: Map<string, DayEntry>
  dayEntry: (dateKey: string) => DayEntry // zero-filled — never undefined, never an "empty" render
  byMonth: number[] // 12 entries (index 0 = Jan) for `today`'s calendar year
  byMonthPerMember: Record<string, number>[] // 12 entries, each {personId: amount} for that month
  byPerson: Record<string, number> // lifetime total per person, across the whole log
  total: number
  currentStreak: number
  longestStreak: number
  activeDays: number
  bestDay: { dateKey: string; total: number } | null
  weekMax: number // max day total among the last 7 days ending today
  monthMax: number // max day total within today's calendar month
  yearMax: number // max day total within today's calendar year to date
  pace: PaceStats | null // null for an open-ended goal or a goal with no target
  projectedFinish: string | null // date key, or null if the rolling rate is ~0
}

const ZERO_DAY = (dateKey: string): DayEntry => ({ dateKey, total: 0, perMember: {} })

export function computeGoalStats(params: {
  today: string
  startDate: string
  endDate: string | null
  target: number | null
  days: DayEntry[]
}): GoalStats {
  const { today, startDate, endDate, target, days } = params
  const byDay = new Map<string, DayEntry>()
  for (const d of days) byDay.set(d.dateKey, d)
  const dayEntry = (dateKey: string): DayEntry => byDay.get(dateKey) ?? ZERO_DAY(dateKey)

  let total = 0
  const byPerson: Record<string, number> = {}
  let bestDay: { dateKey: string; total: number } | null = null
  for (const d of days) {
    total += d.total
    if (!bestDay || d.total > bestDay.total) bestDay = { dateKey: d.dateKey, total: d.total }
    for (const [person, amount] of Object.entries(d.perMember)) {
      byPerson[person] = (byPerson[person] ?? 0) + amount
    }
  }

  // Active-day set for streak math — a day counts as "active" if it has any logged
  // total (habit's daily total is 1/0, so this doubles as the hit/miss set).
  const activeDates = new Set(days.filter((d) => d.total > 0).map((d) => d.dateKey))
  const activeDays = activeDates.size

  // currentStreak: consecutive active days ending today, matching the server's
  // goalStreak rule exactly — only counts if the latest active day is today or
  // yesterday (both bucketed by the same household-timezone expression server-side).
  let currentStreak = 0
  {
    const sorted = [...activeDates].sort().reverse()
    if (sorted.length > 0 && diffDaysKey(today, sorted[0]) <= 1) {
      let cursor = sorted[0]
      for (const dateKey of sorted) {
        if (dateKey === cursor) {
          currentStreak++
          cursor = addDaysKey(cursor, -1)
        } else break
      }
    }
  }

  // longestStreak: longest run of consecutive active days anywhere in the log.
  let longestStreak = 0
  {
    const sorted = [...activeDates].sort()
    let run = 0
    let prev: string | null = null
    for (const dateKey of sorted) {
      run = prev != null && addDaysKey(prev, 1) === dateKey ? run + 1 : 1
      longestStreak = Math.max(longestStreak, run)
      prev = dateKey
    }
  }

  const last7 = new Set(Array.from({ length: 7 }, (_, i) => addDaysKey(today, -i)))
  const weekMax = Math.max(0, ...days.filter((d) => last7.has(d.dateKey)).map((d) => d.total))

  const todayDate = parseLocalDateKey(today)
  const monthMax = Math.max(
    0,
    ...days.filter((d) => {
      const dt = parseLocalDateKey(d.dateKey)
      return dt.getFullYear() === todayDate.getFullYear() && dt.getMonth() === todayDate.getMonth()
    }).map((d) => d.total)
  )
  const yearMax = Math.max(
    0,
    ...days.filter((d) => parseLocalDateKey(d.dateKey).getFullYear() === todayDate.getFullYear()).map((d) => d.total)
  )

  const byMonth = Array.from({ length: 12 }, (_, m) =>
    days
      .filter((d) => {
        const dt = parseLocalDateKey(d.dateKey)
        return dt.getFullYear() === todayDate.getFullYear() && dt.getMonth() === m
      })
      .reduce((s, d) => s + d.total, 0)
  )
  const byMonthPerMember: Record<string, number>[] = Array.from({ length: 12 }, () => ({}))
  for (const d of days) {
    const dt = parseLocalDateKey(d.dateKey)
    if (dt.getFullYear() !== todayDate.getFullYear()) continue
    const bucket = byMonthPerMember[dt.getMonth()]
    for (const [person, amount] of Object.entries(d.perMember)) {
      bucket[person] = (bucket[person] ?? 0) + amount
    }
  }

  // Pace: target * elapsed/totalDuration, derived from the goal's OWN start/end —
  // never a hard-coded 365. Undefined for an open-ended goal (no deadline to pace
  // against) or a goal with no numeric target.
  let pace: PaceStats | null = null
  if (endDate != null && target != null) {
    const totalDuration = Math.max(1, diffDaysKey(endDate, startDate))
    const elapsed = clamp(diffDaysKey(today, startDate), 0, totalDuration)
    const paceValue = Math.round((target * elapsed) / totalDuration)
    pace = { paceValue, delta: Math.round((total - paceValue) * 100) / 100, endLabel: endDate }
  }

  // projectedFinish: extend the trailing-14-day rolling rate from today. Null when
  // the rate is ~0 (nothing recent to extrapolate from) or the target's already met.
  let projectedFinish: string | null = null
  if (target != null) {
    const remaining = target - total
    if (remaining <= 0) {
      projectedFinish = today
    } else {
      const windowStart = addDaysKey(today, -13)
      const recent = days.filter((d) => d.dateKey >= windowStart && d.dateKey <= today).reduce((s, d) => s + d.total, 0)
      const spanDays = Math.max(1, Math.min(14, diffDaysKey(today, startDate) + 1))
      const rate = recent / spanDays
      if (rate > 0.001) projectedFinish = addDaysKey(today, Math.ceil(remaining / rate))
    }
  }

  return {
    today,
    startDate,
    endDate,
    byDay,
    dayEntry,
    byMonth,
    byMonthPerMember,
    byPerson,
    total: Math.round(total * 100) / 100,
    currentStreak,
    longestStreak,
    activeDays,
    bestDay,
    weekMax,
    monthMax,
    yearMax,
    pace,
    projectedFinish,
  }
}
