import { describe, it, expect } from 'vitest'
import { DateTime } from 'luxon'
import { wakeLightView } from '../src/modules/waffledBites/waffledBites'

describe('wakeLightView — local/UTC conversion correctness', () => {
  it('gets the wake window right across a spring-forward DST transition (America/New_York, 2027-03-14)', () => {
    const tz = 'America/New_York'
    // 2027-03-14: clocks spring forward 2:00am -> 3:00am local (2:00-2:59am never
    // happens that day) — a known trouble spot for hand-rolled local->UTC math.
    const wakeDate = { y: 2027, m: 3, d: 14 }
    const wakeWeekday = new Date(Date.UTC(wakeDate.y, wakeDate.m - 1, wakeDate.d)).getUTCDay()
    const schedule = {
      days: [wakeWeekday],
      wakeMin: 3 * 60, // 3:00 AM — the first valid local minute after the gap
      leadMin: 0, // keep the warn window out of the invalid 2:00-2:59am gap
      bedtimeMin: 22 * 60, // 10:00 PM the night before
    }
    // The real-world instant for "3:01 AM local" on the transition day, computed
    // independently via luxon (which correctly resolves DST) rather than via the
    // function under test.
    const now = DateTime.fromObject({ year: wakeDate.y, month: wakeDate.m, day: wakeDate.d, hour: 3, minute: 1 }, { zone: tz }).toJSDate()

    expect(wakeLightView([schedule], now, tz).state).toBe('wake')
  })
})

describe('wakeLightView — overlapping schedules', () => {
  it('prefers the more specific (fewer days-of-week) schedule when two genuinely overlap, regardless of array order', () => {
    const tz = 'America/Chicago'
    // A standing every-day rule (bed 9:00 PM, wake 7:00 AM) and a one-off
    // override for tomorrow morning (bed 10:00 PM, wake 9:00 AM — a
    // sleep-in day) both cover 11:00 PM tonight: standing's sleep window is
    // [9:00 PM, 6:50 AM), override's is [10:00 PM, 8:50 AM) — genuinely
    // overlapping, not just sequential. The override (1 day) should win
    // over the standing rule (7 days) no matter which is listed first.
    const tonight = DateTime.now().setZone(tz).set({ hour: 23, minute: 0, second: 0, millisecond: 0 })
    const wakeMorning = tonight.plus({ days: 1 })
    const wakeDow = wakeMorning.weekday % 7 // luxon: 1=Mon..7=Sun -> 0=Sun..6=Sat, matches Date#getDay
    const standing = { days: [0, 1, 2, 3, 4, 5, 6], wakeMin: 7 * 60, leadMin: 10, bedtimeMin: 21 * 60 }
    const override = { days: [wakeDow], wakeMin: 9 * 60, leadMin: 10, bedtimeMin: 22 * 60 }
    const now = tonight.toJSDate()

    const resultOverrideFirst = wakeLightView([override, standing], now, tz)
    const resultStandingFirst = wakeLightView([standing, override], now, tz)
    expect(resultOverrideFirst).toEqual({ state: 'sleep', wakeAtHour: 9, wakeAtMinute: 0 })
    expect(resultStandingFirst).toEqual({ state: 'sleep', wakeAtHour: 9, wakeAtMinute: 0 })
  })
})
