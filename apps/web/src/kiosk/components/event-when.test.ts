import { allDayExclusiveEnd, allDayLastDay, dayLabel, endOf, keepSpan, minutesUntil, timeLabel, timeSlots } from './event-when'

// The event editor's When card, mirroring iOS `EventEnd`: all-day ends are EXCLUSIVE (noon the day
// after the last day, Google's shape) and a timed event keeps its length in minutes.
describe('event-when', () => {
  it('labels days and times the way the iPhone editor does', () => {
    expect(dayLabel('2026-09-14')).toBe('Sep 14, 2026')
    expect(timeLabel('17:00')).toBe('5:00 PM')
    expect(timeLabel('00:30')).toBe('12:30 AM')
    expect(timeLabel('12:15')).toBe('12:15 PM')
  })

  it('saves an all-day end as noon the day after the last day', () => {
    expect(allDayExclusiveEnd('2026-09-17')).toBe(new Date('2026-09-18T12:00').toISOString())
    expect(allDayExclusiveEnd('2026-12-31')).toBe(new Date('2027-01-01T12:00').toISOString())
  })

  it('reads a synced trip back to its last day', () => {
    const at = (s: string) => new Date(s).toISOString()
    expect(allDayLastDay(at('2026-09-15T00:00'), at('2026-09-18T00:00'))).toBe('2026-09-17')
    expect(allDayLastDay(at('2026-09-15T12:00'), at('2026-09-16T12:00'))).toBe('2026-09-15')
    expect(allDayLastDay(at('2026-09-15T12:00'), null)).toBe('2026-09-15')
  })

  it('finds a timed end from the start and length, and the length from an end', () => {
    expect(endOf('2026-09-14', '23:00', 90)).toEqual({ day: '2026-09-15', time: '00:30' })
    expect(minutesUntil('2026-09-14', '17:00', '2026-09-15', '18:00')).toBe(25 * 60)
    expect(minutesUntil('2026-09-14', '17:00', '2026-09-14', '16:00')).toBe(15)
  })

  it('moves an all-day span with its start day', () => {
    expect(keepSpan('2026-09-14', '2026-09-20', '2026-09-16')).toBe('2026-09-22')
    expect(keepSpan('2026-09-14', '2026-09-10', '2026-09-14')).toBe('2026-09-10')
  })

  it('offers times every 15 minutes', () => {
    const slots = timeSlots()
    expect(slots).toHaveLength(96)
    expect(slots[0]).toBe('00:00')
    expect(slots[69]).toBe('17:15')
  })
})
