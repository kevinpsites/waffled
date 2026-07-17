import { describe, it, expect } from 'vitest'
import {
  toLocalDateKey,
  parseLocalDateKey,
  addDaysKey,
  diffDaysKey,
  classifyTimeframe,
  availableViews,
  defaultView,
  computeGoalStats,
  heat,
  type DayEntry,
} from './goalStats'

describe('local-date key helpers (no timestamp-drift gotcha)', () => {
  it('round-trips a date through toLocalDateKey/parseLocalDateKey', () => {
    const d = new Date(2026, 6, 17) // Jul 17 2026, local
    expect(toLocalDateKey(d)).toBe('2026-07-17')
    const back = parseLocalDateKey('2026-07-17')
    expect(back.getFullYear()).toBe(2026)
    expect(back.getMonth()).toBe(6)
    expect(back.getDate()).toBe(17)
  })

  it('addDaysKey rolls over a month/year boundary correctly', () => {
    expect(addDaysKey('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDaysKey('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysKey('2026-03-01', -1)).toBe('2026-02-28') // 2026 not a leap year
    expect(addDaysKey('2024-03-01', -1)).toBe('2024-02-29') // 2024 IS a leap year
  })

  it('addDaysKey crosses a spring-forward DST boundary by calendar day, not by 24h', () => {
    // US DST 2026 spring-forward is Mar 8. Adding 1 calendar day must land on Mar 9
    // exactly — a naive `+86400000ms` implementation would drift onto Mar 8 again
    // or skip depending on local offset. This is the exact bug the design doc warns about.
    expect(addDaysKey('2026-03-08', 1)).toBe('2026-03-09')
  })

  it('diffDaysKey counts whole days between two keys', () => {
    expect(diffDaysKey('2026-01-10', '2026-01-01')).toBe(9)
    expect(diffDaysKey('2026-01-01', '2026-01-10')).toBe(-9)
    expect(diffDaysKey('2026-01-01', '2026-01-01')).toBe(0)
  })
})

describe('heat(t) ramp', () => {
  it('t=0 stays at the pale end, t=1 at the deep end', () => {
    expect(heat(0)).toBe('rgb(233,245,236)')
    expect(heat(1)).toBe('rgb(18,99,61)')
  })
  it('clamps outside [0,1]', () => {
    expect(heat(-5)).toBe(heat(0))
    expect(heat(5)).toBe(heat(1))
  })
})

describe('classifyTimeframe', () => {
  it('open-ended when there is no end date', () => {
    expect(classifyTimeframe('2026-01-01', null)).toBe('open-ended')
  })
  it('short when the window is under ~1 month, regardless of goal length elsewhere', () => {
    expect(classifyTimeframe('2026-07-01', '2026-07-14')).toBe('short') // 2-week goal
  })
  it('long for a full calendar year (never hard-codes 365)', () => {
    expect(classifyTimeframe('2026-01-01', '2026-12-31')).toBe('long')
  })
  it('long for a multi-year goal', () => {
    expect(classifyTimeframe('2026-01-01', '2028-01-01')).toBe('long')
  })
})

describe('goal-type -> view mapping', () => {
  it('total: signature is Pace; year/month/yearRing drop for a short window', () => {
    expect(defaultView('total', 'long')).toBe('pace')
    expect(availableViews('total', 'long')).toEqual(['week', 'month', 'year', 'pace', 'yearRing', 'byPerson'])
    expect(availableViews('total', 'short')).toEqual(['week', 'pace', 'byPerson'])
    expect(defaultView('total', 'short')).toBe('pace') // still fits
  })

  it('count: signature is the Collection grid', () => {
    expect(defaultView('count', 'long')).toBe('collection')
    expect(availableViews('count', 'long')).toEqual(['month', 'pace', 'collection'])
    expect(availableViews('count', 'short')).toEqual(['pace', 'collection']) // month drops
  })

  it('habit: signature is the Consistency dot-calendar; falls back to Week when it does not fit a short window', () => {
    expect(defaultView('habit', 'long')).toBe('consistency')
    expect(availableViews('habit', 'long')).toEqual(['consistency', 'week'])
    expect(availableViews('habit', 'short')).toEqual(['week']) // consistency (month-scoped) drops
    expect(defaultView('habit', 'short')).toBe('week') // signature doesn't fit -> largest that does
  })

  it('checklist: no switcher — the existing steps card covers it', () => {
    expect(availableViews('checklist', 'long')).toEqual([])
    expect(defaultView('checklist', 'long')).toBeNull()
  })

  it('open-ended keeps Year/Week/By-person for total goals', () => {
    expect(availableViews('total', 'open-ended')).toEqual(['week', 'month', 'year', 'pace', 'yearRing', 'byPerson'])
  })
})

describe('computeGoalStats', () => {
  const days: DayEntry[] = [
    { dateKey: '2026-07-10', total: 8.3, perMember: { wally: 4, kevin: 4.3 } },
    { dateKey: '2026-07-11', total: 5.9, perMember: { wally: 5.9 } },
    { dateKey: '2026-07-15', total: 1.5, perMember: { wally: 1.5 } },
    { dateKey: '2026-07-16', total: 3.9, perMember: { kelly: 2, wally: 1.9 } },
    { dateKey: '2026-07-17', total: 2.5, perMember: { wally: 2.5 } },
  ]

  it('sums total and tracks bestDay', () => {
    const s = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })
    expect(s.total).toBeCloseTo(8.3 + 5.9 + 1.5 + 3.9 + 2.5, 5)
    expect(s.bestDay).toEqual({ dateKey: '2026-07-10', total: 8.3 })
  })

  it('dayEntry zero-fills a day with no log, quietly (never undefined)', () => {
    const s = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })
    expect(s.byDay.get('2026-07-12')).toBeUndefined() // sparse map itself
    expect(s.dayEntry('2026-07-12')).toEqual({ dateKey: '2026-07-12', total: 0, perMember: {} })
    expect(s.dayEntry('2026-07-10').total).toBe(8.3)
  })

  it('currentStreak counts consecutive active days ending today (breaks on a gap)', () => {
    // 15,16,17 are consecutive; the 12-14 gap breaks anything earlier.
    const s = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })
    expect(s.currentStreak).toBe(3)
  })

  it('currentStreak is 0 when the last log was more than a day ago', () => {
    const stale: DayEntry[] = [{ dateKey: '2026-07-10', total: 3, perMember: {} }]
    const s = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days: stale })
    expect(s.currentStreak).toBe(0)
  })

  it('longestStreak finds the longest run anywhere in the log', () => {
    const s = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })
    expect(s.longestStreak).toBe(3) // Jul 15-16-17; the Jul 10-11 run is only 2
  })

  it('weekMax is the max day total among the last 7 days ending today', () => {
    const s = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })
    // last 7 days: Jul 11..17 -> includes 5.9 (11), 1.5 (15), 3.9 (16), 2.5 (17); Jul 10 excluded
    expect(s.weekMax).toBe(5.9)
  })

  it('pace: null for an open-ended goal (no deadline)', () => {
    const s = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })
    expect(s.pace).toBeNull()
  })

  it('pace: computed from the goal\'s own window, never a hard-coded 365', () => {
    // a 10-day goal, 5 days elapsed, target 100 -> pace 50
    const shortDays: DayEntry[] = [{ dateKey: '2026-07-03', total: 60, perMember: {} }]
    const s = computeGoalStats({ today: '2026-07-06', startDate: '2026-07-01', endDate: '2026-07-11', target: 100, days: shortDays })
    expect(s.pace).not.toBeNull()
    expect(s.pace!.paceValue).toBe(50) // 100 * 5/10
    expect(s.pace!.delta).toBe(10) // 60 - 50
  })

  it('pace: elapsed clamps at totalDuration once the goal is past its end date', () => {
    const s = computeGoalStats({ today: '2026-08-01', startDate: '2026-07-01', endDate: '2026-07-11', target: 100, days: [] })
    expect(s.pace!.paceValue).toBe(100) // fully elapsed, not overshooting past target
  })

  it('byMonthPerMember buckets each day\'s perMember into its calendar month', () => {
    const s = computeGoalStats({ today: '2026-07-17', startDate: '2026-01-01', endDate: null, target: 1000, days })
    expect(s.byMonthPerMember[6]).toEqual({ wally: 4 + 5.9 + 1.5 + 1.9 + 2.5, kevin: 4.3, kelly: 2 }) // July (index 6)
    expect(s.byMonthPerMember[0]).toEqual({}) // January had no logs
  })
})
