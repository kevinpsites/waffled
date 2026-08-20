import {
  formatInterval, cadenceLabel, dueLabel, periodLabel, splitCadence, intervalDays,
  nudgePlan, nudgeExplainer,
} from './rhythms'

// Postgres hands `interval::text` back in its own shorthand — `3 mons`, `1 mon`,
// `3 days 12:00:00` — which is exactly the string a careless card would print at a
// user ("every 3 mons"). These helpers are the one place that shorthand is turned
// into English, so they're pinned here rather than exercised through a render.
describe('formatInterval', () => {
  it('spells out Postgres month shorthand', () => {
    expect(formatInterval('3 mons')).toBe('3 months')
    expect(formatInterval('1 mon')).toBe('1 month')
  })

  it('collapses whole weeks', () => {
    expect(formatInterval('7 days')).toBe('1 week')
    expect(formatInterval('14 days')).toBe('2 weeks')
    expect(formatInterval('10 days')).toBe('10 days')
    expect(formatInterval('1 day')).toBe('1 day')
  })

  it('keeps the clock tail the lead-time clamp produces', () => {
    // `least(lead_time, every/2)` on a weekly rhythm yields exactly this.
    expect(formatInterval('3 days 12:00:00')).toBe('3 days 12 hours')
    expect(formatInterval('12:00:00')).toBe('12 hours')
  })

  it('handles mixed and empty values', () => {
    expect(formatInterval('1 mon 15 days')).toBe('1 month 15 days')
    expect(formatInterval('1 year')).toBe('1 year')
    expect(formatInterval('')).toBe('')
  })
})

describe('cadenceLabel', () => {
  it('drops the "1" so a single unit reads naturally', () => {
    expect(cadenceLabel('7 days')).toBe('every week')
    expect(cadenceLabel('1 mon')).toBe('every month')
  })

  it('keeps the count when there is more than one', () => {
    expect(cadenceLabel('3 mons')).toBe('every 3 months')
    expect(cadenceLabel('14 days')).toBe('every 2 weeks')
  })
})

describe('dueLabel', () => {
  const today = new Date('2026-08-18T09:00:00Z')

  it('names an overdue item as overdue, never as a missed streak', () => {
    expect(dueLabel('2026-08-11T09:00:00Z', true, today)).toBe('7 days overdue')
    expect(dueLabel('2026-08-17T09:00:00Z', true, today)).toBe('1 day overdue')
  })

  it('counts down to a due date that has not arrived', () => {
    expect(dueLabel('2026-08-18T09:00:00Z', false, today)).toBe('due today')
    expect(dueLabel('2026-08-19T09:00:00Z', false, today)).toBe('due tomorrow')
    expect(dueLabel('2026-08-25T09:00:00Z', false, today)).toBe('due in 7 days')
  })

  // "Today" is the day on the viewer's wall clock. Counting UTC days instead reads
  // correct all afternoon and then goes wrong every evening west of UTC (and every
  // small hour east of it), which is exactly when a kitchen kiosk is being looked at.
  it('counts calendar days on the local clock, not in UTC', () => {
    const lateEvening = new Date(2026, 7, 18, 23, 0, 0)
    expect(dueLabel(new Date(2026, 7, 19, 9, 0, 0).toISOString(), false, lateEvening)).toBe('due tomorrow')
    const smallHours = new Date(2026, 7, 19, 0, 30, 0)
    expect(dueLabel(new Date(2026, 7, 19, 9, 0, 0).toISOString(), false, smallHours)).toBe('due today')
  })
})

describe('periodLabel', () => {
  // The scheduling shape asks "did this get on the calendar?", so the label is
  // about the window closing — never about following through.
  it('says how long is left to get it booked', () => {
    const today = new Date('2026-08-18T09:00:00Z')
    expect(periodLabel('2026-08-25', today)).toBe('7 days left to book it')
    expect(periodLabel('2026-08-19', today)).toBe('1 day left to book it')
    expect(periodLabel('2026-08-18', today)).toBe('this period ends today')
    expect(periodLabel('2026-08-17', today)).toBe('this period has ended')
  })

  it('reads the period boundary as a calendar date on the local clock', () => {
    // periodEnd is a date, not an instant — it must not drift by a day at either
    // end of the evening.
    expect(periodLabel('2026-08-19', new Date(2026, 7, 18, 23, 0, 0))).toBe('1 day left to book it')
    expect(periodLabel('2026-08-19', new Date(2026, 7, 19, 0, 30, 0))).toBe('this period ends today')
  })
})

// Editing a rhythm means putting its stored cadence back INTO a number + unit
// picker, so the Postgres shorthand has to survive the round trip.
describe('splitCadence', () => {
  it('reads Postgres shorthand back into picker state', () => {
    expect(splitCadence('3 mons')).toEqual({ count: 3, unit: 'months' })
    expect(splitCadence('1 mon')).toEqual({ count: 1, unit: 'months' })
    expect(splitCadence('7 days')).toEqual({ count: 1, unit: 'weeks' })
    expect(splitCadence('10 days')).toEqual({ count: 10, unit: 'days' })
    expect(splitCadence('1 year')).toEqual({ count: 1, unit: 'years' })
  })

  it('falls back to a week rather than to zero on something it cannot read', () => {
    expect(splitCadence('')).toEqual({ count: 1, unit: 'weeks' })
  })
})

describe('intervalDays', () => {
  it('turns a runway into whole days for the form', () => {
    expect(intervalDays('14 days')).toBe(14)
    // The clamp's half-week runway truncates. Rounding it up to 4 put the field above
    // the cap the same helper computes (floor(7/2) = 3), so opening an untouched weekly
    // rhythm showed "4" over a sentence reading "you'll be nudged for the last 3 days …
    // (4 days won't fit in a week)" — a trim warning about a number the user never typed.
    expect(intervalDays('3 days 12:00:00')).toBe(3)
    // A minute tail can't push it over either; iOS drops minutes entirely and both land
    // on the same whole day.
    expect(intervalDays('3 days 12:30:00')).toBe(3)
    expect(intervalDays('')).toBe(0)
  })
})

// "Start nudging me this many days before the period ends" was reported, fairly, as
// meaningless: "what period? I am scheduling it to happen every week?" A scheduling
// rhythm's period IS one cadence and the runway is the tail of it, but the label named
// neither. Worse, the server clamps the runway to half the cadence — so a weekly rhythm
// asking for 14 days silently gets 3, and "I set 1 day and saw nothing on Today" looks
// like a bug when it is the feature working exactly as designed.
describe('nudgePlan', () => {
  it('reports the runway you asked for when the cadence has room', () => {
    expect(nudgePlan('3 mons', 14)).toEqual({ effectiveDays: 14, capped: false })
  })

  it('reports the clamped runway, not the one that was typed', () => {
    // Half of 7 days is 3.5, and the field is whole days.
    expect(nudgePlan('7 days', 14)).toEqual({ effectiveDays: 3, capped: true })
  })

  it('treats a runway of exactly half the cadence as uncapped', () => {
    expect(nudgePlan('14 days', 7)).toEqual({ effectiveDays: 7, capped: false })
  })

  it('survives a cadence it cannot read', () => {
    expect(nudgePlan('', 14).effectiveDays).toBeGreaterThanOrEqual(0)
  })
})

describe('nudgeExplainer', () => {
  it('names the window instead of saying "the period"', () => {
    const text = nudgeExplainer('7 days', 1)
    expect(text).toMatch(/every week/i)
    expect(text).not.toMatch(/the period ends/i)
  })

  it('states what the clamp actually did, in days', () => {
    expect(nudgeExplainer('7 days', 14)).toMatch(/last 3 days/i)
  })

  it('says a zero runway nudges only on the final day', () => {
    expect(nudgeExplainer('7 days', 0)).toMatch(/last day/i)
  })

  it('makes clear a booked window goes quiet', () => {
    expect(nudgeExplainer('3 mons', 14)).toMatch(/nothing/i)
  })
})
