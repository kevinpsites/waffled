// Unit tests for the wake-light schedule's computed state — pure function, no
// DB, `now` injected explicitly rather than relying on the real clock, since
// the whole point is asserting exact behavior at midnight-crossing instants
// (8pm, 11:59pm, 12:01am, 6:05am) that a real-time test can't reliably hit.
import { describe, it, expect } from 'vitest'
import { wakeLightView, type WaffledBiteSchedule } from '../src/modules/waffledBites/waffledBites'

const TZ = 'America/Chicago' // UTC-6 (CST, no DST in play for these fixed winter dates)

// Mon 2026-01-05 ... Sun 2026-01-11 — a real week, chosen so day-of-week
// arithmetic is checked against real calendar dates, not just offsets.
function chicago(y: number, m: number, d: number, hh: number, mm: number): Date {
  // These fixture dates are outside DST, so a fixed UTC-6 offset is exact.
  return new Date(Date.UTC(y, m - 1, d, hh + 6, mm))
}

describe('wakeLightView', () => {
  const schoolNights: WaffledBiteSchedule = {
    days: [1, 2, 3, 4, 5], // Mon-Fri — the WAKE morning, per the "🟢 Okay to get up" label
    wakeMin: 6 * 60 + 36, // 6:36 AM
    leadMin: 30, // yellow starts 6:06 AM
    bedtimeMin: 20 * 60, // 8:00 PM the night before
  }

  it('is none well before bedtime and well after the wake grace window', () => {
    expect(wakeLightView([schoolNights], chicago(2026, 1, 6, 15, 0), TZ)).toMatchObject({ state: 'none' }) // Tue 3pm
    expect(wakeLightView([schoolNights], chicago(2026, 1, 6, 9, 0), TZ)).toMatchObject({ state: 'none' }) // Tue 9am, long after wake+grace
  })

  it('is sleep from bedtime, through midnight, to just before the yellow warning', () => {
    expect(wakeLightView([schoolNights], chicago(2026, 1, 5, 20, 0), TZ)).toMatchObject({ state: 'sleep' }) // Mon 8:00pm exactly (bedtime instant)
    expect(wakeLightView([schoolNights], chicago(2026, 1, 5, 23, 59), TZ)).toMatchObject({ state: 'sleep' }) // Mon 11:59pm
    expect(wakeLightView([schoolNights], chicago(2026, 1, 6, 0, 1), TZ)).toMatchObject({ state: 'sleep' }) // Tue 12:01am — crossed midnight
    expect(wakeLightView([schoolNights], chicago(2026, 1, 6, 6, 5), TZ)).toMatchObject({ state: 'sleep' }) // Tue 6:05am, just before 6:06 warn start
  })

  it('is warn from the lead-time boundary to the wake instant', () => {
    expect(wakeLightView([schoolNights], chicago(2026, 1, 6, 6, 6), TZ)).toMatchObject({ state: 'warn' }) // Tue 6:06am exactly
    expect(wakeLightView([schoolNights], chicago(2026, 1, 6, 6, 35), TZ)).toMatchObject({ state: 'warn' }) // Tue 6:35am, just before wake
  })

  it('is wake at the wake instant and through a grace window, then reverts to none', () => {
    const wake = wakeLightView([schoolNights], chicago(2026, 1, 6, 6, 36), TZ) // Tue 6:36am exactly
    expect(wake.state).toBe('wake')
    expect(wake).toMatchObject({ wakeAtHour: 6, wakeAtMinute: 36 })
    expect(wakeLightView([schoolNights], chicago(2026, 1, 6, 7, 30), TZ)).toMatchObject({ state: 'wake' }) // still within grace
    expect(wakeLightView([schoolNights], chicago(2026, 1, 6, 8, 0), TZ)).toMatchObject({ state: 'none' }) // grace elapsed
  })

  // ── the day-attribution question: `days` marks the WAKE morning, so a
  // Sunday-night bedtime (heading into Monday) is covered by [1,2,3,4,5],
  // but a Friday-night bedtime (heading into Saturday) is NOT.
  it('attributes bedtime to the night BEFORE the wake day, not the calendar day bedtime falls on', () => {
    expect(wakeLightView([schoolNights], chicago(2026, 1, 4, 21, 0), TZ)).toMatchObject({ state: 'sleep' }) // Sun 9pm -> Mon(1) wake day, in days
    expect(wakeLightView([schoolNights], chicago(2026, 1, 9, 21, 0), TZ)).toMatchObject({ state: 'none' }) // Fri 9pm -> Sat(6) wake day, NOT in days
  })

  it('is none when no schedule has a bedtime configured (backward-compatible with pre-existing wake-only schedules)', () => {
    const wakeOnly: WaffledBiteSchedule = { days: [1, 2, 3, 4, 5], wakeMin: 6 * 60 + 36, leadMin: 30 }
    expect(wakeLightView([wakeOnly], chicago(2026, 1, 6, 6, 36), TZ)).toMatchObject({ state: 'none' })
  })

  it('is none with no schedules at all', () => {
    expect(wakeLightView([], chicago(2026, 1, 6, 6, 36), TZ)).toMatchObject({ state: 'none' })
  })
})
