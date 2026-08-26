import {
  formatInterval, cadenceLabel, dueLabel, periodLabel, splitCadence, intervalDays,
  nudgePlan, nudgeExplainer, urgencyOf, countdown, periodProgress, daysToGo,
  addCadence, consequence,
  type AttentionItem, type RhythmWithPeriod,
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
    expect(dueLabel('2026-08-11T09:00:00Z', true, today)).toBe('7 days late')
    expect(dueLabel('2026-08-17T09:00:00Z', true, today)).toBe('1 day late')
  })

  it('counts down to a due date that has not arrived', () => {
    expect(dueLabel('2026-08-18T09:00:00Z', false, today)).toBe('due today')
    expect(dueLabel('2026-08-19T09:00:00Z', false, today)).toBe('due tomorrow')
    expect(dueLabel('2026-08-25T09:00:00Z', false, today)).toBe('in 7 days')
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

// ── The register, grouped by when rather than by kind ───────────────────────────
//
// The screen used to be two sections named after the two shapes — "It gets scheduled"
// and "You do it" — which sorted a household's rhythms by a distinction only the schema
// cares about. Asked "what do I owe this week", you had to read both. These three
// helpers are the replacement: one axis, urgency, with the shape carried by the words
// in the row instead of by which section it landed in.
//
// Pure functions with an injectable clock, so the boundaries can be pinned exactly —
// "is a rhythm due in 14 days Coming up or Steady" is not a question to answer by
// squinting at a rendered page at whatever time the suite happens to run.

// Both clocks are built from local components on purpose. An ISO literal ending in Z
// lands on a different calendar day either side of UTC, so `'2026-08-25T09:00:00Z'`
// against a locally-built "now" would assert one thing in Denver and another in
// Auckland — a suite that passes where it was written and nowhere else.
const at = (month: number, day: number) => new Date(2026, month - 1, day).toISOString()
const NOW = new Date(2026, 7, 20)

function rhythm(over: Partial<RhythmWithPeriod> = {}): RhythmWithPeriod {
  return {
    id: 'r1', title: 'Air filter', emoji: '🌬', notes: null, personId: null,
    satisfiedBy: 'completion', every: '3 mons', startsOn: null, autoSchedule: false,
    rrule: null, leadTime: '14 days', lastCompletedAt: null, nextDueAt: null,
    isActive: true, currentPeriodStart: null, currentPeriodEnd: null, satisfied: true,
    bookedAt: null, bookedAllDay: null,
    ...over,
  }
}

const due = (dueAt: string, overdue = false): AttentionItem =>
  ({ kind: 'due', rhythm: rhythm(), dueAt, overdue })

describe('urgencyOf', () => {
  it('puts anything the server is already nudging about in "Needs you now"', () => {
    // Deliberately the SAME signal the Today card reads, not a second threshold of our
    // own. Two opinions about "does this need me" would let the register and Today
    // disagree about one rhythm on one screen, which reads as a bug and is one.
    const r = rhythm({ nextDueAt: at(8, 25) })
    expect(urgencyOf(r, due(at(8, 25)), NOW)).toBe('now')
  })

  it('keeps an overdue rhythm in "Needs you now" rather than inventing a fourth group', () => {
    const r = rhythm({ nextDueAt: at(8, 12), satisfied: false })
    expect(urgencyOf(r, due(at(8, 12), true), NOW)).toBe('now')
  })

  it('shows the next fortnight as "Coming up", even though nothing is nudging yet', () => {
    // The runway governs NUDGING — when a rhythm is allowed to interrupt you. This band
    // is a different job: a peek ahead on a page you deliberately opened, where the
    // question is "what is on the horizon", not "what should shout". A fixed fortnight
    // is the honest answer to that and needs no per-rhythm arithmetic to explain.
    const r = rhythm({ nextDueAt: at(8, 30) })
    expect(urgencyOf(r, undefined, NOW)).toBe('soon')
  })

  it('draws the fortnight boundary inclusively, and the day after it is Steady', () => {
    expect(urgencyOf(rhythm({ nextDueAt: at(9, 3) }), undefined, NOW)).toBe('soon')
    expect(urgencyOf(rhythm({ nextDueAt: at(9, 4) }), undefined, NOW)).toBe('steady')
  })

  it('calls a booked period Steady — booking it WAS the thing to do', () => {
    const r = rhythm({
      satisfiedBy: 'scheduling', satisfied: true,
      currentPeriodStart: '2026-08-17', currentPeriodEnd: '2026-08-23',
    })
    expect(urgencyOf(r, undefined, NOW)).toBe('steady')
  })

  it('measures an unbooked period from its closing date, not from a due date it has none of', () => {
    const r = rhythm({
      satisfiedBy: 'scheduling', satisfied: false,
      currentPeriodStart: '2026-08-24', currentPeriodEnd: '2026-08-30',
    })
    expect(urgencyOf(r, undefined, NOW)).toBe('soon')
  })

  it('takes paused out of the urgency ordering entirely', () => {
    // A paused rhythm is off. Sorting it by how overdue it is would be sorting by a
    // consequence we have deliberately suspended.
    const r = rhythm({ isActive: false, nextDueAt: at(8, 1), satisfied: false })
    expect(urgencyOf(r, due(at(8, 1), true), NOW)).toBe('paused')
  })

  it('parks a rhythm with no due date in Steady instead of throwing', () => {
    expect(urgencyOf(rhythm({ nextDueAt: null }), undefined, NOW)).toBe('steady')
  })
})

describe('countdown', () => {
  it('counts overdue days up, so the worst row reads loudest', () => {
    const r = rhythm({ nextDueAt: at(8, 14), satisfied: false })
    expect(countdown(r, 'now', NOW)).toEqual({ num: '6', unit: 'days late', tone: 'late' })
  })

  it('speaks days near, weeks next, months far — a "213 days" countdown anchors nothing', () => {
    expect(countdown(rhythm({ nextDueAt: at(8, 25) }), 'soon', NOW)?.num).toBe('5')
    expect(countdown(rhythm({ nextDueAt: at(8, 25) }), 'soon', NOW)?.unit).toBe('days')
    expect(countdown(rhythm({ nextDueAt: at(9, 10) }), 'steady', NOW)?.unit).toBe('weeks')
    expect(countdown(rhythm({ nextDueAt: at(10, 20) }), 'steady', NOW)?.unit).toBe('months')
  })

  it('says today rather than "0 days"', () => {
    expect(countdown(rhythm({ nextDueAt: at(8, 20) }), 'now', NOW)?.num).toBe('Today')
  })

  it('tells a booking rhythm how long the window stays open, never whether it happened', () => {
    const r = rhythm({
      satisfiedBy: 'scheduling', satisfied: false,
      currentPeriodStart: '2026-08-17', currentPeriodEnd: '2026-08-23',
    })
    expect(countdown(r, 'now', NOW)).toEqual({ num: '3', unit: 'days left', tone: 'late' })
  })

  it('reports a booked period as settled, in green, with no number to chase', () => {
    const r = rhythm({
      satisfiedBy: 'scheduling', satisfied: true,
      currentPeriodStart: '2026-08-17', currentPeriodEnd: '2026-08-23',
    })
    expect(countdown(r, 'steady', NOW)?.tone).toBe('done')
  })

  it('takes its colour from the group, so one row never argues with its own heading', () => {
    const r = rhythm({ nextDueAt: at(8, 25) })
    expect(countdown(r, 'now', NOW)?.tone).toBe('late')
    expect(countdown(r, 'soon', NOW)?.tone).toBe('near')
    expect(countdown(r, 'steady', NOW)?.tone).toBe('soft')
  })

  it('shows nothing at all rather than a number for a rhythm with no due date', () => {
    expect(countdown(rhythm({ nextDueAt: null }), 'steady', NOW)).toBeNull()
  })
})

describe('daysToGo', () => {
  it('orders a group soonest-first, counting overdue as further past due', () => {
    // The page subtitle promises "soonest first", so the sort has to be real. Within
    // "Needs you now" that means the most overdue row leads — otherwise a quarterly
    // rhythm with a 45-day runway, which is legitimately nudging, outranks something
    // that is a week late purely because it was fetched first.
    const rows = [
      rhythm({ id: 'soon', nextDueAt: at(8, 25) }),
      rhythm({ id: 'late', nextDueAt: at(8, 14) }),
      rhythm({ id: 'never', nextDueAt: null }),
    ]
    const order = [...rows]
      .sort((a, b) => (daysToGo(a, NOW) ?? Infinity) - (daysToGo(b, NOW) ?? Infinity))
      .map((r) => r.id)
    expect(order).toEqual(['late', 'soon', 'never'])
  })

  it('counts a booking rhythm toward its window closing, not toward a due date', () => {
    const r = rhythm({
      satisfiedBy: 'scheduling', currentPeriodStart: '2026-08-17', currentPeriodEnd: '2026-08-23',
    })
    expect(daysToGo(r, NOW)).toBe(3)
  })
})

describe('periodProgress', () => {
  it('measures a completion rhythm from when it was last actually done', () => {
    // Not from the period grid — the completion shape deliberately has none. Its clock
    // restarts whenever you did it, which is the whole reason being late doesn't stack.
    const r = rhythm({
      every: '10 days', lastCompletedAt: at(8, 15), nextDueAt: at(8, 25),
    })
    expect(periodProgress(r, NOW)).toBe(50)
  })

  it('falls back to one cadence back when nothing has ever been logged', () => {
    const r = rhythm({ every: '10 days', lastCompletedAt: null, nextDueAt: at(8, 25) })
    expect(periodProgress(r, NOW)).toBe(50)
  })

  it('stops the bar at full instead of overflowing its track when overdue', () => {
    // A 3px hairline hides a 340% width until the day it doesn't. Clamped here rather
    // than trusted to overflow:hidden, so the number is right wherever it's read.
    const r = rhythm({
      every: '10 days', lastCompletedAt: at(7, 1), nextDueAt: at(7, 11),
    })
    expect(periodProgress(r, NOW)).toBe(100)
  })

  it('uses the real period bounds for a booking rhythm', () => {
    const r = rhythm({
      satisfiedBy: 'scheduling', currentPeriodStart: '2026-08-18', currentPeriodEnd: '2026-08-22',
    })
    expect(periodProgress(r, NOW)).toBe(50)
  })

  it('declines to draw a bar it cannot measure', () => {
    // A backdated completion later than the next due date inverts the window; so does a
    // missing due date. Both would render NaN% — an invisible bar, or a full one.
    expect(periodProgress(rhythm({ nextDueAt: null }), NOW)).toBeNull()
    expect(periodProgress(rhythm({
      lastCompletedAt: at(9, 1), nextDueAt: at(8, 25),
    }), NOW)).toBeNull()
  })
})


// -- The consequence card ----------------------------------------------------
// The create form no longer asks for a due date up front; it says the cadence as a
// sentence and then states, in plain language, what that sentence will actually do.
// Those two dates are the whole promise, so the arithmetic behind them is pinned
// here rather than read off a rendered card.

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

describe('addCadence', () => {
  it('adds calendar months, not thirty-day blocks', () => {
    // The card says "next one lands around Nov 19" for a 3-month cadence set on
    // Aug 19. Adding 90 days would say Nov 17 and be wrong every other quarter.
    expect(ymd(addCadence(new Date(2026, 7, 19), '3 months'))).toBe('2026-11-19')
    expect(ymd(addCadence(new Date(2026, 7, 19), '1 mon'))).toBe('2026-09-19')
  })

  it('clamps a month-end date onto a shorter month', () => {
    // Jan 31 + 1 month has no honest answer; Feb 28 is the one that does not skip
    // a month entirely, which is what a naive setMonth does (it lands in March).
    expect(ymd(addCadence(new Date(2026, 0, 31), '1 mon'))).toBe('2026-02-28')
    expect(ymd(addCadence(new Date(2026, 0, 31), '1 month'))).toBe('2026-02-28')
  })

  it('handles days, weeks and years', () => {
    expect(ymd(addCadence(new Date(2026, 7, 19), '10 days'))).toBe('2026-08-29')
    expect(ymd(addCadence(new Date(2026, 7, 19), '2 weeks'))).toBe('2026-09-02')
    expect(ymd(addCadence(new Date(2026, 7, 19), '1 year'))).toBe('2027-08-19')
  })
})

describe('consequence', () => {
  const AUG19 = new Date(2026, 7, 19)

  it('tells a completion rhythm when it lands and when it starts asking', () => {
    // The design's own example: every 3 months, 14 days' notice, set up today.
    const c = consequence({ satisfiedBy: 'completion', every: '3 months', leadDays: 14, anchor: '2026-11-19' })
    expect(ymd(c!.landsOn)).toBe('2026-11-19')
    expect(ymd(c!.nudgeFrom)).toBe('2026-11-05')
    expect(c!.capped).toBe(false)
  })

  it('closes a booking rhythm at the end of its first period', () => {
    // "If nothing's on the calendar by Sep 12, it moves to Needs you now" -- a
    // monthly window opened Aug 19 closes Sep 19, and the 7-day runway starts Sep 12.
    const c = consequence({ satisfiedBy: 'scheduling', every: '1 month', leadDays: 7, anchor: '2026-08-19' })
    expect(ymd(c!.landsOn)).toBe('2026-09-19')
    expect(ymd(c!.nudgeFrom)).toBe('2026-09-12')
  })

  it('promises the same day the server actually starts nudging on', () => {
    // Deliberately the exact case the API pins in rhythms.integration.test.ts
    // ("surfaces as unscheduled inside the booking runway"): a period of
    // 2026-07-01..2026-10-01 with a 14-day runway surfaces from 09-17. The server
    // gate is `(period_start + every) - lead_time <= today`, and lead_time is
    // clamped at INSERT, so this card and that query have to agree on a date or the
    // form is promising a nudge the server will not send. Paired on purpose: if
    // either side moves, one of the two tests goes red.
    const c = consequence({ satisfiedBy: 'scheduling', every: '3 months', leadDays: 14, anchor: '2026-07-01' })
    expect(ymd(c!.landsOn)).toBe('2026-10-01')
    expect(ymd(c!.nudgeFrom)).toBe('2026-09-17')
  })

  it('quotes the runway the SERVER will keep, not the one that was typed', () => {
    // `least(lead_time, every/2)`: a weekly rhythm asked for 14 days' notice is
    // stored with 3. A card promising a nudge from 14 days out would be promising
    // a date the server will never nudge on -- the same bug the register already
    // had once, in a new place.
    const c = consequence({ satisfiedBy: 'completion', every: '7 days', leadDays: 14, anchor: '2026-08-26' })
    expect(c!.capped).toBe(true)
    expect(ymd(c!.nudgeFrom)).toBe('2026-08-23')
    expect(ymd(c!.landsOn)).toBe('2026-08-26')
  })

  it('starts nudging on the day itself when there is no runway', () => {
    const c = consequence({ satisfiedBy: 'completion', every: '3 months', leadDays: 0, anchor: '2026-11-19' })
    expect(ymd(c!.nudgeFrom)).toBe('2026-11-19')
    expect(c!.capped).toBe(false)
  })

  it('declines to promise anything from an unreadable anchor', () => {
    expect(consequence({ satisfiedBy: 'completion', every: '3 months', leadDays: 14, anchor: '' })).toBeNull()
  })

  it('defaults a fresh completion rhythm to one full cadence out, not to today', () => {
    // Anchoring a brand-new rhythm at today makes it due the moment it is created,
    // so every new rhythm arrives already shouting from Needs you now. One cadence
    // out is what "every 3 months, starting now" actually means.
    expect(ymd(addCadence(AUG19, '3 months'))).toBe('2026-11-19')
  })
})
